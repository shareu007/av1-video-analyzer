import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";

import { analyzeMediaBuffer } from "./analyzer.js";
import { validateBlockOverlayDocument } from "./block-overlay.js";
import {
  cleanupBlockOverlayStaging,
  listBlockOverlaySnapshots,
  readBlockOverlayManifest,
  readBlockOverlayPage,
} from "./block-overlay-store.js";
import { traceAv1Headers } from "./header-trace.js";
import { compareVideoFrames } from "./frame-compare.js";
import { inspectSnapshotObuPayload } from "./snapshot-inspector.js";
import {
  cleanupDerivedSyntaxStaging,
  listDerivedSyntaxSnapshots,
  readDerivedSyntaxSnapshot,
  writeDerivedSyntaxSnapshot,
} from "./derived-syntax-store.js";
import {
  cleanupSyntaxOverlayStaging,
  readSyntaxOverlayManifest,
  readSyntaxOverlayPage,
  readSyntaxOverlaySnapshot,
  writeSyntaxOverlaySnapshot,
} from "./syntax-overlay-store.js";
import {
  cleanupSnapshotStaging,
  readSnapshotManifest,
  readSnapshotPage,
  writeReportSnapshotStream,
} from "./snapshot-store.js";
import {
  DEFAULT_CACHE_GC_MINIMUM_AGE_MS,
  garbageCollectSnapshotCache,
} from "./snapshot-cache-gc.js";
import { querySnapshot } from "./snapshot-query.js";
import {
  inspectSnapshotFrameWindow,
  planSnapshotFrameInspection,
} from "./snapshot-frame-inspection.js";
import { createFileSnapshotInput } from "./file-indexer.js";
import {
  DEFAULT_GUI_PUBLIC_DIRECTORY,
  inspectGuiPreflight,
  preflightFailureMessage,
} from "./gui-preflight.js";
import { resolveGuiNativeWorkers } from "./native-worker-discovery.js";

const DEFAULT_PUBLIC_DIRECTORY = DEFAULT_GUI_PUBLIC_DIRECTORY;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_GUI_OBUS = 100_000;
const MAX_GUI_SYNTAX_NODES = 200_000;
const MAX_GUI_FRAMES = 100_000;
const GUI_ANALYSIS_TIMEOUT_MS = 15_000;
const MAX_GUI_ANALYSIS_WORKERS = 2;
const MAX_GUI_INDEX_WORKERS = 1;
export const GUI_STREAM_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const GUI_WORKER_RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 8,
});
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const MAX_LUMA_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_ERROR_BYTES = 64 * 1024;
const MAX_OVERLAY_JSON_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_INSPECTION_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_QUERY_JSON_BYTES = 64 * 1024;
const SNAPSHOT_QUERY_TIMEOUT_MS = 10_000;
const MAX_SNAPSHOT_INSPECTION_PAYLOAD_BYTES = 256 * 1024;
const COMPARE_MAGIC = Buffer.from("AV1SCOPECMP1", "ascii");
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);

function sendJson(response, status, body) {
  const encoded = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(encoded);
}

function syntaxOverlayHeader(manifest, { created } = {}) {
  const syntaxNodeCount = manifest.collections?.syntaxNodes?.count ?? manifest.syntaxNodes?.length;
  const diagnosticCount = manifest.collections?.diagnostics?.count ?? manifest.diagnostics?.length;
  const header = {
    overlaySnapshotId: manifest.overlaySnapshotId,
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    parentSnapshotId: manifest.parentSnapshotId,
    derivedSnapshotIds: manifest.derivedSnapshotIds,
    summary: manifest.summary,
    provenance: manifest.provenance,
    collections: {
      syntaxNodes: { count: syntaxNodeCount },
      diagnostics: { count: diagnosticCount },
    },
  };
  if (typeof created === "boolean") header.created = created;
  return header;
}

function snapshotInspectionError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function decodeInspectionPayload(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw snapshotInspectionError(
      `${field} must be canonical padded base64`, "SNAPSHOT_INSPECTION_INVALID",
    );
  }
  const payload = Buffer.from(value, "base64");
  if (payload.toString("base64") !== value) {
    throw snapshotInspectionError(
      `${field} must use canonical base64 padding`, "SNAPSHOT_INSPECTION_INVALID",
    );
  }
  if (payload.length > MAX_SNAPSHOT_INSPECTION_PAYLOAD_BYTES) {
    throw snapshotInspectionError(
      `${field} exceeds the ${MAX_SNAPSHOT_INSPECTION_PAYLOAD_BYTES}-byte inspection limit`,
      "SNAPSHOT_INSPECTION_PAYLOAD_TOO_LARGE", 413,
    );
  }
  return payload;
}

async function readSnapshotObu(rootDirectory, snapshotId, obuId) {
  const page = await readSnapshotPage(rootDirectory, snapshotId, "obus", {
    offset: obuId,
    limit: 1,
  });
  const record = page.records[0];
  if (!record || record.obuId !== obuId) {
    throw snapshotInspectionError("snapshot OBU not found", "SNAPSHOT_OBU_NOT_FOUND", 404);
  }
  return record;
}

