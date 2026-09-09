import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { analyzeBuffer } from "../src/analyzer.js";
import {
  readReportSnapshot,
  readSnapshotPage,
  writeReportSnapshot,
} from "../src/snapshot-store.js";

const obuCount = Number(process.env.AV1SCOPE_SNAPSHOT_BENCH_OBUS ?? 10_000);
if (!Number.isSafeInteger(obuCount) || obuCount < 1) {
  throw new Error("AV1SCOPE_SNAPSHOT_BENCH_OBUS must be a positive safe integer");
}

const unit = Buffer.from([0x7a, 0x18, ...Buffer.alloc(24, 0x55)]);
const report = analyzeBuffer(Buffer.concat(Array(obuCount).fill(unit)), { maxObus: obuCount });
const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshot-benchmark-"));

try {
  const writeStarted = performance.now();
  const snapshot = await writeReportSnapshot(report, root);
  const writeMs = performance.now() - writeStarted;

  const pageStarted = performance.now();
  const page = await readSnapshotPage(root, snapshot.snapshotId, "obus", {
    offset: Math.max(0, obuCount - 1_000),
    limit: Math.min(1_000, obuCount),
  });
  const pageReadMs = performance.now() - pageStarted;

  const rebuildStarted = performance.now();
  const rebuilt = await readReportSnapshot(root, snapshot.snapshotId);
  const rebuildMs = performance.now() - rebuildStarted;
  if (rebuilt.obus.length !== obuCount || page.records.length !== Math.min(1_000, obuCount)) {
    throw new Error("snapshot benchmark record count mismatch");
  }

  const files = await readdir(snapshot.directory);
  let storageBytes = 0;
  for (const file of files) storageBytes += (await stat(path.join(snapshot.directory, file))).size;
  process.stdout.write(`${JSON.stringify({
    runtime: process.version,
    platform: `${process.platform}-${process.arch}`,
    filesystemRoot: os.tmpdir(),
    obuCount,
    chunkSize: snapshot.manifest.chunkSize,
    chunkCount: snapshot.manifest.collections.obus.chunks.length,
    storageBytes,
    writeMs,
    pageReadMs,
    rebuildMs,
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
