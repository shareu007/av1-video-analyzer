import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { validateBlockOverlayDocument } from "./block-overlay.js";

export const NATIVE_INSPECTION_WORKER_PROTOCOL = "av1scope.native-inspection-worker.v2";
export const NATIVE_INSPECTION_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const NATIVE_INSPECTION_MAX_FRAMES = 250_000;
export const NATIVE_INSPECTION_MAX_BLOCKS = 1_000_000;

const REQUEST_BYTES = 56;
const FRAME_DESCRIPTOR_BYTES = 24;
const RESPONSE_HEADER_BYTES = 16;
const RESPONSE_RECORD_BYTES = 112;
const REQUEST_MAGIC = Buffer.from([0x41, 0x31, 0x49, 0x4e, 0x58, 0x30, 0x32, 0]);
const RESPONSE_MAGIC = Buffer.from([0x41, 0x31, 0x49, 0x4e, 0x4f, 0x30, 0x32, 0]);
const KNOWN_STATUSES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const KNOWN_SANDBOX_FLAGS = 31;
const BLOCK_FLAG_SKIP = 1;
const BLOCK_FLAG_QINDEX_VALID = 2;
const BLOCK_FLAGS_MASK = 3;
const BLOCK_DETAIL_MI_COORDINATES = 1;
const BLOCK_DETAIL_COMPOUND_TYPE = 2;
const BLOCK_DETAIL_QUANT_DELTA = 4;
const BLOCK_DETAILS_MASK = 7;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const NATIVE_INSPECTION_FEATURES = Object.freeze([
  Object.freeze({ flag: 1, id: "partition", label: "Partition" }),
  Object.freeze({ flag: 2, id: "mode", label: "Prediction mode" }),
  Object.freeze({ flag: 4, id: "motion-vector", label: "Motion vectors" }),
  Object.freeze({ flag: 8, id: "transform", label: "Transform" }),
  Object.freeze({ flag: 16, id: "coefficient", label: "Coefficient counts" }),
  Object.freeze({ flag: 32, id: "qindex", label: "Q index" }),
  Object.freeze({ flag: 64, id: "filter", label: "Loop filter" }),
]);
export const NATIVE_INSPECTION_FEATURES_ALL = 127;

const MODES = ["unknown", "intra", "inter", "skip"];
const PARTITIONS = [
  "unknown", "none", "split", "horz", "vert", "horz_a", "horz_b",
  "vert_a", "vert_b", "horz_4", "vert_4",
];
const MV_PRECISIONS = ["integer", "1/2 pel", "1/4 pel", "1/8 pel"];

export class NativeInspectionWorkerError extends Error {
  constructor(message, { code = "NATIVE_INSPECTION_WORKER_FAILED", status = null } = {}) {
    super(message);
    this.name = "NativeInspectionWorkerError";
    this.code = code;
    this.status = status;
  }
}

function requireInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} is outside its supported range`);
  }
  return value;
}

function safeNumber(value, maximum, name) {
  if (value > BigInt(maximum)) {
    throw new NativeInspectionWorkerError(`${name} exceeds the safe model range`, {
      code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
    });
  }
  return Number(value);
}

function signed16(buffer, offset) {
  return buffer.readInt16LE(offset);
}

function optionalCode(value, prefix) {
  return value === -1 ? null : `${prefix}_${value}`;
}

function zeroed(buffer, start) {
  return buffer.subarray(start).every((value) => value === 0);
}

export function describeNativeInspectionFeatures(featureFlags) {
  requireInteger(
    featureFlags, 0, NATIVE_INSPECTION_FEATURES_ALL, "native inspection featureFlags",
  );
  const features = NATIVE_INSPECTION_FEATURES
    .filter(({ flag }) => (featureFlags & flag) !== 0)
    .map(({ id }) => id);
  const missingFeatures = NATIVE_INSPECTION_FEATURES
    .filter(({ flag }) => (featureFlags & flag) === 0)
    .map(({ id }) => id);
  return {
    featureFlags,
    features,
    missingFeatures,
    featureComplete: missingFeatures.length === 0,
  };
}

async function fingerprintExecutable(executable) {
  const handle = await open(executable, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new TypeError("native inspection worker executable must be a regular file");
    if (!Number.isSafeInteger(stats.size) || stats.size <= 0 || stats.size > MAX_EXECUTABLE_BYTES) {
      throw new RangeError("native inspection worker executable size is outside its supported range");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return { sha256: digest.digest("hex"), size: stats.size };
  } finally {
    await handle.close();
  }
}

function normalizeFrames(input, frames, maximumFrameBytes) {
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > NATIVE_INSPECTION_MAX_FRAMES) {
    throw new RangeError(`native inspection requires 1..${NATIVE_INSPECTION_MAX_FRAMES} frames`);
  }
  return frames.map((frame, index) => {
    const range = frame?.payloadRange;
    if (frame?.frameId !== index || !range) {
      throw new TypeError("native inspection frames must have contiguous frameId and payloadRange");
    }
    const start = requireInteger(range.start, 0, input.length, `frames[${index}].payloadRange.start`);
    const length = requireInteger(
      range.length, 0, maximumFrameBytes, `frames[${index}].payloadRange.length`,
    );
    if (length > input.length - start) {
      throw new RangeError(`frames[${index}].payloadRange is outside the input`);
    }
    return { frameId: index, start, length };
  });
}

export function encodeNativeInspectionRequest(input, frames, {
  maximumBlocks = NATIVE_INSPECTION_MAX_BLOCKS,
  maximumBlocksPerChunk = 4096,
  maximumFrameBytes = NATIVE_INSPECTION_MAX_INPUT_BYTES,
} = {}) {
  if (!Buffer.isBuffer(input)) throw new TypeError("native inspection input must be a Buffer");
  if (input.length > NATIVE_INSPECTION_MAX_INPUT_BYTES) {
    throw new RangeError("native inspection input exceeds the 64 MiB worker limit");
  }
  requireInteger(maximumBlocks, 1, NATIVE_INSPECTION_MAX_BLOCKS, "maximumBlocks");
  requireInteger(maximumBlocksPerChunk, 1, 65_536, "maximumBlocksPerChunk");
  requireInteger(maximumFrameBytes, 1, 1024 * 1024 * 1024, "maximumFrameBytes");
  const normalized = normalizeFrames(input, frames, maximumFrameBytes);
  const header = Buffer.alloc(REQUEST_BYTES);
  REQUEST_MAGIC.copy(header);
  header.writeUInt32LE(2, 8);
  header.writeUInt32LE(REQUEST_BYTES, 12);
  header.writeBigUInt64LE(BigInt(input.length), 16);
  header.writeBigUInt64LE(BigInt(normalized.length), 24);
  header.writeBigUInt64LE(BigInt(maximumBlocks), 32);
  header.writeUInt32LE(maximumBlocksPerChunk, 40);
  header.writeUInt32LE(0, 44);
  header.writeBigUInt64LE(BigInt(maximumFrameBytes), 48);
  const descriptors = Buffer.alloc(normalized.length * FRAME_DESCRIPTOR_BYTES);
  for (const [index, frame] of normalized.entries()) {
    const offset = index * FRAME_DESCRIPTOR_BYTES;
    descriptors.writeBigUInt64LE(BigInt(frame.frameId), offset);
    descriptors.writeBigUInt64LE(BigInt(frame.start), offset + 8);
    descriptors.writeBigUInt64LE(BigInt(frame.length), offset + 16);
  }
  return [header, descriptors, input];
}

function decodeInfo(record) {
  const featureFlags = record.readUInt32LE(8);
  const workerSandboxFlags = record.readUInt32LE(12);
  const nameBytes = record.readUInt32LE(16);
  const buildBytes = record.readUInt32LE(20);
  if (nameBytes < 1 || nameBytes > 32 || buildBytes < 1 || buildBytes > 40
      || (featureFlags & ~NATIVE_INSPECTION_FEATURES_ALL) !== 0
      || (workerSandboxFlags & ~KNOWN_SANDBOX_FLAGS) !== 0
      || !zeroed(record.subarray(24 + nameBytes, 56), 0)
      || !zeroed(record.subarray(56 + buildBytes), 0)) {
    throw new NativeInspectionWorkerError("native inspection emitted invalid adapter metadata", {
      code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
    });
  }
  try {
    return {
      producer: utf8.decode(record.subarray(24, 24 + nameBytes)),
      build: utf8.decode(record.subarray(56, 56 + buildBytes)),
      ...describeNativeInspectionFeatures(featureFlags),
      workerSandboxFlags,
    };
  } catch (cause) {
    const error = new NativeInspectionWorkerError("native inspection metadata is not UTF-8", {
      code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
    });
    error.cause = cause;
    throw error;
  }
}

function decodeMotionVector(record, offset) {
  const row = record.readInt32LE(offset);
  const column = record.readInt32LE(offset + 4);
  const precision = record[offset + 8];
  const valid = record[offset + 9];
  const reserved = record.readUInt16LE(offset + 10);
  if (valid > 1 || reserved !== 0) {
    throw new NativeInspectionWorkerError("native inspection emitted an invalid motion vector", {
      code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
    });
  }
  return valid === 0 ? null : {
    x: column,
    y: row,
    precision: MV_PRECISIONS[precision] ?? `precision_${precision}`,
  };
}

function decodeBlock(record, expectedFrameId, expectedBlockId) {
  const structSize = record.readUInt32LE(8);
  const abiVersion = record.readUInt32LE(12);
  const frameId = safeNumber(record.readBigUInt64LE(16), NATIVE_INSPECTION_MAX_FRAMES, "frameId");
  const blockId = safeNumber(record.readBigUInt64LE(24), NATIVE_INSPECTION_MAX_BLOCKS, "blockId");
  const plane = record[48];
  const partition = record[49];
  const mode = record[50];
  const segmentId = record[51];
  const flags = record[52];
  const reference0 = record[53];
  const reference1 = record[54];
  const qindex = record[55];
  const detailFlags = record.readUInt32LE(96);
  const miRow = record.readUInt32LE(100);
  const miColumn = record.readUInt32LE(104);
  const compoundType = signed16(record, 108);
  const quantDelta = signed16(record, 110);
  if (structSize !== 104 || abiVersion !== 2 || frameId !== expectedFrameId
      || blockId !== expectedBlockId || plane > 2 || partition >= PARTITIONS.length
      || mode >= MODES.length || (segmentId !== 255 && segmentId > 7)
      || (flags & ~BLOCK_FLAGS_MASK) !== 0
      || (reference0 !== 255 && reference0 > 7)
      || (reference1 !== 255 && reference1 > 7)
      || (detailFlags & ~BLOCK_DETAILS_MASK) !== 0
      || ((detailFlags & BLOCK_DETAIL_MI_COORDINATES) === 0 && (miRow !== 0 || miColumn !== 0))
      || ((detailFlags & BLOCK_DETAIL_COMPOUND_TYPE) === 0 && compoundType !== 0)
      || ((detailFlags & BLOCK_DETAIL_COMPOUND_TYPE) !== 0 && compoundType < 0)
      || ((detailFlags & BLOCK_DETAIL_QUANT_DELTA) === 0 && quantDelta !== 0)) {
    throw new NativeInspectionWorkerError("native inspection emitted an invalid BlockRecord", {
      code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
    });
  }
  const coeffNonZero = record.readInt32LE(64);
  const filterSummary = record.readInt32LE(68);
  if (coeffNonZero < -1) {
    throw new NativeInspectionWorkerError("native inspection emitted an invalid coefficient count", {
      code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
    });
  }
  const vectors = [decodeMotionVector(record, 72), decodeMotionVector(record, 84)].filter(Boolean);
  return {
    blockId,
    plane,
    x: record.readUInt32LE(32),
    y: record.readUInt32LE(36),
    width: record.readUInt32LE(40),
    height: record.readUInt32LE(44),
    partition: PARTITIONS[partition],
    segmentId: segmentId === 255 ? null : segmentId,
    skip: (flags & BLOCK_FLAG_SKIP) !== 0,
    mode: MODES[mode],
    intraMode: optionalCode(signed16(record, 56), "INTRA"),
    interMode: optionalCode(signed16(record, 58), "INTER"),
    refs: [reference0, reference1].filter((value) => value !== 255),
    qindex: (flags & BLOCK_FLAG_QINDEX_VALID) !== 0 ? qindex : null,
    mv: vectors,
    txSize: optionalCode(signed16(record, 60), "TX_SIZE"),
    txType: optionalCode(signed16(record, 62), "TX_TYPE"),
    coeffNonZero: coeffNonZero === -1 ? null : coeffNonZero,
    filter: filterSummary === -1 ? null : `FILTER_${filterSummary}`,
    miRow: (detailFlags & BLOCK_DETAIL_MI_COORDINATES) !== 0 ? miRow : null,
    miColumn: (detailFlags & BLOCK_DETAIL_MI_COORDINATES) !== 0 ? miColumn : null,
    compoundType: (detailFlags & BLOCK_DETAIL_COMPOUND_TYPE) !== 0
      ? `COMPOUND_${compoundType}` : null,
    quantDelta: (detailFlags & BLOCK_DETAIL_QUANT_DELTA) !== 0 ? quantDelta : null,
  };
}

export function createNativeInspectionResponseDecoder({
  frameCount,
  maximumBlocks = NATIVE_INSPECTION_MAX_BLOCKS,
} = {}) {
  requireInteger(frameCount, 1, NATIVE_INSPECTION_MAX_FRAMES, "frameCount");
  requireInteger(maximumBlocks, 1, NATIVE_INSPECTION_MAX_BLOCKS, "maximumBlocks");
  const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
  const record = Buffer.alloc(RESPONSE_RECORD_BYTES);
  let headerBytes = 0;
  let recordBytes = 0;
  let recordCount = 0;
  let info = null;
  let currentFrameId = 0;
  let blocks = [];
  let totalBlocks = 0;
  let ended = false;
  let terminalError = null;
  let finished = false;
  const frames = [];

  const protocolError = (message) => new NativeInspectionWorkerError(message, {
    code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
  });
  const consume = () => {
    recordCount += 1;
    if (recordCount > maximumBlocks + frameCount + 2) throw protocolError("native inspection record budget exceeded");
    const kind = record.readUInt32LE(0);
    const status = record.readUInt32LE(4);
    if (!KNOWN_STATUSES.has(status)) throw protocolError("native inspection returned an unknown status");
    if (kind === 5) {
      if (ended || terminalError !== null || status === 0 || status === 1) {
        throw protocolError("invalid native inspection error record");
      }
      terminalError = new NativeInspectionWorkerError("native inspection worker rejected the input", { status });
      return;
    }
    if (terminalError !== null || ended) throw protocolError("native inspection emitted data after termination");
    if (kind === 1) {
      if (status !== 0 || info !== null || recordCount !== 1) throw protocolError("invalid native inspection info record");
      info = decodeInfo(record);
      return;
    }
    if (info === null) throw protocolError("native inspection omitted adapter metadata");
    if (kind === 2) {
      if (status !== 0 || currentFrameId >= frameCount || totalBlocks >= maximumBlocks) {
        throw protocolError("invalid native inspection block ordering");
      }
      blocks.push(decodeBlock(record, currentFrameId, blocks.length));
      totalBlocks += 1;
      return;
    }
    const first = safeNumber(record.readBigUInt64LE(8), Number.MAX_SAFE_INTEGER, "terminal value");
    const second = safeNumber(record.readBigUInt64LE(16), Number.MAX_SAFE_INTEGER, "terminal count");
    if (!zeroed(record, 24)) throw protocolError("native inspection terminal record has reserved data");
    if (kind === 3) {
      if (status !== 0 || currentFrameId >= frameCount || first !== currentFrameId || second !== blocks.length) {
        throw protocolError("invalid native inspection frame end record");
      }
      frames.push({ frameId: currentFrameId, blocks });
      currentFrameId += 1;
      blocks = [];
    } else if (kind === 4) {
      if (status !== 1 || currentFrameId !== frameCount || blocks.length !== 0
          || first !== frameCount || second !== totalBlocks) {
        throw protocolError("invalid native inspection end record");
      }
      ended = true;
    } else {
      throw protocolError("native inspection emitted an unknown record kind");
    }
  };

  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError("native inspection response chunk must be a Buffer");
      if (finished) throw protocolError("native inspection response decoder is already finished");
      let offset = 0;
      while (offset < chunk.length) {
        if (ended || terminalError !== null) throw protocolError("native inspection emitted data after termination");
        if (headerBytes < RESPONSE_HEADER_BYTES) {
          const count = Math.min(RESPONSE_HEADER_BYTES - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes === RESPONSE_HEADER_BYTES
              && (!header.subarray(0, 8).equals(RESPONSE_MAGIC)
                || header.readUInt32LE(8) !== 2
                || header.readUInt32LE(12) !== RESPONSE_RECORD_BYTES)) {
            throw protocolError("invalid native inspection IPC framing");
          }
          continue;
        }
        const count = Math.min(RESPONSE_RECORD_BYTES - recordBytes, chunk.length - offset);
        chunk.copy(record, recordBytes, offset, offset + count);
        recordBytes += count;
        offset += count;
        if (recordBytes === RESPONSE_RECORD_BYTES) {
          recordBytes = 0;
          consume();
        }
      }
    },
    finish() {
      if (finished) throw protocolError("native inspection response decoder is already finished");
      finished = true;
      if (headerBytes !== RESPONSE_HEADER_BYTES || recordBytes !== 0) {
        throw protocolError("invalid native inspection IPC framing");
      }
      if (terminalError !== null) throw terminalError;
      if (info === null || !ended) throw protocolError("native inspection response is incomplete");
      return {
        // Block Overlay v1 allows optional producer details; only the binary
        // Worker framing and C BlockRecord require a v2 negotiation.
        schemaVersion: 1,
        provenance: { ...info, protocol: NATIVE_INSPECTION_WORKER_PROTOCOL },
        frames,
      };
    },
  };
}

export function decodeNativeInspectionResponse(buffer, options) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("native inspection response must be a Buffer");
  const decoder = createNativeInspectionResponseDecoder(options);
  decoder.push(buffer);
  return decoder.finish();
}

export function inspectReportFramesInNativeWorker(input, report, {
  executable,
  timeoutMs = 30_000,
  signal = null,
  maximumBlocks = NATIVE_INSPECTION_MAX_BLOCKS,
  maximumBlocksPerChunk = 4096,
  maximumFrameBytes = NATIVE_INSPECTION_MAX_INPUT_BYTES,
  maximumCrashRetries = 1,
  spawnImpl = spawn,
} = {}) {
  if (typeof executable !== "string" || executable.length === 0) {
    return Promise.reject(new TypeError("native inspection worker executable is required"));
  }
  if (!report || !Array.isArray(report.frames)) {
    return Promise.reject(new TypeError("native inspection requires an analyzer report"));
  }
  const request = encodeNativeInspectionRequest(input, report.frames, {
    maximumBlocks, maximumBlocksPerChunk, maximumFrameBytes,
  });
  requireInteger(timeoutMs, 1, 300_000, "timeoutMs");
  requireInteger(maximumCrashRetries, 0, 1, "maximumCrashRetries");
  if (signal?.aborted) {
    return Promise.reject(new NativeInspectionWorkerError("native inspection worker cancelled", {
      code: "NATIVE_INSPECTION_CANCELLED",
    }));
  }
  const readFingerprint = () => fingerprintExecutable(executable).catch((cause) => {
    const error = new NativeInspectionWorkerError("native inspection worker executable could not be fingerprinted", {
      code: "NATIVE_INSPECTION_SPAWN_FAILED",
    });
    error.cause = cause;
    throw error;
  });
  const runAttempt = (attempt) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (cause) {
      const error = new NativeInspectionWorkerError("native inspection worker could not start", {
        code: "NATIVE_INSPECTION_SPAWN_FAILED",
      });
      error.cause = cause;
      reject(error);
      return;
    }
    const decoder = createNativeInspectionResponseDecoder({
      frameCount: report.frames.length, maximumBlocks,
    });
    const maximumOutputBytes = RESPONSE_HEADER_BYTES
      + (maximumBlocks + report.frames.length + 2) * RESPONSE_RECORD_BYTES;
    let outputBytes = 0;
    let stderrBytes = 0;
    const stderrChunks = [];
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        if (stderrChunks.length > 0) {
          error.workerStderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(0, 4096);
        }
        error.attempts = attempt + 1;
        reject(error);
      } else resolve(result);
    };
    const terminate = (error) => {
      child.kill("SIGKILL");
      finish(error);
    };
    const abort = () => terminate(new NativeInspectionWorkerError("native inspection worker cancelled", {
      code: "NATIVE_INSPECTION_CANCELLED",
    }));
    const timer = setTimeout(() => terminate(new NativeInspectionWorkerError(
      "native inspection worker timed out", { code: "NATIVE_INSPECTION_TIMEOUT" },
    )), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        terminate(new NativeInspectionWorkerError("native inspection output exceeded its budget", {
          code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
        }));
      } else {
        try { decoder.push(chunk); } catch (error) { terminate(error); }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        terminate(new NativeInspectionWorkerError("native inspection stderr exceeded its budget", {
          code: "NATIVE_INSPECTION_PROTOCOL_ERROR",
        }));
      } else stderrChunks.push(chunk);
    });
    child.once("error", () => finish(new NativeInspectionWorkerError(
      "native inspection worker could not start", { code: "NATIVE_INSPECTION_SPAWN_FAILED" },
    )));
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (code !== 0 || exitSignal !== null) {
        const error = new NativeInspectionWorkerError("native inspection worker crashed", {
          code: "NATIVE_INSPECTION_CRASHED",
        });
        error.exitCode = code;
        error.exitSignal = exitSignal;
        finish(error);
        return;
      }
      try { finish(null, decoder.finish()); } catch (error) { finish(error); }
    });
    child.stdin.once("error", () => {});
    child.stdin.write(request[0]);
    child.stdin.write(request[1]);
    child.stdin.end(request[2]);
  });
  const runWithRetry = async () => {
    let firstCrash = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return {
          result: await runAttempt(attempt),
          attempts: attempt + 1,
          firstCrash,
        };
      } catch (error) {
        if (error?.code !== "NATIVE_INSPECTION_CRASHED" || attempt >= maximumCrashRetries) {
          if (firstCrash !== null && error !== firstCrash) error.firstCrash = firstCrash;
          throw error;
        }
        firstCrash ??= error;
      }
    }
  };
  return readFingerprint().then(async (fingerprint) => {
    const execution = await runWithRetry();
    const after = await readFingerprint();
    if (after.sha256 !== fingerprint.sha256 || after.size !== fingerprint.size) {
      throw new NativeInspectionWorkerError("native inspection worker executable changed during analysis", {
        code: "NATIVE_INSPECTION_EXECUTABLE_CHANGED",
      });
    }
    const normalized = validateBlockOverlayDocument(execution.result, report);
    const workerRecovery = execution.firstCrash === null ? null : {
      recovered: true,
      attempts: execution.attempts,
      firstCrash: {
        code: execution.firstCrash.code,
        exitCode: execution.firstCrash.exitCode ?? null,
        exitSignal: execution.firstCrash.exitSignal ?? null,
        stderr: execution.firstCrash.workerStderr ?? null,
      },
    };
    return {
      ...normalized,
      provenance: {
        ...normalized.provenance,
        workerExecutable: fingerprint,
        ...(workerRecovery === null ? {} : { workerRecovery }),
      },
    };
  });
}
