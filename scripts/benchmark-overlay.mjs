import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { analyzeBuffer } from "../src/analyzer.js";
import { writeDerivedSyntaxSnapshot } from "../src/derived-syntax-store.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { writeSyntaxOverlaySnapshot } from "../src/syntax-overlay-store.js";

const derivedCount = Number(process.env.AV1SCOPE_OVERLAY_BENCH_DERIVED ?? 100);
const nodesPerDerived = Number(process.env.AV1SCOPE_OVERLAY_BENCH_NODES ?? 500);
if (!Number.isSafeInteger(derivedCount) || derivedCount < 1 ||
    !Number.isSafeInteger(nodesPerDerived) || nodesPerDerived < 1) {
  throw new Error("overlay benchmark sizes must be positive safe integers");
}
if (derivedCount * nodesPerDerived > 500_000) {
  throw new Error("overlay benchmark exceeds the 500,000-node contract budget");
}

const unit = Buffer.from([0x7a, 0x18, ...Buffer.alloc(24, 0x55)]);
const input = Buffer.concat(Array(derivedCount).fill(unit));
const report = analyzeBuffer(input, { maxObus: derivedCount });
const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-overlay-benchmark-"));

async function measure(operation) {
  globalThis.gc?.();
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  let peakHeapBytes = baselineHeapBytes;
  const sampler = setInterval(() => {
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
  }, 1);
  const started = performance.now();
  try {
    const result = await operation();
    peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    return {
      result,
      elapsedMs: performance.now() - started,
      baselineHeapBytes,
      peakHeapBytes,
      peakHeapDeltaBytes: peakHeapBytes - baselineHeapBytes,
    };
  } finally {
    clearInterval(sampler);
  }
}

try {
  const parent = await writeReportSnapshot(report, root);
  const derivedSnapshotIds = [];
  for (const record of report.obus) {
    const payload = input.subarray(
      record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length,
    );
    const nodes = Array.from({ length: nodesPerDerived }, (_, nodeId) => ({
      nodeId,
      parentId: null,
      name: `synthetic_field_${nodeId}`,
      path: `obus[${record.obuId}].synthetic[${nodeId}]`,
      value: nodeId,
      valueType: "integer",
      bitRange: { start: record.payloadRange.start * 8, length: 1 },
      byteRange: { start: record.payloadRange.start, length: 1 },
    }));
    const derived = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection: {
        schemaVersion: 1,
        kind: "av1scope-snapshot-syntax-inspection",
        obuId: record.obuId,
        type: record.type,
        payloadRange: record.payloadRange,
        inspectedPayloadBytes: payload.length,
        status: "complete",
        nodes,
        diagnostics: [],
      },
    });
    derivedSnapshotIds.push(derived.derivedSnapshotId);
  }

  const created = await measure(() => writeSyntaxOverlaySnapshot(root, {
    parentSnapshotId: parent.snapshotId,
    derivedSnapshotIds,
  }));
  const reused = await measure(() => writeSyntaxOverlaySnapshot(root, {
    parentSnapshotId: parent.snapshotId,
    derivedSnapshotIds,
  }));
  if (!created.result.created || reused.result.created ||
      created.result.overlaySnapshotId !== reused.result.overlaySnapshotId ||
      created.result.manifest !== null || reused.result.manifest !== null) {
    throw new Error("overlay benchmark did not exercise streaming create/reuse paths");
  }
  process.stdout.write(`${JSON.stringify({
    runtime: process.version,
    platform: `${process.platform}-${process.arch}`,
    sampleMode: globalThis.gc ? "pre-gc-with-1ms-sampler" : "natural-heap-with-1ms-sampler",
    derivedCount,
    nodesPerDerived,
    totalNodes: derivedCount * nodesPerDerived,
    chunkSize: created.result.storageManifest.chunkSize,
    chunkCount: created.result.storageManifest.collections.syntaxNodes.chunks.length,
    create: {
      elapsedMs: created.elapsedMs,
      peakHeapDeltaBytes: created.peakHeapDeltaBytes,
    },
    reuseVerification: {
      elapsedMs: reused.elapsedMs,
      peakHeapDeltaBytes: reused.peakHeapDeltaBytes,
    },
  }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
