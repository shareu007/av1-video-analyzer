import { randomUUID } from "node:crypto";
import {
  access,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  analyzeMediaBuffer, DEFAULT_MAX_FRAMES, DEFAULT_MAX_OBUS, DEFAULT_MAX_SYNTAX_NODES,
} from "./analyzer.js";
import { compareVideoFrames } from "./frame-compare.js";
import { stringifyCanonical, stringifyReport } from "./json.js";
import { PARSER_VERSION, Severity } from "./model.js";
import { createFileSnapshotInput } from "./file-indexer.js";
import { writeReportSnapshot, writeReportSnapshotStream } from "./snapshot-store.js";
import {
  readDerivedSyntaxSnapshot,
  rebuildDerivedSyntaxIndex,
} from "./derived-syntax-store.js";
import {
  readSyntaxOverlaySnapshot,
  writeSyntaxOverlaySnapshot,
} from "./syntax-overlay-store.js";
import {
  DEFAULT_CACHE_GC_MINIMUM_AGE_MS,
  garbageCollectSnapshotCache,
} from "./snapshot-cache-gc.js";
import { MAX_SNAPSHOT_QUERY_LIMIT, querySnapshot } from "./snapshot-query.js";
import {
  analyzeBatchDirectory,
  DEFAULT_BATCH_EXTENSIONS,
  DEFAULT_BATCH_JOBS,
  DEFAULT_BATCH_MAX_FILE_BYTES,
  DEFAULT_BATCH_MAX_FILES,
  MAX_BATCH_JOBS,
} from "./batch-analyzer.js";
import { rehearseSnapshotCacheRecovery } from "./cache-recovery-rehearsal.js";