export async function inspectSnapshotRequest(
  rootDirectory,
  snapshotId,
  obuId,
  input,
  { returnDetails = false } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw snapshotInspectionError(
      "snapshot inspection body must be an object", "SNAPSHOT_INSPECTION_INVALID",
    );
  }
  const record = await readSnapshotObu(rootDirectory, snapshotId, obuId);
  const payload = decodeInspectionPayload(input.payload, "payload");
  if (payload.length > record.payloadRange?.length) {
    throw snapshotInspectionError(
      "payload exceeds the indexed OBU range", "SNAPSHOT_INSPECTION_RANGE_MISMATCH",
    );
  }
  if ([1, 4, 5].includes(record.type?.code) &&
      payload.length !== record.payloadRange.length) {
    throw snapshotInspectionError(
      "sequence, Tile Group, and metadata inspection require the complete indexed payload",
      "SNAPSHOT_INSPECTION_PAYLOAD_INCOMPLETE",
    );
  }

  let sequenceRecord = null;
  let sequencePayload = null;
  const hasSequenceId = input.sequenceObuId !== undefined && input.sequenceObuId !== null;
  const hasSequencePayload = input.sequencePayload !== undefined && input.sequencePayload !== null;
  if (hasSequenceId !== hasSequencePayload) {
    throw snapshotInspectionError(
      "sequenceObuId and sequencePayload must be supplied together",
      "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
    );
  }
  if (hasSequenceId) {
    if (!Number.isSafeInteger(input.sequenceObuId) || input.sequenceObuId < 0 ||
        input.sequenceObuId >= obuId) {
      throw snapshotInspectionError(
        "sequenceObuId must identify an earlier OBU", "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
      );
    }
    sequenceRecord = await readSnapshotObu(rootDirectory, snapshotId, input.sequenceObuId);
    if (sequenceRecord.type?.code !== 1) {
      throw snapshotInspectionError(
        "sequenceObuId does not identify a sequence header",
        "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
      );
    }
    sequencePayload = decodeInspectionPayload(input.sequencePayload, "sequencePayload");
    if (sequencePayload.length !== sequenceRecord.payloadRange?.length) {
      throw snapshotInspectionError(
        "sequencePayload does not match the indexed sequence header range",
        "SNAPSHOT_INSPECTION_RANGE_MISMATCH",
      );
    }
  }

  let frameHeaderRecord = null;
  let frameHeaderPayload = null;
  const hasFrameHeaderId = input.frameHeaderObuId !== undefined &&
    input.frameHeaderObuId !== null;
  const hasFrameHeaderPayload = input.frameHeaderPayload !== undefined &&
    input.frameHeaderPayload !== null;
  if (hasFrameHeaderId !== hasFrameHeaderPayload) {
    throw snapshotInspectionError(
      "frameHeaderObuId and frameHeaderPayload must be supplied together",
      "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
    );
  }
  if (hasFrameHeaderId) {
    if (record.type?.code !== 4 || !Number.isSafeInteger(input.frameHeaderObuId) ||
        input.frameHeaderObuId < 0 || input.frameHeaderObuId >= obuId) {
      throw snapshotInspectionError(
        "frameHeaderObuId must identify an earlier Frame Header for a Tile Group",
        "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
      );
    }
    frameHeaderRecord = await readSnapshotObu(
      rootDirectory, snapshotId, input.frameHeaderObuId,
    );
    if (![3, 7].includes(frameHeaderRecord.type?.code)) {
      throw snapshotInspectionError(
        "frameHeaderObuId does not identify a Frame Header",
        "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
      );
    }
    frameHeaderPayload = decodeInspectionPayload(
      input.frameHeaderPayload, "frameHeaderPayload",
    );
    if (frameHeaderPayload.length !== frameHeaderRecord.payloadRange?.length) {
      throw snapshotInspectionError(
        "frameHeaderPayload does not match the indexed Frame Header range",
        "SNAPSHOT_INSPECTION_RANGE_MISMATCH",
      );
    }
    if (frameHeaderRecord.header?.extensionFlag !== record.header?.extensionFlag ||
        frameHeaderRecord.header?.temporalId !== record.header?.temporalId ||
        frameHeaderRecord.header?.spatialId !== record.header?.spatialId ||
        (frameHeaderRecord.frameId !== null && record.frameId !== null &&
          frameHeaderRecord.frameId !== record.frameId)) {
      throw snapshotInspectionError(
        "Frame Header context does not match the Tile Group layer",
        "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
      );
    }
  }
  if (record.type?.code === 4 &&
      (!sequenceRecord || !frameHeaderRecord || sequenceRecord.obuId >= frameHeaderRecord.obuId)) {
    throw snapshotInspectionError(
      "Tile Group inspection requires ordered Sequence Header and Frame Header contexts",
      "SNAPSHOT_INSPECTION_CONTEXT_INVALID",
    );
  }

  try {
    const inspection = inspectSnapshotObuPayload(
      record,
      payload,
      { sequenceRecord, sequencePayload, frameHeaderRecord, frameHeaderPayload },
    );
    return returnDetails ? {
      inspection,
      payload,
      sequenceObuId: sequenceRecord?.obuId ?? null,
      sequencePayload,
      frameHeaderObuId: frameHeaderRecord?.obuId ?? null,
      frameHeaderPayload,
    } : inspection;
  } catch (error) {
    if (error.statusCode) throw error;
    throw snapshotInspectionError(error.message, "SNAPSHOT_INSPECTION_FAILED");
  }
}

