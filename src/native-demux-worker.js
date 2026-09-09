import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const NATIVE_DEMUX_WORKER_PROTOCOL = "av1scope.native-demux-worker.v1";
export const NATIVE_DEMUX_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const NATIVE_DEMUX_MAX_RECORDS = 250_000;

const REQUEST_BYTES = 56;
const RESPONSE_HEADER_BYTES = 16;
const RESPONSE_RECORD_BYTES = 72;
const RESPONSE_MAGIC = Buffer.from([0x41, 0x31, 0x44, 0x4d, 0x4f, 0x30, 0x31, 0x00]);
const REQUEST_MAGIC = Buffer.from([0x41, 0x31, 0x44, 0x4d, 0x58, 0x30, 0x31, 0x00]);
const KNOWN_SAMPLE_FLAGS = 7;
const KNOWN_ADAPTER_FEATURE_FLAGS = 3;
const KNOWN_WORKER_SANDBOX_FLAGS = 31;
const KNOWN_STATUSES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const MAX_WORKER_EXECUTABLE_BYTES = 256 * 1024 * 1024;

export class NativeDemuxWorkerError extends Error {
  constructor(message, { code = "NATIVE_DEMUX_WORKER_FAILED", status = null } = {}) {
    super(message);
    this.name = "NativeDemuxWorkerError";
    this.code = code;
    this.status = status;
  }
}

