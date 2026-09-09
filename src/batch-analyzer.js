import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  analyzeMediaBuffer,
  DEFAULT_MAX_FRAMES,
  DEFAULT_MAX_OBUS,
  DEFAULT_MAX_SYNTAX_NODES,
} from "./analyzer.js";
import { PARSER_VERSION } from "./model.js";
import { writeReportSnapshot } from "./snapshot-store.js";

export const DEFAULT_BATCH_EXTENSIONS = Object.freeze([
  ".av1", ".ivf", ".m4v", ".mkv", ".mov", ".mp4", ".obu", ".webm",
]);
export const DEFAULT_BATCH_JOBS = 2;
export const DEFAULT_BATCH_MAX_FILES = 10_000;
export const DEFAULT_BATCH_MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_BATCH_JOBS = 32;

function lexicalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizeBatchExtensions(extensions = DEFAULT_BATCH_EXTENSIONS) {
  if (!Array.isArray(extensions) || extensions.length < 1 || extensions.length > 64) {
    throw new RangeError("batch extensions must contain between 1 and 64 values");
  }
  const normalized = extensions.map((extension) => {
    if (typeof extension !== "string" || !/^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/.test(extension)) {
      throw new RangeError(`invalid batch extension: ${extension}`);
    }
    return `.${extension.replace(/^\./, "").toLowerCase()}`;
  });
  return [...new Set(normalized)].sort(lexicalCompare);
}

export async function enumerateBatchInputs(
  rootDirectory,
  { recursive = false, extensions = DEFAULT_BATCH_EXTENSIONS, maxFiles = DEFAULT_BATCH_MAX_FILES } = {},
) {
  if (typeof rootDirectory !== "string" || rootDirectory.length < 1) {
    throw new TypeError("batch root directory is required");
  }
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new RangeError("batch maxFiles must be a positive safe integer");
  }
  const root = path.resolve(rootDirectory);
  const allowed = new Set(normalizeBatchExtensions(extensions));
  const files = [];
  let ignoredEntryCount = 0;

  const visit = async (relativeDirectory) => {
    const absoluteDirectory = path.join(root, relativeDirectory);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => lexicalCompare(left.name, right.name));
    for (const entry of entries) {
      const relativeNative = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await visit(relativeNative);
        else ignoredEntryCount += 1;
      } else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
        files.push({
          absolutePath: path.join(root, relativeNative),
          relativePath: relativeNative.split(path.sep).join("/"),
        });
        if (files.length > maxFiles) {
          throw new RangeError(`batch input exceeds the ${maxFiles}-file budget`);
        }
      } else {
        ignoredEntryCount += 1;
      }
    }
  };

  await visit("");
  files.sort((left, right) => lexicalCompare(left.relativePath, right.relativePath));
  return { root, files, ignoredEntryCount, extensions: [...allowed].sort(lexicalCompare) };
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => lexicalCompare(left, right)));
}

function mergeCounts(objects) {
  const counts = new Map();
  for (const object of objects) {
    for (const [key, value] of Object.entries(object ?? {})) {
      counts.set(key, (counts.get(key) ?? 0) + value);
    }
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => lexicalCompare(left, right)));
}

function summarizeAnalysis(report) {
  const tileGroups = report.obus.filter(({ tileGroupSummary }) => tileGroupSummary);
  const tiles = tileGroups.flatMap(({ tileGroupSummary }) => tileGroupSummary.tiles ?? []);
  return {
    format: report.source.format,
    complete: report.summary.complete,
    dimensions: report.container?.width && report.container?.height
      ? { width: report.container.width, height: report.container.height }
      : null,
    frameCount: report.summary.frameCount,
    obuCount: report.summary.obuCount,
    syntaxNodeCount: report.syntaxNodes.length,
    errorCount: report.summary.errorCount,
    warningCount: report.summary.warningCount,
    frameTypes: countBy(report.frames.map(({ headerSummary }) =>
      headerSummary?.frameTypeName ?? "UNKNOWN")),
    obuTypes: countBy(report.obus.map(({ type }) => type.name)),
    diagnosticCodes: countBy(report.diagnostics.map(({ code }) => code)),
    tileGroupCount: tileGroups.length,
    tileCount: tiles.length,
    tilePayloadBytes: tiles.reduce((sum, { tileSize }) => sum + tileSize, 0),
  };
}

function failureRecord(input, { byteLength = null, sha256 = null } = {}, error) {
  return {
    relativePath: input.relativePath,
    byteLength,
    sha256,
    status: "failed",
    failure: {
      code: typeof error?.code === "string" ? error.code : "ANALYSIS_FAILED",
      message: "Input could not be read or analyzed",
    },
  };
}