async function readRequestBody(request, limit = MAX_UPLOAD_BYTES) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    const error = new Error(`input exceeds the ${limit}-byte GUI limit`);
    error.statusCode = 413;
    throw error;
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > limit) {
      const error = new Error(`input exceeds the ${limit}-byte GUI limit`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

function splitComparisonBody(input) {
  if (input.length < COMPARE_MAGIC.length + 4 || !input.subarray(0, COMPARE_MAGIC.length).equals(COMPARE_MAGIC)) {
    throw new Error("invalid comparison request envelope");
  }
  const firstLength = input.readUInt32BE(COMPARE_MAGIC.length);
  const firstStart = COMPARE_MAGIC.length + 4;
  const secondStart = firstStart + firstLength;
  if (firstLength <= 0 || secondStart >= input.length) throw new Error("invalid comparison stream lengths");
  return [input.subarray(firstStart, secondStart), input.subarray(secondStart)];
}

export function safeSourceName(rawName) {
  let decoded = rawName || "upload.obu";
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    decoded = "upload.obu";
  }
  return path.basename(decoded).replaceAll(/[\u0000-\u001f\u007f]/g, "") || "upload.obu";
}

export async function analyzeGuiBuffer(input, rawName = "upload.obu") {
  if (!Buffer.isBuffer(input)) {
    throw new TypeError("analyzeGuiBuffer expects a Buffer");
  }
  if (input.length > MAX_UPLOAD_BYTES) {
    const error = new Error(`input exceeds the ${MAX_UPLOAD_BYTES}-byte GUI limit`);
    error.statusCode = 413;
    throw error;
  }
  return analyzeMediaBuffer(input, {
    sourceName: safeSourceName(rawName),
    maxObus: MAX_GUI_OBUS,
    maxSyntaxNodes: MAX_GUI_SYNTAX_NODES,
    maxFrames: MAX_GUI_FRAMES,
  });
}

export function createAnalysisGate(limit = MAX_GUI_ANALYSIS_WORKERS) {
  return createConcurrencyGate(limit, {
    code: "ANALYSIS_CAPACITY_EXHAUSTED",
    message: "analysis worker capacity is exhausted",
  });
}

function createConcurrencyGate(limit, { code, message }) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("concurrency limit must be a positive safe integer");
  }
  let active = 0;
  return {
    limit,
    get active() {
      return active;
    },
    async run(task) {
      if (typeof task !== "function") throw new TypeError("analysis task must be a function");
      if (active >= limit) {
        const error = new Error(message);
        error.statusCode = 429;
        error.code = code;
        throw error;
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
      }
    },
  };
}

export async function indexGuiFileToSnapshot(
  inputPath,
  rawName,
  {
    snapshotDirectory,
    signal = null,
    maxFrames = MAX_GUI_FRAMES,
    maxObus = MAX_GUI_OBUS,
    ffprobePath = "ffprobe",
    createSnapshotInput = createFileSnapshotInput,
    writeSnapshot = writeReportSnapshotStream,
  } = {},
) {
  if (typeof snapshotDirectory !== "string" || snapshotDirectory.length === 0) {
    throw new TypeError("streaming GUI index requires a snapshot directory");
  }
  const snapshot = await writeSnapshot(
    await createSnapshotInput(inputPath, {
      maxFrames,
      maxObus,
      signal,
      ffprobePath,
      sourceName: safeSourceName(rawName),
    }),
    snapshotDirectory,
  );
  return {
    schemaVersion: 1,
    kind: "av1scope-streaming-index",
    snapshotId: snapshot.snapshotId,
    created: snapshot.created,
    source: snapshot.manifest.header.source,
    summary: snapshot.manifest.header.summary,
    collections: Object.fromEntries(Object.entries(snapshot.manifest.collections)
      .map(([name, descriptor]) => [name, descriptor.count])),
  };
}

async function stageGuiUpload(request, {
  signal,
  limit = GUI_STREAM_UPLOAD_LIMIT_BYTES,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > limit) {
    const error = new Error(`input exceeds the ${limit}-byte GUI streaming index limit`);
    error.statusCode = 413;
    error.code = "INDEX_UPLOAD_TOO_LARGE";
    throw error;
  }
  const directory = await mkdtemp(path.join(temporaryDirectory, "av1scope-gui-upload-"));
  const inputPath = path.join(directory, "input.media");
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > limit) {
        const error = new Error(`input exceeds the ${limit}-byte GUI streaming index limit`);
        error.statusCode = 413;
        error.code = "INDEX_UPLOAD_TOO_LARGE";
        callback(error);
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(request, limiter, createWriteStream(inputPath, { flags: "wx" }), { signal });
    return { directory, inputPath, received };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (signal?.aborted) {
      throw analysisControlError("streaming index cancelled", "INDEX_CANCELLED", 499);
    }
    throw error;
  }
}

function deserializeWorkerError(data = {}) {
  const error = new Error(data.message || "analysis worker failed");
  error.name = data.name || "Error";
  if (Number.isInteger(data.statusCode)) error.statusCode = data.statusCode;
  if (typeof data.code === "string") error.code = data.code;
  return error;
}