const HELP = `AV1Scope M0 structural analyzer

Usage:
  av1scope analyze <input> [options]
  av1scope batch <directory> [options]
  av1scope index <input> --snapshot-dir <path> [options]
  av1scope replay-derived <derived-syntax-id> --snapshot-dir <path> [options]
  av1scope merge-derived <parent-id> <derived-id>... --snapshot-dir <path> [options]
  av1scope replay-overlay <overlay-id> --snapshot-dir <path> [options]
  av1scope rebuild-derived-index <parent-id> --snapshot-dir <path> [options]
  av1scope rehearse-recovery <parent-id> --snapshot-dir <path> [options]
  av1scope query <snapshot-id> --snapshot-dir <path> --collection <name> [options]
  av1scope gc-cache --snapshot-dir <path> [options]
  av1scope compare <reference> <candidate> [options]

Options:
  --output <path>  Write JSON through a same-directory temporary file
  --force          Replace an existing output file
  --compact        Emit compact JSON
  --strict         Exit with status 2 when error/fatal diagnostics exist
  --frames <n>     Compare at most n frames (compare only)
  --recursive      Include matching files in subdirectories (batch only)
  --extensions <list>  Comma-separated batch extensions (default ${DEFAULT_BATCH_EXTENSIONS.join(",")})
  --jobs <n>       Batch concurrency, 1..${MAX_BATCH_JOBS} (default ${DEFAULT_BATCH_JOBS})
  --max-files <n>  Batch input file budget (default ${DEFAULT_BATCH_MAX_FILES})
  --max-file-bytes <n>  Per-file batch read budget (default ${DEFAULT_BATCH_MAX_FILE_BYTES})
  --max-obus <n>   Publish at most n OBU records (default ${DEFAULT_MAX_OBUS})
  --max-syntax-nodes <n>  Publish at most n syntax fields (default ${DEFAULT_MAX_SYNTAX_NODES})
  --max-frames <n> Publish at most n frame records (default ${DEFAULT_MAX_FRAMES})
  --native-demux-worker <path>  Use the isolated native demux process for analyze/compare
  --snapshot-dir <path>  Read/write immutable snapshots (required by index/replay/merge commands)
  --minimum-age-ms <n>  Ignore newer staging transactions (gc-cache only; default ${DEFAULT_CACHE_GC_MINIMUM_AGE_MS})
  --apply          Execute a gc-cache plan (default is dry-run)
  --collection <name>  Snapshot query collection: frames/obus/syntaxNodes/diagnostics
  --filter <json>  Snapshot query filter AST (query only)
  --projection <paths>  Comma-separated dotted paths (query only)
  --limit <n>     Query page size, 1..${MAX_SNAPSHOT_QUERY_LIMIT} (default 100)
  --page-token <token>  Resume the same immutable query
  --csv            Emit comparison, query, or batch rows as CSV
  --help           Show this help
  --version        Show the parser version
`;

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function atomicWrite(destination, contents, { force }) {
  const absolute = path.resolve(destination);
  if (!force && (await exists(absolute))) {
    throw new Error(`output already exists: ${absolute} (use --force to replace)`);
  }
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    temporaryExists = true;
    if (force && process.platform === "win32" && (await exists(absolute))) {
      await unlink(absolute);
    }
    await rename(temporary, absolute);
    temporaryExists = false;
  } finally {
    if (temporaryExists) {
      await unlink(temporary).catch(() => {});
    }
  }
}

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help")) {
    return { action: "help" };
  }
  if (argv.includes("--version")) {
    return { action: "version" };
  }
  if (!["analyze", "batch", "index", "replay-derived", "merge-derived", "replay-overlay", "rebuild-derived-index", "rehearse-recovery", "query", "gc-cache", "compare"].includes(argv[0])) {
    throw new Error(`unknown command: ${argv[0]}`);
  }
  const cacheGc = argv[0] === "gc-cache";
  const snapshotQuery = argv[0] === "query";
  if (!cacheGc && (!argv[1] || argv[1].startsWith("--"))) {
    throw new Error(`${argv[0]} requires an input path`);
  }

  const compare = argv[0] === "compare";
  const batch = argv[0] === "batch";
  const mergeDerived = argv[0] === "merge-derived";
  if (compare && (!argv[2] || argv[2].startsWith("--"))) {
    throw new Error("compare requires reference and candidate paths");
  }

  const options = {
    action: argv[0],
    input: cacheGc ? null : argv[1],
    candidate: compare ? argv[2] : null,
    output: null,
    force: false,
    pretty: true,
    strict: false,
    frameLimit: null,
    maxObus: DEFAULT_MAX_OBUS,
    maxSyntaxNodes: DEFAULT_MAX_SYNTAX_NODES,
    maxFrames: DEFAULT_MAX_FRAMES,
    snapshotDirectory: null,
    derivedSnapshotIds: [],
    csv: false,
    apply: false,
    minimumAgeMs: DEFAULT_CACHE_GC_MINIMUM_AGE_MS,
    queryCollection: null,
    queryFilter: null,
    queryProjection: null,
    queryLimit: 100,
    pageToken: null,
    recursive: false,
    batchExtensions: DEFAULT_BATCH_EXTENSIONS,
    batchJobs: DEFAULT_BATCH_JOBS,
    batchMaxFiles: DEFAULT_BATCH_MAX_FILES,
    batchMaxFileBytes: DEFAULT_BATCH_MAX_FILE_BYTES,
    nativeDemuxWorkerExecutable: null,
  };
  let optionStart = cacheGc ? 1 : compare ? 3 : 2;
  if (mergeDerived) {
    while (optionStart < argv.length && !argv[optionStart].startsWith("--")) {
      options.derivedSnapshotIds.push(argv[optionStart]);
      optionStart += 1;
    }
  }
  for (let index = optionStart; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--output":
        index += 1;
        if (!argv[index] || argv[index].startsWith("--")) {
          throw new Error("--output requires a path");
        }
        options.output = argv[index];
        break;
      case "--force":
        options.force = true;
        break;
      case "--apply":
        if (!cacheGc) throw new Error("--apply is supported only by gc-cache");
        options.apply = true;
        break;
      case "--minimum-age-ms":
        if (!cacheGc) throw new Error("--minimum-age-ms is supported only by gc-cache");
        options.minimumAgeMs = Number(argv[++index]);
        if (!Number.isSafeInteger(options.minimumAgeMs) || options.minimumAgeMs < 0) {
          throw new Error("--minimum-age-ms requires a non-negative safe integer");
        }
        break;
      case "--collection":
        if (!snapshotQuery) throw new Error("--collection is supported only by query");
        options.queryCollection = argv[++index];
        if (!options.queryCollection || options.queryCollection.startsWith("--")) {
          throw new Error("--collection requires a name");
        }
        break;
      case "--filter":
        if (!snapshotQuery) throw new Error("--filter is supported only by query");
        index += 1;
        if (!argv[index] || argv[index].startsWith("--")) {
          throw new Error("--filter requires a JSON value");
        }
        try {
          options.queryFilter = JSON.parse(argv[index]);
        } catch {
          throw new Error("--filter requires valid JSON");
        }
        break;
      case "--projection":
        if (!snapshotQuery) throw new Error("--projection is supported only by query");
        index += 1;
        if (!argv[index] || argv[index].startsWith("--")) {
          throw new Error("--projection requires comma-separated paths");
        }
        options.queryProjection = argv[index].split(",").map((item) => item.trim());
        break;
      case "--limit":
        if (!snapshotQuery) throw new Error("--limit is supported only by query");
        options.queryLimit = Number(argv[++index]);
        if (!Number.isSafeInteger(options.queryLimit) || options.queryLimit < 1 ||
            options.queryLimit > MAX_SNAPSHOT_QUERY_LIMIT) {
          throw new Error(`--limit requires an integer between 1 and ${MAX_SNAPSHOT_QUERY_LIMIT}`);
        }
        break;
      case "--page-token":
        if (!snapshotQuery) throw new Error("--page-token is supported only by query");
        options.pageToken = argv[++index];
        if (!options.pageToken || options.pageToken.startsWith("--")) {
          throw new Error("--page-token requires a token");
        }
        break;
      case "--compact":
        options.pretty = false;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--frames":
        options.frameLimit = Number(argv[++index]);
        if (!Number.isInteger(options.frameLimit) || options.frameLimit <= 0) {
          throw new Error("--frames requires a positive integer");
        }
        break;
      case "--recursive":
        if (!batch) throw new Error("--recursive is supported only by batch");
        options.recursive = true;
        break;
      case "--extensions":
        if (!batch) throw new Error("--extensions is supported only by batch");
        index += 1;
        if (!argv[index] || argv[index].startsWith("--")) {
          throw new Error("--extensions requires a comma-separated list");
        }
        options.batchExtensions = argv[index].split(",").map((item) => item.trim());
        if (options.batchExtensions.some((item) => item.length === 0)) {
          throw new Error("--extensions contains an empty value");
        }
        break;
      case "--jobs":
        if (!batch) throw new Error("--jobs is supported only by batch");
        options.batchJobs = Number(argv[++index]);
        if (!Number.isSafeInteger(options.batchJobs) || options.batchJobs < 1 ||
            options.batchJobs > MAX_BATCH_JOBS) {
          throw new Error(`--jobs requires an integer between 1 and ${MAX_BATCH_JOBS}`);
        }
        break;
      case "--max-files":
        if (!batch) throw new Error("--max-files is supported only by batch");
        options.batchMaxFiles = Number(argv[++index]);
        if (!Number.isSafeInteger(options.batchMaxFiles) || options.batchMaxFiles < 1) {
          throw new Error("--max-files requires a positive safe integer");
        }
        break;
      case "--max-file-bytes":
        if (!batch) throw new Error("--max-file-bytes is supported only by batch");
        options.batchMaxFileBytes = Number(argv[++index]);
        if (!Number.isSafeInteger(options.batchMaxFileBytes) || options.batchMaxFileBytes < 1) {
          throw new Error("--max-file-bytes requires a positive safe integer");
        }
        break;
      case "--max-obus":
        options.maxObus = Number(argv[++index]);
        if (!Number.isSafeInteger(options.maxObus) || options.maxObus <= 0) {
          throw new Error("--max-obus requires a positive safe integer");
        }
        break;
      case "--max-syntax-nodes":
        options.maxSyntaxNodes = Number(argv[++index]);
        if (!Number.isSafeInteger(options.maxSyntaxNodes) || options.maxSyntaxNodes <= 0) {
          throw new Error("--max-syntax-nodes requires a positive safe integer");
        }
        break;
      case "--max-frames":
        options.maxFrames = Number(argv[++index]);
        if (!Number.isSafeInteger(options.maxFrames) || options.maxFrames <= 0) {
          throw new Error("--max-frames requires a positive safe integer");
        }
        break;
      case "--native-demux-worker":
        if (!["analyze", "compare"].includes(options.action)) {
          throw new Error("--native-demux-worker is supported only by analyze/compare");
        }
        index += 1;
        if (!argv[index] || argv[index].startsWith("--")) {
          throw new Error("--native-demux-worker requires a path");
        }
        options.nativeDemuxWorkerExecutable = argv[index];
        break;
      case "--snapshot-dir":
        index += 1;
        if (!argv[index] || argv[index].startsWith("--")) {
          throw new Error("--snapshot-dir requires a path");
        }
        if (compare) throw new Error("--snapshot-dir is not supported by compare");
        options.snapshotDirectory = argv[index];
        break;
      case "--csv":
        options.csv = true;
        break;
      default:
        throw new Error(`unknown option: ${argument}`);
    }
  }
  if (options.action === "index" && !options.snapshotDirectory) {
    throw new Error("index requires --snapshot-dir");
  }
  if (options.action === "replay-derived" && !options.snapshotDirectory) {
    throw new Error("replay-derived requires --snapshot-dir");
  }
  if (["merge-derived", "replay-overlay", "rebuild-derived-index", "rehearse-recovery", "query", "gc-cache"].includes(options.action) &&
      !options.snapshotDirectory) {
    throw new Error(`${options.action} requires --snapshot-dir`);
  }
  if (options.action === "replay-derived" && !/^[0-9a-f]{64}$/.test(options.input)) {
    throw new Error("replay-derived requires a 64-character lowercase SHA-256 ID");
  }
  if (options.action === "merge-derived") {
    if (!/^[0-9a-f]{64}$/.test(options.input)) {
      throw new Error("merge-derived requires a 64-character parent snapshot ID");
    }
    if (options.derivedSnapshotIds.length < 1 ||
        options.derivedSnapshotIds.some((id) => !/^[0-9a-f]{64}$/.test(id))) {
      throw new Error("merge-derived requires one or more 64-character derived syntax IDs");
    }
  }
  if (options.action === "replay-overlay" && !/^[0-9a-f]{64}$/.test(options.input)) {
    throw new Error("replay-overlay requires a 64-character lowercase SHA-256 ID");
  }
  if (options.action === "rebuild-derived-index" && !/^[0-9a-f]{64}$/.test(options.input)) {
    throw new Error("rebuild-derived-index requires a 64-character parent snapshot ID");
  }
  if (options.action === "rehearse-recovery" && !/^[0-9a-f]{64}$/.test(options.input)) {
    throw new Error("rehearse-recovery requires a 64-character parent snapshot ID");
  }
  if (options.action === "query") {
    if (!/^[0-9a-f]{64}$/.test(options.input)) {
      throw new Error("query requires a 64-character snapshot ID");
    }
    if (!options.queryCollection) throw new Error("query requires --collection");
    if (options.csv && !options.queryProjection) {
      throw new Error("query --csv requires --projection");
    }
  }
  if (options.action === "index" && (options.output || options.csv)) {
    throw new Error("index writes a snapshot reference to stdout and does not support --output/--csv");
  }
  if (options.action === "gc-cache" && options.csv) {
    throw new Error("gc-cache does not support --csv");
  }
  if (!["batch", "compare", "query"].includes(options.action) && options.csv) {
    throw new Error(`${options.action} does not support --csv`);
  }
  return options;
}

