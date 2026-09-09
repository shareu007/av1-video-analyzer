import { performance } from "node:perf_hooks";

import { analyzeBuffer } from "../src/analyzer.js";
import { validateBlockOverlayDocument } from "../src/block-overlay.js";
import { buildBlockInstanceData, buildMotionVectorInstanceData } from "../public/block-renderer.js";
import { summarizeBlockStatistics } from "../public/block-statistics.js";

function encodeLeb128(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function makePaddingStream(count, payloadBytes) {
  const payload = Buffer.alloc(payloadBytes, 0x55);
  const obu = Buffer.concat([Buffer.from([0x7a]), encodeLeb128(payload.length), payload]);
  return Buffer.concat(Array(count).fill(obu));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function measure(run, iterations = 10, beforeEach = null) {
  const times = [];
  for (let index = 0; index < iterations + 2; index += 1) {
    beforeEach?.();
    const started = performance.now();
    run();
    const elapsed = performance.now() - started;
    if (index >= 2) times.push(elapsed);
  }
  return {
    medianMs: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    minimumMs: Math.min(...times),
    maximumMs: Math.max(...times),
  };
}

export function runBenchmark({
  obuCount = Number(process.env.AV1SCOPE_BENCH_OBUS ?? 10_000),
  blockCount = Number(process.env.AV1SCOPE_BENCH_BLOCKS ?? 100_000),
  isolateSamples = false,
} = {}) {
  const beforeEach = isolateSamples && globalThis.gc ? () => globalThis.gc() : null;
  const stream = makePaddingStream(obuCount, 24);
  const indexTiming = measure(() => {
    const report = analyzeBuffer(stream);
    if (report.obus.length !== obuCount) throw new Error("benchmark OBU count mismatch");
  }, 10, beforeEach);
  const budgetStream = makePaddingStream(10_001, 24);
  const budgetStarted = performance.now();
  const budgetReport = analyzeBuffer(budgetStream, { maxObus: 10_000 });
  const budgetElapsed = performance.now() - budgetStarted;
  if (budgetReport.obus.length !== 10_000 ||
      !budgetReport.diagnostics.some(({ code }) => code === "OBU_RECORD_LIMIT_REACHED")) {
    throw new Error("resource-budget benchmark did not stop at the configured OBU limit");
  }
  const columns = 400;
  const overlay = {
    schemaVersion: 1,
    provenance: { producer: "benchmark" },
    frames: [{
      frameId: 0,
      blocks: Array.from({ length: blockCount }, (_, index) => ({
        x: (index % columns) * 4,
        y: Math.floor(index / columns) * 4,
        width: 4,
        height: 4,
        mode: index % 3 === 0 ? "intra" : "inter",
        qindex: index % 256,
        refs: index % 3 === 0 ? [] : index % 7 === 0 ? [index % 8, (index + 3) % 8] : [index % 8],
        mv: index % 3 === 0 ? [] : index % 7 === 0
          ? [{ x: index % 31 + 1, y: -(index % 17 + 1), precision: "1/8 pel" }, { x: -(index % 23 + 1), y: index % 13 + 1, precision: "1/8 pel" }]
          : [{ x: index % 31 + 1, y: -(index % 17 + 1), precision: "1/8 pel" }],
      })),
    }],
  };
  const overlayReport = {
    container: { width: columns * 4, height: Math.ceil(blockCount / columns) * 4 },
    frames: [{ frameId: 0 }],
  };
  const overlayTiming = measure(() => {
    const result = validateBlockOverlayDocument(overlay, overlayReport);
    if (result.frames[0].blocks.length !== blockCount) throw new Error("benchmark block count mismatch");
  }, 20, beforeEach);
  const normalizedBlocks = validateBlockOverlayDocument(overlay, overlayReport).frames[0].blocks;
  const instanceTiming = measure(() => {
    const data = buildBlockInstanceData(normalizedBlocks, { layer: "qindex", opacity: 0.28 });
    if (data.rects.length !== blockCount * 4 || data.colors.length !== blockCount * 4) {
      throw new Error("benchmark instance buffer length mismatch");
    }
  }, 10, beforeEach);
  const expectedMotionVectorCount = normalizedBlocks.reduce((sum, block) => sum + block.mv.length, 0);
  const motionVectorTiming = measure(() => {
    const data = buildMotionVectorInstanceData(normalizedBlocks, { scale: 4, opacity: 0.75 });
    if (data.count !== expectedMotionVectorCount || data.vectors.length !== expectedMotionVectorCount * 4 ||
        data.colors.length !== expectedMotionVectorCount * 4) {
      throw new Error("benchmark motion-vector buffer length mismatch");
    }
  }, 10, beforeEach);
  const blockStatisticsTiming = measure(() => {
    const result = summarizeBlockStatistics(normalizedBlocks, {
      frameWidth: overlayReport.container.width,
      frameHeight: overlayReport.container.height,
    });
    if (result.lumaRecordCount !== blockCount || result.coverage.status !== "exact" ||
        result.coverage.coverageRatio !== 1) {
      throw new Error("benchmark block statistics mismatch");
    }
  }, 5, beforeEach);
  return {
    runtime: process.version,
    platform: `${process.platform}-${process.arch}`,
    sampleMode: beforeEach ? "isolated-pre-gc" : "natural-heap",
    obuIndex: {
      obuCount,
      inputBytes: stream.length,
      throughputMiBPerSecond: stream.length / 1024 / 1024 / (indexTiming.medianMs / 1000),
      ...indexTiming,
    },
    blockOverlayValidation: { blockCount, ...overlayTiming },
    blockInstanceBuffers: {
      blockCount,
      bytes: blockCount * 4 * Float32Array.BYTES_PER_ELEMENT * 2,
      ...instanceTiming,
    },
    motionVectorInstanceBuffers: {
      blockCount,
      vectorCount: expectedMotionVectorCount,
      allocatedBytes: blockCount * 2 * 4 * Float32Array.BYTES_PER_ELEMENT * 2,
      activeBytes: expectedMotionVectorCount * 4 * Float32Array.BYTES_PER_ELEMENT * 2,
      ...motionVectorTiming,
    },
    blockStatistics: {
      blockCount,
      coverageMode: "exact-rectangle-union",
      ...blockStatisticsTiming,
    },
    resourceBudget: {
      inputObuCount: 10_001,
      publishedObuCount: budgetReport.obus.length,
      complete: budgetReport.summary.complete,
      elapsedMs: budgetElapsed,
    },
  };
}

export function performanceBudgetFailures(result) {
  const budgets = {
    "obuIndex.p95Ms": Number(process.env.AV1SCOPE_BUDGET_OBU_P95_MS ?? 80),
    "blockOverlayValidation.p95Ms": Number(process.env.AV1SCOPE_BUDGET_BLOCK_P95_MS ?? 150),
    "blockInstanceBuffers.p95Ms": Number(process.env.AV1SCOPE_BUDGET_INSTANCE_P95_MS ?? 30),
    "motionVectorInstanceBuffers.p95Ms": Number(process.env.AV1SCOPE_BUDGET_MV_INSTANCE_P95_MS ?? 60),
    "blockStatistics.p95Ms": Number(process.env.AV1SCOPE_BUDGET_BLOCK_STATISTICS_P95_MS ?? 500),
  };
  return Object.entries(budgets).flatMap(([path, budget]) => {
    const [section, metric] = path.split(".");
    const actual = result[section][metric];
    return actual > budget ? [`${path} ${actual.toFixed(2)} ms > ${budget.toFixed(2)} ms`] : [];
  });
}