function analysisControlError(message, code, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

export function analyzeGuiJsonInWorker(
  input,
  rawName = "upload.obu",
  {
    signal = null,
    timeoutMs = GUI_ANALYSIS_TIMEOUT_MS,
    WorkerClass = Worker,
    snapshotDirectory = null,
    returnDetails = false,
    nativeDemuxWorkerExecutable = null,
    nativeInspectionWorkerExecutable = null,
    ffprobePath = "ffprobe",
  } = {},
) {
  if (!Buffer.isBuffer(input)) {
    return Promise.reject(new TypeError("analyzeGuiJsonInWorker expects a Buffer"));
  }
  if (input.length > MAX_UPLOAD_BYTES) {
    const error = new Error(`input exceeds the ${MAX_UPLOAD_BYTES}-byte GUI limit`);
    error.statusCode = 413;
    return Promise.reject(error);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new RangeError("timeoutMs must be a positive safe integer"));
  }
  if (snapshotDirectory !== null && typeof snapshotDirectory !== "string") {
    return Promise.reject(new TypeError("snapshotDirectory must be a path string or null"));
  }
  if (nativeDemuxWorkerExecutable !== null
      && (typeof nativeDemuxWorkerExecutable !== "string"
          || nativeDemuxWorkerExecutable.length === 0)) {
    return Promise.reject(new TypeError(
      "nativeDemuxWorkerExecutable must be a non-empty path string or null",
    ));
  }
  if (nativeInspectionWorkerExecutable !== null
      && (typeof nativeInspectionWorkerExecutable !== "string"
          || nativeInspectionWorkerExecutable.length === 0)) {
    return Promise.reject(new TypeError(
      "nativeInspectionWorkerExecutable must be a non-empty path string or null",
    ));
  }
  if (typeof ffprobePath !== "string" || ffprobePath.length === 0) {
    return Promise.reject(new TypeError("ffprobePath must be a non-empty string"));
  }
  if (signal?.aborted) {
    return Promise.reject(analysisControlError(
      "analysis cancelled", "ANALYSIS_CANCELLED", 499,
    ));
  }

  return new Promise((resolve, reject) => {
    const transferred = Uint8Array.from(input);
    const worker = new WorkerClass(new URL("./analyze-worker.js", import.meta.url), {
      workerData: {
        input: transferred,
        sourceName: safeSourceName(rawName),
        maxObus: MAX_GUI_OBUS,
        maxSyntaxNodes: MAX_GUI_SYNTAX_NODES,
        maxFrames: MAX_GUI_FRAMES,
        snapshotDirectory: snapshotDirectory === null ? null : path.resolve(snapshotDirectory),
        nativeDemuxWorkerExecutable: nativeDemuxWorkerExecutable === null
          ? null
          : path.resolve(nativeDemuxWorkerExecutable),
        nativeInspectionWorkerExecutable: nativeInspectionWorkerExecutable === null
          ? null
          : path.resolve(nativeInspectionWorkerExecutable),
        ffprobePath,
      },
      transferList: [transferred.buffer],
      resourceLimits: GUI_WORKER_RESOURCE_LIMITS,
    });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const finish = (error, json) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(json);
    };
    const stop = (error) => {
      try {
        worker.postMessage({ type: "abort" });
      } catch {
        // The worker may already be exiting.
      }
      const forcedTermination = setTimeout(() => {
        Promise.resolve(worker.terminate()).catch(() => {});
      }, 100);
      forcedTermination.unref?.();
      finish(error);
    };
    const abort = () => stop(analysisControlError(
      "analysis cancelled", "ANALYSIS_CANCELLED", 499,
    ));
    const timeout = setTimeout(
      () => stop(analysisControlError(
        `analysis timed out after ${timeoutMs} ms`, "ANALYSIS_TIMEOUT", 504,
      )),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message) => {
      if (message?.ok && typeof message.json === "string") {
        finish(null, returnDetails ? { json: message.json, snapshot: message.snapshot ?? null } : message.json);
      }
      else finish(deserializeWorkerError(message?.error));
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`analysis worker exited with code ${code}`));
      else finish(new Error("analysis worker exited before returning a report"));
    });
  });
}

export function decodeFramePreview(
  input,
  frameIndex,
  { ffmpegPath = "ffmpeg", timeoutMs = 5000, signal = null } = {},
) {
  if (!Buffer.isBuffer(input)) throw new TypeError("decodeFramePreview expects a Buffer");
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new RangeError("frame index must be non-negative");
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vf", `select=eq(n\\,${frameIndex})`, "-vsync", "0", "-frames:v", "1",
      "-f", "image2pipe", "-vcodec", "png", "pipe:1",
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let errorSize = 0;
    let outputSize = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`FFmpeg preview timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg preview cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_PREVIEW_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("decoded preview exceeds the output limit"));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errorSize >= MAX_PROCESS_ERROR_BYTES) return;
      const bounded = chunk.subarray(0, MAX_PROCESS_ERROR_BYTES - errorSize);
      errors.push(bounded);
      errorSize += bounded.length;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(Buffer.concat(errors).toString("utf8").trim() || `FFmpeg exited with code ${code}`));
      } else if (outputSize === 0) {
        finish(new Error(`frame ${frameIndex} produced no preview`));
      } else {
        finish(null, Buffer.concat(output, outputSize));
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(input);
  });
}

export function analyzeFrameLuma(
  input,
  frameIndex,
  { ffmpegPath = "ffmpeg", timeoutMs = 5000, signal = null } = {},
) {
  if (!Buffer.isBuffer(input)) throw new TypeError("analyzeFrameLuma expects a Buffer");
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new RangeError("frame index must be non-negative");
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vf", `select=eq(n\\,${frameIndex}),format=gray`, "-vsync", "0", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const histogram = Array(256).fill(0);
    let sampleCount = 0;
    let sum = 0;
    let sumSquares = 0;
    const errors = [];
    let errorSize = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`FFmpeg luma analysis timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg luma analysis cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      sampleCount += chunk.length;
      if (sampleCount > MAX_LUMA_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("decoded luma plane exceeds the analysis limit"));
        return;
      }
      for (const value of chunk) {
        histogram[value] += 1;
        sum += value;
        sumSquares += value * value;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (errorSize >= MAX_PROCESS_ERROR_BYTES) return;
      const bounded = chunk.subarray(0, MAX_PROCESS_ERROR_BYTES - errorSize);
      errors.push(bounded);
      errorSize += bounded.length;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(Buffer.concat(errors).toString("utf8").trim() || `FFmpeg exited with code ${code}`));
      } else if (sampleCount === 0) {
        finish(new Error(`frame ${frameIndex} produced no luma samples`));
      } else {
        const mean = sum / sampleCount;
        finish(null, {
          frameIndex,
          sampleCount,
          minimum: histogram.findIndex((count) => count > 0),
          maximum: histogram.findLastIndex((count) => count > 0),
          mean,
          standardDeviation: Math.sqrt(Math.max(0, sumSquares / sampleCount - mean * mean)),
          histogram,
        });
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") finish(error);
    });
    child.stdin.end(input);
  });
}