function comparisonCsv(report) {
  const rows = ["frame_index,pixel_count,identical,mae,mse,psnr,ssim,max_absolute_error"];
  for (const frame of report.frames) {
    rows.push([
      frame.frameIndex,
      frame.pixelCount,
      frame.identical,
      frame.mae,
      frame.mse,
      frame.psnr ?? "inf",
      frame.ssim,
      frame.maximumAbsoluteError,
    ].join(","));
  }
  return `${rows.join("\n")}\n`;
}

function csvCell(value) {
  const encoded = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(encoded) ? `"${encoded.replaceAll('"', '""')}"` : encoded;
}

function queryCsv(page) {
  const columns = page.projection;
  const rows = [["source_offset", ...columns].join(",")];
  for (const item of page.records) {
    rows.push([item.sourceOffset, ...columns.map((path) => csvCell(item.record[path]))].join(","));
  }
  return `${rows.join("\n")}\n`;
}

function batchCsv(report) {
  const columns = [
    "relative_path", "sha256", "byte_length", "status", "format", "complete",
    "frame_count", "obu_count", "syntax_node_count", "error_count", "warning_count",
    "tile_group_count", "tile_count", "snapshot_id", "failure_code",
  ];
  const rows = [columns.join(",")];
  for (const file of report.files) {
    rows.push([
      file.relativePath,
      file.sha256,
      file.byteLength,
      file.status,
      file.format,
      file.complete,
      file.frameCount,
      file.obuCount,
      file.syntaxNodeCount,
      file.errorCount,
      file.warningCount,
      file.tileGroupCount,
      file.tileCount,
      file.snapshotId,
      file.failure?.code,
    ].map(csvCell).join(","));
  }
  return `${rows.join("\n")}\n`;
}