async function analyzeOne(input, options) {
  let buffer = null;
  let byteLength = null;
  let sha256 = null;
  try {
    const file = await stat(input.absolutePath);
    byteLength = file.size;
    if (!file.isFile()) {
      const error = new Error("batch input is no longer a regular file");
      error.code = "BATCH_INPUT_NOT_REGULAR_FILE";
      throw error;
    }
    if (file.size > options.maxFileBytes) {
      const error = new Error(`batch input exceeds the ${options.maxFileBytes}-byte per-file budget`);
      error.code = "BATCH_FILE_SIZE_LIMIT";
      throw error;
    }
    buffer = await readFile(input.absolutePath);
    byteLength = buffer.length;
    sha256 = createHash("sha256").update(buffer).digest("hex");
    const report = await analyzeMediaBuffer(buffer, {
      sourceName: input.relativePath,
      maxObus: options.maxObus,
      maxSyntaxNodes: options.maxSyntaxNodes,
      maxFrames: options.maxFrames,
    });
    const snapshot = options.snapshotDirectory
      ? await writeReportSnapshot(report, options.snapshotDirectory)
      : null;
    const summary = summarizeAnalysis(report);
    return {
      relativePath: input.relativePath,
      byteLength,
      sha256,
      status: summary.errorCount > 0 ? "diagnostics" : "ok",
      ...summary,
      ...(snapshot ? { snapshotId: snapshot.snapshotId } : {}),
    };
  } catch (error) {
    options.onFailure?.(input, error);
    return failureRecord(input, { byteLength, sha256 }, error);
  }
}

async function mapConcurrent(items, jobs, operation) {
  const results = Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
  return results;
}

export async function analyzeBatchDirectory(
  rootDirectory,
  {
    recursive = false,
    extensions = DEFAULT_BATCH_EXTENSIONS,
    jobs = DEFAULT_BATCH_JOBS,
    maxFiles = DEFAULT_BATCH_MAX_FILES,
    maxFileBytes = DEFAULT_BATCH_MAX_FILE_BYTES,
    maxObus = DEFAULT_MAX_OBUS,
    maxSyntaxNodes = DEFAULT_MAX_SYNTAX_NODES,
    maxFrames = DEFAULT_MAX_FRAMES,
    snapshotDirectory = null,
    onFailure = null,
  } = {},
) {
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > MAX_BATCH_JOBS) {
    throw new RangeError(`batch jobs must be between 1 and ${MAX_BATCH_JOBS}`);
  }
  for (const [name, value] of Object.entries({ maxObus, maxSyntaxNodes, maxFrames })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new RangeError("maxFileBytes must be a positive safe integer");
  }
  const enumerated = await enumerateBatchInputs(rootDirectory, {
    recursive,
    extensions,
    maxFiles,
  });
  const files = await mapConcurrent(enumerated.files, jobs, (input) => analyzeOne(input, {
    maxObus,
    maxSyntaxNodes,
    maxFrames,
    maxFileBytes,
    snapshotDirectory,
    onFailure,
  }));
  const successful = files.filter(({ status }) => status !== "failed");
  const formatCounts = countBy(successful.map(({ format }) => format));
  const diagnosticCodes = mergeCounts(successful.map(({ diagnosticCodes: counts }) => counts));
  return {
    schemaVersion: 1,
    kind: "av1scope-batch-analysis",
    rootName: path.basename(enumerated.root),
    configuration: {
      recursive: Boolean(recursive),
      extensions: enumerated.extensions,
      maxFiles,
      maxFileBytes,
      maxObus,
      maxSyntaxNodes,
      maxFrames,
      snapshotStore: Boolean(snapshotDirectory),
    },
    files,
    summary: {
      matchedFileCount: files.length,
      ignoredEntryCount: enumerated.ignoredEntryCount,
      okFileCount: files.filter(({ status }) => status === "ok").length,
      diagnosticFileCount: files.filter(({ status }) => status === "diagnostics").length,
      failedFileCount: files.filter(({ status }) => status === "failed").length,
      completeFileCount: successful.filter(({ complete }) => complete).length,
      totalBytes: files.reduce((sum, { byteLength }) => sum + (byteLength ?? 0), 0),
      totalFrames: successful.reduce((sum, { frameCount }) => sum + frameCount, 0),
      totalObus: successful.reduce((sum, { obuCount }) => sum + obuCount, 0),
      totalSyntaxNodes: successful.reduce((sum, { syntaxNodeCount }) => sum + syntaxNodeCount, 0),
      totalErrors: successful.reduce((sum, { errorCount }) => sum + errorCount, 0),
      totalWarnings: successful.reduce((sum, { warningCount }) => sum + warningCount, 0),
      totalTileGroups: successful.reduce((sum, { tileGroupCount }) => sum + tileGroupCount, 0),
      totalTiles: successful.reduce((sum, { tileCount }) => sum + tileCount, 0),
      formatCounts,
      diagnosticCodes,
    },
    provenance: {
      parser: "av1scope-structural-parser",
      parserVersion: PARSER_VERSION,
      implementation: "av1scope-m0-node-reference",
    },
  };
}
