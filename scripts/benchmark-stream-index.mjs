import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createFileSnapshotInput } from "../src/file-indexer.js";
import { writeReportSnapshotStream } from "../src/snapshot-store.js";

function encodeLeb128(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

const sourceBytes = Number(process.env.AV1SCOPE_STREAM_BENCH_BYTES ?? 1024 ** 3);
if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 16) {
  throw new Error("AV1SCOPE_STREAM_BENCH_BYTES must be a safe integer >= 16");
}

const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-stream-benchmark-"));
const inputPath = path.join(directory, "sparse-1g.obu");
const snapshotRoot = path.join(directory, "snapshots");
const denseObuCount = Number(process.env.AV1SCOPE_STREAM_BENCH_OBUS ?? 100_000);

try {
  const handle = await open(inputPath, "wx");
  const sizeField = encodeLeb128(sourceBytes - 1 - 5);
  if (sizeField.length !== 5) throw new Error("benchmark expects a five-byte size field");
  await handle.write(Buffer.concat([Buffer.from([0x7a]), sizeField]), 0, 6, 0);
  await handle.truncate(sourceBytes);
  await handle.close();

  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const snapshot = await writeReportSnapshotStream(
    await createFileSnapshotInput(inputPath), snapshotRoot,
  );
  const elapsedMs = performance.now() - started;
  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  const densePath = path.join(directory, "dense.obu");
  const denseUnit = Buffer.from([0x7a, 0x18, ...Buffer.alloc(24, 0x55)]);
  await writeFile(densePath, Buffer.concat(Array(denseObuCount).fill(denseUnit)));
  globalThis.gc?.();
  const denseHeapBefore = process.memoryUsage().heapUsed;
  const denseStarted = performance.now();
  const denseSnapshot = await writeReportSnapshotStream(
    await createFileSnapshotInput(densePath, { maxObus: denseObuCount }), snapshotRoot,
  );
  const denseElapsedMs = performance.now() - denseStarted;
  globalThis.gc?.();
  const denseHeapAfter = process.memoryUsage().heapUsed;
  const ivfPath = path.join(directory, "sparse-1g.ivf");
  const ivfHeader = Buffer.alloc(32);
  ivfHeader.write("DKIF", 0, "ascii");
  ivfHeader.writeUInt16LE(0, 4);
  ivfHeader.writeUInt16LE(32, 6);
  ivfHeader.write("AV01", 8, "ascii");
  ivfHeader.writeUInt16LE(1920, 12);
  ivfHeader.writeUInt16LE(1080, 14);
  ivfHeader.writeUInt32LE(30, 16);
  ivfHeader.writeUInt32LE(1, 20);
  ivfHeader.writeUInt32LE(1, 24);
  const framePayloadBytes = sourceBytes - 32 - 12;
  const frameHeader = Buffer.alloc(12);
  frameHeader.writeUInt32LE(framePayloadBytes, 0);
  const ivfObuSize = encodeLeb128(framePayloadBytes - 1 - 5);
  const ivfHandle = await open(ivfPath, "wx");
  const ivfPrefix = Buffer.concat([ivfHeader, frameHeader, Buffer.from([0x7a]), ivfObuSize]);
  await ivfHandle.write(ivfPrefix, 0, ivfPrefix.length, 0);
  await ivfHandle.truncate(sourceBytes);
  await ivfHandle.close();
  globalThis.gc?.();
  const ivfHeapBefore = process.memoryUsage().heapUsed;
  const ivfStarted = performance.now();
  const ivfSnapshot = await writeReportSnapshotStream(
    await createFileSnapshotInput(ivfPath), snapshotRoot,
  );
  const ivfElapsedMs = performance.now() - ivfStarted;
  globalThis.gc?.();
  const ivfHeapAfter = process.memoryUsage().heapUsed;
  process.stdout.write(`${JSON.stringify({
    runtime: process.version,
    platform: `${process.platform}-${process.arch}`,
    sparseFixture: true,
    sourceBytes,
    sourceGiB: sourceBytes / 1024 ** 3,
    obuCount: snapshot.manifest.collections.obus.count,
    elapsedMs,
    heapDeltaMiB: (heapAfter - heapBefore) / 1024 ** 2,
    snapshotId: snapshot.snapshotId,
    dense: {
      sourceBytes: denseUnit.length * denseObuCount,
      obuCount: denseSnapshot.manifest.collections.obus.count,
      chunkCount: denseSnapshot.manifest.collections.obus.chunks.length,
      elapsedMs: denseElapsedMs,
      heapDeltaMiB: (denseHeapAfter - denseHeapBefore) / 1024 ** 2,
    },
    ivf: {
      sourceBytes,
      frameCount: ivfSnapshot.manifest.collections.frames.count,
      obuCount: ivfSnapshot.manifest.collections.obus.count,
      elapsedMs: ivfElapsedMs,
      heapDeltaMiB: (ivfHeapAfter - ivfHeapBefore) / 1024 ** 2,
    },
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