export async function runCli(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  const options = parseArguments(argv);
  if (options.action === "help") {
    stdout.write(HELP);
    return 0;
  }
  if (options.action === "version") {
    stdout.write(`${PARSER_VERSION}\n`);
    return 0;
  }

  if (options.action === "batch") {
    const report = await analyzeBatchDirectory(options.input, {
      recursive: options.recursive,
      extensions: options.batchExtensions,
      jobs: options.batchJobs,
      maxFiles: options.batchMaxFiles,
      maxFileBytes: options.batchMaxFileBytes,
      maxObus: options.maxObus,
      maxSyntaxNodes: options.maxSyntaxNodes,
      maxFrames: options.maxFrames,
      snapshotDirectory: options.snapshotDirectory,
      onFailure: (input, error) => {
        stderr.write(`batch failed ${input.relativePath}: ${error.code ?? error.name ?? "ANALYSIS_FAILED"}\n`);
      },
    });
    const output = options.csv
      ? batchCsv(report)
      : stringifyCanonical(report, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, output, { force: options.force });
    else stdout.write(output);
    stderr.write(
      `batch ${report.summary.matchedFileCount} files: ${report.summary.okFileCount} ok, ${report.summary.diagnosticFileCount} with diagnostics, ${report.summary.failedFileCount} failed\n`,
    );
    if (report.summary.failedFileCount > 0) return 1;
    if (options.strict && report.summary.totalErrors > 0) return 2;
    return 0;
  }

  if (options.action === "index") {
    const snapshot = await writeReportSnapshotStream(
      await createFileSnapshotInput(options.input, {
        maxFrames: options.maxFrames,
        maxObus: options.maxObus,
      }),
      options.snapshotDirectory,
    );
    const result = {
      schemaVersion: 1,
      kind: "av1scope-streaming-index",
      snapshotId: snapshot.snapshotId,
      directory: snapshot.directory,
      created: snapshot.created,
      source: snapshot.manifest.header.source,
      summary: snapshot.manifest.header.summary,
      collections: Object.fromEntries(Object.entries(snapshot.manifest.collections)
        .map(([name, descriptor]) => [name, descriptor.count])),
    };
    stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
    stderr.write(
      `snapshot ${snapshot.snapshotId} ${snapshot.created ? "created" : "reused"} at ${snapshot.directory}\n`,
    );
    return options.strict && result.summary.errorCount > 0 ? 2 : 0;
  }
  if (options.action === "replay-derived") {
    if (options.csv) throw new Error("replay-derived does not support --csv");
    const manifest = await readDerivedSyntaxSnapshot(
      options.snapshotDirectory, options.input,
    );
    const json = stringifyCanonical(manifest, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, json, { force: options.force });
    else stdout.write(json);
    stderr.write(`derived syntax ${options.input} verified against parent ${manifest.parentSnapshotId}\n`);
    return 0;
  }
  if (options.action === "merge-derived") {
    if (options.csv) throw new Error("merge-derived does not support --csv");
    const result = await writeSyntaxOverlaySnapshot(options.snapshotDirectory, {
      parentSnapshotId: options.input,
      derivedSnapshotIds: options.derivedSnapshotIds,
    }, { returnDocument: true });
    const json = stringifyCanonical(result.manifest, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, json, { force: options.force });
    else stdout.write(json);
    stderr.write(
      `syntax overlay ${result.overlaySnapshotId} ${result.created ? "created" : "reused"} from ${options.derivedSnapshotIds.length} derived snapshots\n`,
    );
    return 0;
  }
  if (options.action === "replay-overlay") {
    if (options.csv) throw new Error("replay-overlay does not support --csv");
    const manifest = await readSyntaxOverlaySnapshot(options.snapshotDirectory, options.input);
    const json = stringifyCanonical(manifest, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, json, { force: options.force });
    else stdout.write(json);
    stderr.write(`syntax overlay ${options.input} verified against parent ${manifest.parentSnapshotId}\n`);
    return 0;
  }
  if (options.action === "rebuild-derived-index") {
    if (options.csv) throw new Error("rebuild-derived-index does not support --csv");
    const index = await rebuildDerivedSyntaxIndex(options.snapshotDirectory, options.input);
    const json = stringifyCanonical(index, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, json, { force: options.force });
    else stdout.write(json);
    stderr.write(`derived syntax index ${index.indexId} rebuilt with ${index.entries.length} entries\n`);
    return 0;
  }
  if (options.action === "rehearse-recovery") {
    const report = await rehearseSnapshotCacheRecovery(
      options.snapshotDirectory, options.input,
    );
    const json = stringifyCanonical(report, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, json, { force: options.force });
    else stdout.write(json);
    stderr.write(
      `cache recovery rehearsal ${report.checkpointId} passed in an isolated clone; source store unchanged\n`,
    );
    return 0;
  }
  if (options.action === "gc-cache") {
    const result = await garbageCollectSnapshotCache(options.snapshotDirectory, {
      apply: options.apply,
      minimumAgeMs: options.minimumAgeMs,
    });
    const json = stringifyCanonical(result, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, json, { force: options.force });
    else stdout.write(json);
    stderr.write(
      `cache GC ${result.planId} ${result.mode}: ${result.summary.candidateCount} candidates, ${result.removedCount} removed; content snapshots retained\n`,
    );
    return 0;
  }
  if (options.action === "query") {
    const page = await querySnapshot(options.snapshotDirectory, options.input, {
      collection: options.queryCollection,
      filter: options.queryFilter,
      projection: options.queryProjection,
      limit: options.queryLimit,
      pageToken: options.pageToken,
    });
    const output = options.csv
      ? queryCsv(page)
      : stringifyCanonical(page, { pretty: options.pretty });
    if (options.output) await atomicWrite(options.output, output, { force: options.force });
    else stdout.write(output);
    stderr.write(
      `snapshot query ${page.queryId}: ${page.matchedCount} matches, ${page.scannedCount} scanned${page.nextPageToken ? "; more pages available" : "; complete"}\n`,
    );
    return 0;
  }
  const input = await readFile(options.input);
  if (options.action === "compare") {
    const candidate = await readFile(options.candidate);
    const [referenceReport, candidateReport] = await Promise.all([
      analyzeMediaBuffer(input, {
        sourceName: options.input, maxObus: options.maxObus,
        maxSyntaxNodes: options.maxSyntaxNodes, maxFrames: options.maxFrames,
        nativeDemuxWorkerExecutable: options.nativeDemuxWorkerExecutable,
      }),
      analyzeMediaBuffer(candidate, {
        sourceName: options.candidate, maxObus: options.maxObus,
        maxSyntaxNodes: options.maxSyntaxNodes, maxFrames: options.maxFrames,
        nativeDemuxWorkerExecutable: options.nativeDemuxWorkerExecutable,
      }),
    ]);
    const frameCount = Math.min(
      referenceReport.summary.frameCount,
      candidateReport.summary.frameCount,
      options.frameLimit ?? Number.MAX_SAFE_INTEGER,
    );
    if (frameCount === 0) throw new Error("comparison inputs have no aligned frames");
    if (referenceReport.container?.width !== candidateReport.container?.width ||
        referenceReport.container?.height !== candidateReport.container?.height) {
      throw new Error("comparison inputs have different dimensions");
    }
    const frames = [];
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      frames.push(await compareVideoFrames(input, candidate, frameIndex));
    }
    const finitePsnr = frames.map(({ psnr }) => psnr).filter((value) => value !== null);
    const report = {
      schemaVersion: 1,
      kind: "av1scope-frame-comparison",
      reference: referenceReport.source,
      candidate: candidateReport.source,
      metricProvenance: {
        implementation: "av1scope-node-reference",
        pixelFormat: "8-bit grayscale via FFmpeg",
        ssim: "whole-frame global SSIM",
      },
      frames,
      summary: {
        frameCount,
        identicalFrameCount: frames.filter(({ identical }) => identical).length,
        meanMae: frames.reduce((sum, { mae }) => sum + mae, 0) / frameCount,
        meanPsnr: finitePsnr.length ? finitePsnr.reduce((sum, value) => sum + value, 0) / finitePsnr.length : null,
        meanSsim: frames.reduce((sum, { ssim }) => sum + ssim, 0) / frameCount,
      },
    };
    const output = options.csv ? comparisonCsv(report) : `${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`;
    if (options.output) await atomicWrite(options.output, output, { force: options.force });
    else stdout.write(output);
    return 0;
  }
  const report = await analyzeMediaBuffer(input, {
    sourceName: options.input, maxObus: options.maxObus,
    maxSyntaxNodes: options.maxSyntaxNodes, maxFrames: options.maxFrames,
    nativeDemuxWorkerExecutable: options.nativeDemuxWorkerExecutable,
  });
  const json = stringifyReport(report, { pretty: options.pretty });
  if (options.snapshotDirectory) {
    const snapshot = await writeReportSnapshot(report, options.snapshotDirectory);
    stderr.write(
      `snapshot ${snapshot.snapshotId} ${snapshot.created ? "created" : "reused"} at ${snapshot.directory}\n`,
    );
  }
  if (options.output) {
    await atomicWrite(options.output, json, { force: options.force });
  } else {
    stdout.write(json);
  }

  const hasErrors = report.diagnostics.some(
    ({ severity }) => severity === Severity.ERROR || severity === Severity.FATAL,
  );
  if (options.strict && hasErrors) {
    stderr.write(
      `analysis completed with ${report.summary.errorCount} error/fatal diagnostics\n`,
    );
    return 2;
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    process.exitCode = await runCli(argv);
  } catch (error) {
    process.stderr.write(`av1scope: ${error.message}\n`);
    process.exitCode = 1;
  }
}