async function serveStatic(requestPath, response, publicDirectory) {
  const routePath = requestPath === "/" ? "/index.html" : requestPath;
  let decoded;
  try {
    decoded = decodeURIComponent(routePath);
  } catch {
    sendJson(response, 400, { error: "invalid URL encoding" });
    return;
  }
  const relative = decoded.replace(/^\/+/, "");
  const target = path.resolve(publicDirectory, relative);
  const rootPrefix = `${path.resolve(publicDirectory)}${path.sep}`;
  if (!target.startsWith(rootPrefix)) {
    sendJson(response, 403, { error: "path is outside the public directory" });
    return;
  }
  let metadata;
  try {
    metadata = await stat(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    throw error;
  }
  if (!metadata.isFile()) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES.get(path.extname(target)) ?? "application/octet-stream",
    "content-length": metadata.size,
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  createReadStream(target).pipe(response);
}

export function createGuiServer({
  publicDirectory = DEFAULT_PUBLIC_DIRECTORY,
  maxConcurrentAnalyses = MAX_GUI_ANALYSIS_WORKERS,
  maxConcurrentIndexes = MAX_GUI_INDEX_WORKERS,
  snapshotDirectory = null,
  nativeDemuxWorkerExecutable = null,
  nativeInspectionWorkerExecutable = null,
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  analyzeInWorker = analyzeGuiJsonInWorker,
  indexFileToSnapshot = indexGuiFileToSnapshot,
  inspectSnapshotFrame = inspectSnapshotFrameWindow,
  streamUploadLimitBytes = GUI_STREAM_UPLOAD_LIMIT_BYTES,
  temporaryDirectory = os.tmpdir(),
  preflight = null,
} = {}) {
  if (!Number.isSafeInteger(streamUploadLimitBytes) || streamUploadLimitBytes < 1) {
    throw new RangeError("streamUploadLimitBytes must be a positive safe integer");
  }
  if (typeof temporaryDirectory !== "string" || temporaryDirectory.length === 0) {
    throw new TypeError("temporaryDirectory must be a non-empty path string");
  }
  if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0
      || typeof ffprobePath !== "string" || ffprobePath.length === 0) {
    throw new TypeError("ffmpegPath and ffprobePath must be non-empty strings");
  }
  const analysisGate = createAnalysisGate(maxConcurrentAnalyses);
  const indexGate = createConcurrencyGate(maxConcurrentIndexes, {
    code: "INDEX_CAPACITY_EXHAUSTED",
    message: "streaming index capacity is exhausted",
  });
  const snapshotRoot = snapshotDirectory === null ? null : path.resolve(snapshotDirectory);
  const nativeDemuxWorker = nativeDemuxWorkerExecutable === null
    ? null
    : path.resolve(nativeDemuxWorkerExecutable);
  const nativeInspectionWorker = nativeInspectionWorkerExecutable === null
    ? null
    : path.resolve(nativeInspectionWorkerExecutable);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "av1scope-gui",
          uploadLimitBytes: MAX_UPLOAD_BYTES,
          analysisTimeoutMs: GUI_ANALYSIS_TIMEOUT_MS,
          analysisWorkers: {
            active: analysisGate.active,
            limit: analysisGate.limit,
          },
          indexWorkers: {
            active: indexGate.active,
            limit: indexGate.limit,
          },
          streamingIndexUploadLimitBytes: streamUploadLimitBytes,
          analysisBudgets: {
            frames: MAX_GUI_FRAMES,
            obus: MAX_GUI_OBUS,
            syntaxNodes: MAX_GUI_SYNTAX_NODES,
          },
          containerDemux: nativeDemuxWorker === null
            ? { implementation: "ffprobe-reference", isolatedProcess: true }
            : { implementation: "av1scope-native-worker-v1", isolatedProcess: true },
          blockInspection: nativeInspectionWorker === null
            ? { enabled: false }
            : { enabled: true, implementation: "av1scope-native-inspection-worker-v2", isolatedProcess: true },
          snapshotStore: {
            enabled: snapshotRoot !== null,
            cacheGcMinimumAgeMs: DEFAULT_CACHE_GC_MINIMUM_AGE_MS,
          },
          preflight,
          capabilities: preflight?.capabilities ?? null,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/index") {
        if (snapshotRoot === null) {
          sendJson(response, 409, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        const result = await indexGate.run(async () => {
          const controller = new AbortController();
          const abort = () => controller.abort("client-disconnected");
          const close = () => {
            if (!response.writableEnded) abort();
          };
          request.once("aborted", abort);
          response.once?.("close", close);
          let staged = null;
          try {
            staged = await stageGuiUpload(request, {
              signal: controller.signal,
              limit: streamUploadLimitBytes,
              temporaryDirectory,
            });
            return await indexFileToSnapshot(
              staged.inputPath,
              url.searchParams.get("name"),
              {
                snapshotDirectory: snapshotRoot,
                signal: controller.signal,
                ffprobePath,
              },
            );
          } finally {
            request.removeListener("aborted", abort);
            response.removeListener?.("close", close);
            if (staged) await rm(staged.directory, { recursive: true, force: true });
          }
        });
        sendJson(response, result.created ? 201 : 200, result);
        return;
      }
      if ((request.method === "GET" || request.method === "POST") &&
          url.pathname === "/api/cache-gc") {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        let minimumAgeMs = Number(
          url.searchParams.get("minimumAgeMs") ?? DEFAULT_CACHE_GC_MINIMUM_AGE_MS,
        );
        let expectedPlanId = null;
        if (request.method === "POST") {
          let input;
          try {
            input = JSON.parse((await readRequestBody(
              request, MAX_SNAPSHOT_INSPECTION_JSON_BYTES,
            )).toString("utf8"));
          } catch (error) {
            if (error.statusCode) throw error;
            sendJson(response, 400, {
              error: "cache GC body must be valid JSON",
              code: "CACHE_GC_INVALID",
            });
            return;
          }
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            sendJson(response, 400, {
              error: "cache GC body must be an object",
              code: "CACHE_GC_INVALID",
            });
            return;
          }
          minimumAgeMs = input.minimumAgeMs;
          expectedPlanId = input.planId;
        }
        if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0 ||
            (request.method === "POST" &&
              (typeof expectedPlanId !== "string" || !/^[0-9a-f]{64}$/.test(expectedPlanId)))) {
          sendJson(response, 400, {
            error: "cache GC requires a non-negative minimumAgeMs and current planId",
            code: "CACHE_GC_INVALID",
          });
          return;
        }
        try {
          sendJson(response, 200, await garbageCollectSnapshotCache(snapshotRoot, {
            apply: request.method === "POST",
            expectedPlanId,
            minimumAgeMs,
          }));
        } catch (error) {
          if (error.code !== "CACHE_GC_PLAN_STALE") throw error;
          sendJson(response, 409, { error: error.message, code: error.code });
        }
        return;
      }
      const snapshotQueryMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/query$/,
      );
      if (request.method === "POST" && snapshotQueryMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        let input;
        try {
          input = JSON.parse((await readRequestBody(
            request, MAX_SNAPSHOT_QUERY_JSON_BYTES,
          )).toString("utf8"));
        } catch (error) {
          if (error.statusCode) throw error;
          sendJson(response, 400, {
            error: "snapshot query body must be valid JSON",
            code: "SNAPSHOT_QUERY_INVALID",
          });
          return;
        }
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          sendJson(response, 400, {
            error: "snapshot query body must be an object",
            code: "SNAPSHOT_QUERY_INVALID",
          });
          return;
        }
        try {
          const controller = new AbortController();
          request.once("aborted", () => controller.abort("cancelled"));
          const timeout = setTimeout(() => controller.abort("timeout"), SNAPSHOT_QUERY_TIMEOUT_MS);
          try {
            sendJson(response, 200, await querySnapshot(
              snapshotRoot, snapshotQueryMatch[1], input, { signal: controller.signal },
            ));
          } finally {
            clearTimeout(timeout);
          }
        } catch (error) {
          if (error.code === "ENOENT") {
            sendJson(response, 404, {
              error: "snapshot not found",
              code: "SNAPSHOT_NOT_FOUND",
            });
            return;
          }
          if (error instanceof TypeError || error instanceof RangeError ||
              /snapshot query pageToken|projection paths must be unique/.test(error.message)) {
            sendJson(response, 400, {
              error: error.message,
              code: "SNAPSHOT_QUERY_INVALID",
            });
            return;
          }
          if (error.code === "SNAPSHOT_QUERY_CANCELLED" ||
              error.code === "SNAPSHOT_QUERY_TIMEOUT") {
            sendJson(response, error.statusCode, { error: error.message, code: error.code });
            return;
          }
          throw error;
        }
        return;
      }
      const snapshotMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/(manifest|frames|obus|syntaxNodes|diagnostics)$/,
      );
      if (request.method === "GET" && snapshotMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        const [, snapshotId, collection] = snapshotMatch;
        try {
          if (collection === "manifest") {
            sendJson(response, 200, await readSnapshotManifest(snapshotRoot, snapshotId));
            return;
          }
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 1_000);
          if (!Number.isSafeInteger(offset) || offset < 0 ||
              !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
            sendJson(response, 400, {
              error: "snapshot page requires offset >= 0 and limit between 1 and 10000",
              code: "SNAPSHOT_PAGE_INVALID",
            });
            return;
          }
          sendJson(response, 200, await readSnapshotPage(
            snapshotRoot, snapshotId, collection, { offset, limit },
          ));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sendJson(response, 404, {
            error: "snapshot not found",
            code: "SNAPSHOT_NOT_FOUND",
          });
        }
        return;
      }
      const derivedSyntaxPageMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/derived-syntax$/,
      );
      if (request.method === "GET" && derivedSyntaxPageMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 1_000);
        if (!Number.isSafeInteger(offset) || offset < 0 ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
          sendJson(response, 400, {
            error: "derived syntax page requires offset >= 0 and limit between 1 and 10000",
            code: "DERIVED_SYNTAX_PAGE_INVALID",
          });
          return;
        }
        try {
          sendJson(response, 200, await listDerivedSyntaxSnapshots(
            snapshotRoot, derivedSyntaxPageMatch[1], { offset, limit },
          ));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sendJson(response, 404, {
            error: "snapshot not found",
            code: "SNAPSHOT_NOT_FOUND",
          });
        }
        return;
      }
      const syntaxOverlayCreateMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/syntax-overlays$/,
      );
      if (request.method === "POST" && syntaxOverlayCreateMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        let input;
        try {
          input = JSON.parse((await readRequestBody(
            request, MAX_SNAPSHOT_INSPECTION_JSON_BYTES,
          )).toString("utf8"));
        } catch (error) {
          if (error.statusCode) throw error;
          sendJson(response, 400, {
            error: "syntax overlay body must be valid JSON",
            code: "SYNTAX_OVERLAY_INVALID",
          });
          return;
        }
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            !Array.isArray(input.derivedSnapshotIds)) {
          sendJson(response, 400, {
            error: "syntax overlay requires derivedSnapshotIds",
            code: "SYNTAX_OVERLAY_INVALID",
          });
          return;
        }
        try {
          const result = await writeSyntaxOverlaySnapshot(snapshotRoot, {
            parentSnapshotId: syntaxOverlayCreateMatch[1],
            derivedSnapshotIds: input.derivedSnapshotIds,
          });
          sendJson(response, 200, syntaxOverlayHeader(
            result.storageManifest, { created: result.created },
          ));
        } catch (error) {
          if (error.code === "ENOENT") {
            sendJson(response, 404, {
              error: "snapshot or derived syntax input not found",
              code: "SYNTAX_OVERLAY_INPUT_NOT_FOUND",
            });
            return;
          }
          if (error instanceof TypeError || error instanceof RangeError ||
              /multiple results|different parent|must be unique/.test(error.message)) {
            sendJson(response, 409, {
              error: error.message,
              code: "SYNTAX_OVERLAY_CONFLICT",
            });
            return;
          }
          throw error;
        }
        return;
      }
      const snapshotInspectionMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/inspect\/(\d+)$/,
      );
      if (request.method === "POST" && snapshotInspectionMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        const [, snapshotId, rawObuId] = snapshotInspectionMatch;
        const obuId = Number(rawObuId);
        if (!Number.isSafeInteger(obuId)) {
          sendJson(response, 400, {
            error: "snapshot OBU ID must be a safe integer",
            code: "SNAPSHOT_INSPECTION_INVALID",
          });
          return;
        }
        try {
          const encoded = await readRequestBody(request, MAX_SNAPSHOT_INSPECTION_JSON_BYTES);
          let input;
          try {
            input = JSON.parse(encoded.toString("utf8"));
          } catch {
            throw snapshotInspectionError(
              "snapshot inspection body must be valid JSON",
              "SNAPSHOT_INSPECTION_INVALID",
            );
          }
          const details = await inspectSnapshotRequest(
            snapshotRoot, snapshotId, obuId, input, { returnDetails: true },
          );
          const derived = await writeDerivedSyntaxSnapshot(snapshotRoot, {
            parentSnapshotId: snapshotId,
            obuId,
            payload: details.payload,
            sequenceObuId: details.sequenceObuId,
            sequencePayload: details.sequencePayload,
            frameHeaderObuId: details.frameHeaderObuId,
            frameHeaderPayload: details.frameHeaderPayload,
            inspection: details.inspection,
          });
          sendJson(response, 200, {
            ...details.inspection,
            derivedSnapshot: {
              id: derived.derivedSnapshotId,
              created: derived.created,
            },
          });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sendJson(response, 404, {
            error: "snapshot not found",
            code: "SNAPSHOT_NOT_FOUND",
          });
        }
        return;
      }
      const derivedSyntaxMatch = url.pathname.match(
        /^\/api\/derived-syntax\/([0-9a-f]{64})$/,
      );
      if (request.method === "GET" && derivedSyntaxMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        try {
          sendJson(response, 200, await readDerivedSyntaxSnapshot(
            snapshotRoot, derivedSyntaxMatch[1],
          ));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sendJson(response, 404, {
            error: "derived syntax snapshot not found",
            code: "DERIVED_SYNTAX_NOT_FOUND",
          });
        }
        return;
      }
      const syntaxOverlayMatch = url.pathname.match(
        /^\/api\/syntax-overlays\/([0-9a-f]{64})(?:\/(manifest|syntaxNodes|diagnostics))?$/,
      );
      if (request.method === "GET" && syntaxOverlayMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        try {
          const collection = syntaxOverlayMatch[2];
          if (!collection) {
            sendJson(response, 200, await readSyntaxOverlaySnapshot(
              snapshotRoot, syntaxOverlayMatch[1],
            ));
            return;
          }
          if (collection === "manifest") {
            sendJson(response, 200, syntaxOverlayHeader(
              await readSyntaxOverlayManifest(snapshotRoot, syntaxOverlayMatch[1]),
            ));
            return;
          }
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 200);
          if (!Number.isSafeInteger(offset) || offset < 0 ||
              !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
            sendJson(response, 400, {
              error: "syntax overlay page requires offset >= 0 and limit between 1 and 10000",
              code: "SYNTAX_OVERLAY_PAGE_INVALID",
            });
            return;
          }
          sendJson(response, 200, await readSyntaxOverlayPage(
            snapshotRoot, syntaxOverlayMatch[1], collection, { offset, limit },
          ));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sendJson(response, 404, {
            error: "syntax overlay snapshot not found",
            code: "SYNTAX_OVERLAY_NOT_FOUND",
          });
        }
        return;
      }
      const blockOverlayListMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/block-overlays$/,
      );
      if (request.method === "GET" && blockOverlayListMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        const overlays = await listBlockOverlaySnapshots(snapshotRoot, blockOverlayListMatch[1]);
        sendJson(response, 200, {
          schemaVersion: 1,
          kind: "av1scope-block-overlay-list",
          parentSnapshotId: blockOverlayListMatch[1],
          overlays: overlays.map((manifest) => ({
            blockOverlaySnapshotId: manifest.blockOverlaySnapshotId,
            summary: manifest.summary,
            provenance: manifest.provenance,
          })),
        });
        return;
      }
      const snapshotFrameInspectionMatch = url.pathname.match(
        /^\/api\/snapshots\/([0-9a-f]{64})\/inspect-frames\/(\d+)$/,
      );
      if ((request.method === "GET" || request.method === "POST")
          && snapshotFrameInspectionMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        if (nativeInspectionWorker === null) {
          sendJson(response, 409, {
            error: "native block inspection is disabled",
            code: "NATIVE_INSPECTION_DISABLED",
          });
          return;
        }
        const snapshotId = snapshotFrameInspectionMatch[1];
        const targetFrameId = Number(snapshotFrameInspectionMatch[2]);
        const plan = await planSnapshotFrameInspection(
          snapshotRoot, snapshotId, targetFrameId,
        );
        if (request.method === "GET") {
          sendJson(response, 200, plan);
          return;
        }
        const expectedFingerprint = plan.sourceFingerprint?.digest ?? null;
        if (expectedFingerprint !== null
            && request.headers["x-av1scope-source-fingerprint"] !== expectedFingerprint) {
          sendJson(response, 409, {
            error: "bound source fingerprint does not match the snapshot",
            code: "SNAPSHOT_SOURCE_FINGERPRINT_MISMATCH",
          });
          return;
        }
        const result = await analysisGate.run(async () => {
          const controller = new AbortController();
          const abort = () => controller.abort("client-disconnected");
          const close = () => {
            if (!response.writableEnded) abort();
          };
          request.once("aborted", abort);
          response.once?.("close", close);
          try {
            const input = await readRequestBody(request, plan.inputByteLength);
            return inspectSnapshotFrame(
              snapshotRoot,
              snapshotId,
              targetFrameId,
              input,
              { executable: nativeInspectionWorker, signal: controller.signal },
            );
          } finally {
            request.removeListener("aborted", abort);
            response.removeListener?.("close", close);
          }
        });
        sendJson(response, result.stored.created ? 201 : 200, {
          schemaVersion: 1,
          kind: "av1scope-snapshot-frame-inspection-result",
          parentSnapshotId: snapshotId,
          blockOverlaySnapshotId: result.stored.blockOverlaySnapshotId,
          created: result.stored.created,
          plan: result.plan,
          summary: result.stored.manifest.summary,
          provenance: result.stored.manifest.provenance,
        });
        return;
      }
      const blockOverlayMatch = url.pathname.match(
        /^\/api\/block-overlays\/([0-9a-f]{64})(?:\/(manifest|frames|blocks))?$/,
      );
      if (request.method === "GET" && blockOverlayMatch) {
        if (snapshotRoot === null) {
          sendJson(response, 404, {
            error: "snapshot store is disabled",
            code: "SNAPSHOT_STORE_DISABLED",
          });
          return;
        }
        try {
          const collection = blockOverlayMatch[2];
          if (collection === undefined || collection === "manifest") {
            sendJson(response, 200, await readBlockOverlayManifest(
              snapshotRoot, blockOverlayMatch[1],
            ));
            return;
          }
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 200);
          if (!Number.isSafeInteger(offset) || offset < 0
              || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
            sendJson(response, 400, {
              error: "block overlay page requires offset >= 0 and limit between 1 and 10000",
              code: "BLOCK_OVERLAY_PAGE_INVALID",
            });
            return;
          }
          sendJson(response, 200, await readBlockOverlayPage(
            snapshotRoot, blockOverlayMatch[1], collection, { offset, limit },
          ));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          sendJson(response, 404, {
            error: "block overlay snapshot not found",
            code: "BLOCK_OVERLAY_NOT_FOUND",
          });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/analyze") {
        const result = await analysisGate.run(async () => {
          const controller = new AbortController();
          const abort = () => controller.abort("client-disconnected");
          const close = () => {
            if (!response.writableEnded) abort();
          };
          request.once("aborted", abort);
          response.once?.("close", close);
          try {
            const input = await readRequestBody(request);
            return await analyzeInWorker(input, url.searchParams.get("name"), {
              signal: controller.signal,
              snapshotDirectory: snapshotRoot,
              nativeDemuxWorkerExecutable: nativeDemuxWorker,
              nativeInspectionWorkerExecutable: nativeInspectionWorker,
              ffprobePath,
              returnDetails: true,
            });
          } finally {
            request.removeListener("aborted", abort);
            response.removeListener?.("close", close);
          }
        });
        const headers = {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(result.json),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        if (result.snapshot?.snapshotId) {
          headers["x-av1scope-snapshot-id"] = result.snapshot.snapshotId;
        }
        if (result.snapshot?.blockOverlaySnapshotId) {
          headers["x-av1scope-block-overlay-id"] = result.snapshot.blockOverlaySnapshotId;
        }
        response.writeHead(200, headers);
        response.end(result.json);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/preview") {
        const input = await readRequestBody(request);
        const frameIndex = Number(url.searchParams.get("frame") ?? 0);
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        const png = await decodeFramePreview(input, frameIndex, {
          ffmpegPath, signal: controller.signal,
        });
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": png.length,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(png);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/frame-stats") {
        const input = await readRequestBody(request);
        const frameIndex = Number(url.searchParams.get("frame") ?? 0);
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        sendJson(response, 200, await analyzeFrameLuma(input, frameIndex, {
          ffmpegPath, signal: controller.signal,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/validate-overlay") {
        const input = JSON.parse((await readRequestBody(request, MAX_OVERLAY_JSON_BYTES)).toString("utf8"));
        sendJson(response, 200, validateBlockOverlayDocument(input.overlay, input.report));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/header-trace") {
        const input = await readRequestBody(request);
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        sendJson(response, 200, await traceAv1Headers(input, {
          ffmpegPath, signal: controller.signal,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/compare-frame") {
        const input = await readRequestBody(request, MAX_UPLOAD_BYTES * 2 + 1024);
        const [reference, candidate] = splitComparisonBody(input);
        const frameIndex = Number(url.searchParams.get("frame") ?? 0);
        const controller = new AbortController();
        request.once("aborted", () => controller.abort());
        sendJson(response, 200, await compareVideoFrames(reference, candidate, frameIndex, {
          ffmpegPath, signal: controller.signal,
        }));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "method not allowed" });
        return;
      }
      await serveStatic(url.pathname, response, publicDirectory);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (!response.headersSent) {
        const body = {
          error: error.statusCode ? error.message : "internal server error",
        };
        if (typeof error.code === "string") body.code = error.code;
        sendJson(response, error.statusCode ?? 500, body);
      } else {
        response.destroy(error);
      }
    }
  });
}

export async function startGuiServer(options = {}) {
  const runtimeOptions = await resolveGuiNativeWorkers(options);
  const host = runtimeOptions.host ?? "127.0.0.1";
  const port = runtimeOptions.port ?? 4173;
  const preflight = runtimeOptions.preflight ?? await inspectGuiPreflight(runtimeOptions);
  if (!preflight.ok) {
    throw new Error(`GUI preflight failed: ${preflightFailureMessage(preflight)}`);
  }
  if (runtimeOptions.snapshotDirectory) {
    const cleanupOptions = {
      minimumAgeMs: runtimeOptions.snapshotStagingMinimumAgeMs ?? 60 * 60 * 1_000,
    };
    await Promise.all([
      cleanupSnapshotStaging(runtimeOptions.snapshotDirectory, cleanupOptions),
      cleanupDerivedSyntaxStaging(runtimeOptions.snapshotDirectory, cleanupOptions),
      cleanupSyntaxOverlayStaging(runtimeOptions.snapshotDirectory, cleanupOptions),
      cleanupBlockOverlayStaging(runtimeOptions.snapshotDirectory, cleanupOptions),
    ]);
  }
  const server = createGuiServer({ ...runtimeOptions, preflight });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const actualHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  return { server, url: `http://${actualHost}:${address.port}` };
}

export async function readGuiAsset(name) {
  return readFile(path.join(DEFAULT_PUBLIC_DIRECTORY, name), "utf8");
}