async function fingerprintExecutable(executable) {
  const handle = await open(executable, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new TypeError("native demux worker executable must be a regular file");
    if (!Number.isSafeInteger(stats.size) || stats.size <= 0 || stats.size > MAX_WORKER_EXECUTABLE_BYTES) {
      throw new RangeError("native demux worker executable size is outside its supported range");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return { sha256: digest.digest("hex"), size: stats.size };
  } finally {
    await handle.close();
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
    throw new NativeDemuxWorkerError(`${name} exceeds the safe model range`, {
      code: "NATIVE_DEMUX_PROTOCOL_ERROR",
    });
  }
  return Number(value);
}

function signed64(value) {
  return BigInt.asIntN(64, value);
}

function signed32(value, name) {
  const low = Number(value & 0xffff_ffffn);
  const decoded = low > 0x7fff_ffff ? low - 0x1_0000_0000 : low;
  if (value !== BigInt.asUintN(64, BigInt(decoded))) {
    throw new NativeDemuxWorkerError(`${name} has a non-canonical signed encoding`, {
      code: "NATIVE_DEMUX_PROTOCOL_ERROR",
    });
  }
  return decoded;
}

export function encodeNativeDemuxRequest(input, {
  maximumProbeBytes = 16 * 1024 * 1024,
  maximumSampleBytes = 1024 * 1024 * 1024,
  maximumRecords = NATIVE_DEMUX_MAX_RECORDS,
  requestedTrackId = -1,
} = {}) {
  if (!Buffer.isBuffer(input)) throw new TypeError("native demux input must be a Buffer");
  if (input.length > NATIVE_DEMUX_MAX_INPUT_BYTES) {
    throw new RangeError("native demux input exceeds the 64 MiB worker limit");
  }
  requireInteger(maximumProbeBytes, 32, 256 * 1024 * 1024, "maximumProbeBytes");
  requireInteger(maximumSampleBytes, 1, 1024 * 1024 * 1024, "maximumSampleBytes");
  requireInteger(maximumRecords, 1, NATIVE_DEMUX_MAX_RECORDS, "maximumRecords");
  requireInteger(requestedTrackId, -1, 0x7fff_ffff, "requestedTrackId");
  const header = Buffer.alloc(REQUEST_BYTES);
  REQUEST_MAGIC.copy(header, 0);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(REQUEST_BYTES, 12);
  header.writeBigUInt64LE(BigInt(input.length), 16);
  header.writeBigUInt64LE(BigInt(maximumProbeBytes), 24);
  header.writeBigUInt64LE(BigInt(maximumSampleBytes), 32);
  header.writeBigUInt64LE(BigInt(maximumRecords), 40);
  header.writeInt32LE(requestedTrackId, 48);
  header.writeUInt32LE(0, 52);
  return [header, input];
}

export function decodeNativeDemuxResponse(buffer, {
  sourceBytes,
  maximumSampleBytes = 1024 * 1024 * 1024,
  maximumRecords = NATIVE_DEMUX_MAX_RECORDS,
} = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("native demux response must be a Buffer");
  const decoder = createNativeDemuxResponseDecoder({
    sourceBytes, maximumSampleBytes, maximumRecords,
  });
  decoder.push(buffer);
  return decoder.finish();
}

export function createNativeDemuxResponseDecoder({
  sourceBytes,
  maximumSampleBytes = 1024 * 1024 * 1024,
  maximumRecords = NATIVE_DEMUX_MAX_RECORDS,
} = {}) {
  requireInteger(sourceBytes, 0, NATIVE_DEMUX_MAX_INPUT_BYTES, "sourceBytes");
  requireInteger(maximumSampleBytes, 1, 1024 * 1024 * 1024, "maximumSampleBytes");
  requireInteger(maximumRecords, 1, NATIVE_DEMUX_MAX_RECORDS, "maximumRecords");
  const header = Buffer.alloc(RESPONSE_HEADER_BYTES);
  const record = Buffer.alloc(RESPONSE_RECORD_BYTES);
  let headerBytes = 0;
  let recordBytes = 0;
  let recordCount = 0;
  let stream = null;
  let ended = false;
  let terminalError = null;
  let finished = false;
  const samples = [];

  const framingError = () => new NativeDemuxWorkerError("invalid native demux IPC framing", {
    code: "NATIVE_DEMUX_PROTOCOL_ERROR",
  });
  const consumeRecord = () => {
    const index = recordCount;
    recordCount += 1;
    if (recordCount > maximumRecords + 2) {
      throw new NativeDemuxWorkerError("native demux IPC record budget exceeded", {
        code: "NATIVE_DEMUX_PROTOCOL_ERROR",
      });
    }
    const kind = record.readUInt32LE(0);
    const status = record.readUInt32LE(4);
    if (!KNOWN_STATUSES.has(status)) {
      throw new NativeDemuxWorkerError("native demux returned an unknown status", {
        code: "NATIVE_DEMUX_PROTOCOL_ERROR", status,
      });
    }
    const values = Array.from({ length: 8 }, (_, valueIndex) => (
      record.readBigUInt64LE(8 + valueIndex * 8)
    ));
    if (kind === 4) {
      if (ended || terminalError !== null || status === 0 || status === 1
          || values.some((value) => value !== 0n)) {
        throw new NativeDemuxWorkerError("invalid native demux error record", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR", status,
        });
      }
      terminalError = new NativeDemuxWorkerError("native demux worker rejected the input", { status });
      return;
    }
    if (status !== (kind === 3 ? 1 : 0)) {
      throw new NativeDemuxWorkerError("native demux IPC status does not match record kind", {
        code: "NATIVE_DEMUX_PROTOCOL_ERROR", status,
      });
    }
    if (kind === 1) {
      if (stream !== null || index !== 0) {
        throw new NativeDemuxWorkerError("native demux emitted duplicate stream metadata", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      const trackId = signed32(values[0], "trackId");
      const timeBaseNum = signed32(values[3], "timeBaseNum");
      const timeBaseDen = signed32(values[4], "timeBaseDen");
      const width = safeNumber(values[1], 0xffff_ffff, "width");
      const height = safeNumber(values[2], 0xffff_ffff, "height");
      const adapterVersionInt = safeNumber(values[6], 0xffff_ffff, "adapterVersionInt");
      const adapterFeatureFlags = Number(values[7] & 0xffff_ffffn);
      const workerSandboxFlags = Number(values[7] >> 32n);
      if (trackId < 0 || width === 0 || height === 0 || timeBaseNum <= 0 || timeBaseDen <= 0
          || adapterVersionInt === 0 || (adapterFeatureFlags & ~KNOWN_ADAPTER_FEATURE_FLAGS) !== 0
          || (workerSandboxFlags & ~KNOWN_WORKER_SANDBOX_FLAGS) !== 0
          || (adapterFeatureFlags & 1) === 0) {
        throw new NativeDemuxWorkerError("native demux emitted invalid stream metadata", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      stream = {
        trackId, width, height, timeBaseNum, timeBaseDen,
        sampleCount: values[5] === 0n ? null : safeNumber(values[5], Number.MAX_SAFE_INTEGER, "sampleCount"),
        adapterVersion: `${adapterVersionInt >>> 16}.${(adapterVersionInt >>> 8) & 0xff}.${adapterVersionInt & 0xff}`,
        adapterFeatureFlags,
        workerSandboxFlags,
      };
    } else if (kind === 2) {
      if (samples.length >= maximumRecords) {
        throw new NativeDemuxWorkerError("native demux IPC record budget exceeded", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      if (stream === null || ended) {
        throw new NativeDemuxWorkerError("native demux sample ordering is invalid", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      const sampleId = safeNumber(values[0], NATIVE_DEMUX_MAX_RECORDS, "sampleId");
      const trackId = signed32(values[1], "sampleTrackId");
      const flags = safeNumber(values[2], 0xffff_ffff, "flags");
      const sourceStart = safeNumber(values[6], sourceBytes, "sourceStart");
      const sourceLength = safeNumber(values[7], maximumSampleBytes, "sourceLength");
      if (sampleId !== samples.length || trackId !== stream.trackId
          || (flags & ~KNOWN_SAMPLE_FLAGS) !== 0
          || sourceLength > sourceBytes - sourceStart) {
        throw new NativeDemuxWorkerError("native demux emitted an invalid sample", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      samples.push({
        sampleId, trackId, flags,
        dts: signed64(values[3]), pts: signed64(values[4]), duration: signed64(values[5]),
        sourceStart, sourceLength,
      });
    } else if (kind === 3) {
      if (stream === null || ended || terminalError !== null
          || safeNumber(values[0], NATIVE_DEMUX_MAX_RECORDS, "endCount") !== samples.length
          || values.slice(1).some((value) => value !== 0n)) {
        throw new NativeDemuxWorkerError("native demux emitted an invalid end record", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      ended = true;
    } else {
      throw new NativeDemuxWorkerError("native demux emitted an unknown record kind", {
        code: "NATIVE_DEMUX_PROTOCOL_ERROR",
      });
    }
  };

  return {
    push(chunk) {
      if (!Buffer.isBuffer(chunk)) throw new TypeError("native demux response chunk must be a Buffer");
      if (finished) throw new NativeDemuxWorkerError("native demux response decoder is already finished", {
        code: "NATIVE_DEMUX_PROTOCOL_ERROR",
      });
      let offset = 0;
      while (offset < chunk.length) {
        if (headerBytes === RESPONSE_HEADER_BYTES && recordBytes === 0
            && recordCount >= maximumRecords + 2) {
          throw new NativeDemuxWorkerError("native demux IPC record budget exceeded", {
            code: "NATIVE_DEMUX_PROTOCOL_ERROR",
          });
        }
        if (ended || terminalError !== null) {
          throw new NativeDemuxWorkerError(
            ended ? "native demux emitted an invalid end record" : "invalid native demux error record",
            { code: "NATIVE_DEMUX_PROTOCOL_ERROR", status: terminalError?.status ?? null },
          );
        }
        if (headerBytes < RESPONSE_HEADER_BYTES) {
          const count = Math.min(RESPONSE_HEADER_BYTES - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes === RESPONSE_HEADER_BYTES
              && (!header.subarray(0, 8).equals(RESPONSE_MAGIC)
                || header.readUInt32LE(8) !== 1
                || header.readUInt32LE(12) !== RESPONSE_RECORD_BYTES)) {
            throw framingError();
          }
          continue;
        }
        const count = Math.min(RESPONSE_RECORD_BYTES - recordBytes, chunk.length - offset);
        chunk.copy(record, recordBytes, offset, offset + count);
        recordBytes += count;
        offset += count;
        if (recordBytes === RESPONSE_RECORD_BYTES) {
          recordBytes = 0;
          consumeRecord();
        }
      }
    },
    finish() {
      if (finished) throw new NativeDemuxWorkerError("native demux response decoder is already finished", {
        code: "NATIVE_DEMUX_PROTOCOL_ERROR",
      });
      finished = true;
      if (headerBytes !== RESPONSE_HEADER_BYTES || recordBytes !== 0) throw framingError();
      if (recordCount === 0) {
        throw new NativeDemuxWorkerError("native demux IPC record budget exceeded", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      if (terminalError !== null) throw terminalError;
      if (stream === null || !ended) {
        throw new NativeDemuxWorkerError("native demux response is incomplete", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        });
      }
      return { protocol: NATIVE_DEMUX_WORKER_PROTOCOL, stream, samples };
    },
  };
}

export function demuxBufferInNativeWorker(input, {
  executable,
  timeoutMs = 15_000,
  signal = null,
  maximumProbeBytes = 16 * 1024 * 1024,
  maximumSampleBytes = 1024 * 1024 * 1024,
  maximumRecords = NATIVE_DEMUX_MAX_RECORDS,
  requestedTrackId = -1,
  maximumCrashRetries = 1,
  spawnImpl = spawn,
} = {}) {
  if (typeof executable !== "string" || executable.length === 0) {
    return Promise.reject(new TypeError("native demux worker executable is required"));
  }
  const request = encodeNativeDemuxRequest(input, {
    maximumProbeBytes, maximumSampleBytes, maximumRecords, requestedTrackId,
  });
  const readExecutableFingerprint = () => fingerprintExecutable(executable).catch((cause) => {
    const error = new NativeDemuxWorkerError(
      "native demux worker executable could not be fingerprinted",
      { code: "NATIVE_DEMUX_SPAWN_FAILED" },
    );
    error.cause = cause;
    throw error;
  });
  requireInteger(timeoutMs, 1, 300_000, "timeoutMs");
  requireInteger(maximumCrashRetries, 0, 1, "maximumCrashRetries");
  if (signal?.aborted) {
    return Promise.reject(new NativeDemuxWorkerError("native demux worker cancelled", {
      code: "NATIVE_DEMUX_CANCELLED",
    }));
  }
  const runAttempt = (attempt) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new NativeDemuxWorkerError("native demux worker cancelled", {
        code: "NATIVE_DEMUX_CANCELLED",
      });
      error.attempts = attempt;
      reject(error);
      return;
    }
    const child = spawnImpl(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const decoder = createNativeDemuxResponseDecoder({
      sourceBytes: input.length, maximumSampleBytes, maximumRecords,
    });
    let outputBytes = 0;
    let settled = false;
    const maximumOutputBytes = RESPONSE_HEADER_BYTES + (maximumRecords + 2) * RESPONSE_RECORD_BYTES;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        error.attempts = attempt + 1;
        reject(error);
      }
      else resolve(result);
    };
    const terminate = (error) => {
      child.kill("SIGKILL");
      finish(error);
    };
    const abort = () => terminate(new NativeDemuxWorkerError("native demux worker cancelled", {
      code: "NATIVE_DEMUX_CANCELLED",
    }));
    const timer = setTimeout(() => terminate(new NativeDemuxWorkerError(
      "native demux worker timed out", { code: "NATIVE_DEMUX_TIMEOUT" },
    )), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) {
        terminate(new NativeDemuxWorkerError("native demux worker output exceeded its budget", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        }));
      } else {
        try {
          decoder.push(chunk);
        } catch (error) {
          terminate(error);
        }
      }
    });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024) {
        terminate(new NativeDemuxWorkerError("native demux worker stderr exceeded its budget", {
          code: "NATIVE_DEMUX_PROTOCOL_ERROR",
        }));
      }
    });
    child.once("error", () => finish(new NativeDemuxWorkerError(
      "native demux worker could not start", { code: "NATIVE_DEMUX_SPAWN_FAILED" },
    )));
    child.once("close", (code, exitSignal) => {
      if (settled) return;
      if (code !== 0 || exitSignal !== null) {
        finish(new NativeDemuxWorkerError("native demux worker crashed", {
          code: "NATIVE_DEMUX_CRASHED",
        }));
        return;
      }
      try {
        finish(null, decoder.finish());
      } catch (error) {
        finish(error);
      }
    });
    child.stdin.once("error", () => {});
    child.stdin.write(request[0]);
    child.stdin.end(request[1]);
  });
  const runWithRetry = async () => {
    let firstCrash = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runAttempt(attempt);
      } catch (error) {
        if (error?.code !== "NATIVE_DEMUX_CRASHED" || attempt >= maximumCrashRetries) {
          if (firstCrash !== null && error !== firstCrash) error.firstCrash = firstCrash;
          throw error;
        }
        firstCrash ??= error;
      }
    }
  };
  return readExecutableFingerprint().then(async (fingerprint) => {
    const result = await runWithRetry();
    const after = await readExecutableFingerprint();
    if (after.sha256 !== fingerprint.sha256 || after.size !== fingerprint.size) {
      throw new NativeDemuxWorkerError("native demux worker executable changed during analysis", {
        code: "NATIVE_DEMUX_EXECUTABLE_CHANGED",
      });
    }
    return { ...result, workerExecutable: fingerprint };
  });
}
