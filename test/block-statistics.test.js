import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  buildQindexHistogram,
  calculateRectangleCoverage,
  categoricalBlockDistribution,
  filterBlockRecords,
  numericBlockSummary,
  summarizeBlockStatistics,
} from "../public/block-statistics.js";

const blocks = [
  { blockId: 0, plane: 0, x: 0, y: 0, width: 8, height: 8, mode: "intra", partition: "none", segmentId: 0, skip: false, qindex: 0, quantDelta: 0, coeffNonZero: 4, txSize: "TX_8X8", intraMode: "DC", refs: [], mv: [] },
  { blockId: 1, plane: 0, x: 8, y: 0, width: 8, height: 8, mode: "inter", partition: "split", segmentId: 1, skip: true, qindex: 255, quantDelta: -4, coeffNonZero: 0, txSize: null, interMode: "NEWMV", compoundType: "AVG", refs: [0, 3], mv: [{ x: 8, y: 0, precision: "1/8 pel" }, { x: 0, y: 0, precision: "1/8 pel" }] },
  { blockId: 2, plane: 1, x: 0, y: 0, width: 4, height: 4, mode: "intra", partition: "none", qindex: 42, quantDelta: 2, coeffNonZero: 1, refs: [], mv: [] },
];

test("rectangle coverage distinguishes summed, union, overlap and duplicate areas", () => {
  const nonOverlapping = calculateRectangleCoverage(blocks.slice(0, 2), { frameWidth: 16, frameHeight: 8 });
  assert.deepEqual({
    sumArea: nonOverlapping.sumArea,
    coveredArea: nonOverlapping.coveredArea,
    overlapArea: nonOverlapping.overlapArea,
    duplicateArea: nonOverlapping.duplicateArea,
    coverageRatio: nonOverlapping.coverageRatio,
  }, { sumArea: 128, coveredArea: 128, overlapArea: 0, duplicateArea: 0, coverageRatio: 1 });

  const overlapping = calculateRectangleCoverage([
    { x: 0, y: 0, width: 8, height: 8 },
    { x: 4, y: 0, width: 8, height: 8 },
  ], { frameWidth: 12, frameHeight: 8 });
  assert.equal(overlapping.sumArea, 128);
  assert.equal(overlapping.coveredArea, 96);
  assert.equal(overlapping.overlapArea, 32);
  assert.equal(overlapping.duplicateArea, 32);
  assert.equal(overlapping.coverageRatio, 1);
});

test("rectangle coverage reports a bounded exactness status", () => {
  const result = calculateRectangleCoverage(blocks.slice(0, 2), { recordLimit: 1 });
  assert.equal(result.status, "record-budget-exceeded");
  assert.equal(result.coveredArea, null);
  assert.equal(result.sumArea, 128);
});

test("block statistics isolate luma records and preserve zero, 255 and missing values", () => {
  const summary = summarizeBlockStatistics(blocks, { frameWidth: 16, frameHeight: 8 });
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.lumaRecordCount, 2);
  assert.equal(summary.nonLumaRecordCount, 1);
  assert.equal(summary.coverage.coverageRatio, 1);
  assert.equal(summary.qindex.minimum, 0);
  assert.equal(summary.qindex.maximum, 255);
  assert.equal(summary.qindex.missingCount, 0);
  assert.equal(summary.quantDelta.zeroCount, 1);
  assert.equal(summary.quantDelta.negativeCount, 1);
  assert.equal(summary.coefficients.sum, 4);
  assert.equal(summary.skipCount, 1);
  assert.equal(summary.motion.compoundBlockCount, 1);
  assert.deepEqual(summary.distributions.referenceSlot.items.map(({ label }) => label), ["0", "3"]);
});

test("categorical and numeric summaries expose missing records independently", () => {
  const categorical = categoricalBlockDistribution(blocks.slice(0, 2), (block) => block.txSize);
  assert.equal(categorical.knownCount, 1);
  assert.equal(categorical.missingCount, 1);
  const numeric = numericBlockSummary(blocks.slice(0, 2), (block) => block.unknown);
  assert.equal(numeric.knownCount, 0);
  assert.equal(numeric.missingCount, 2);
  assert.equal(numeric.mean, null);
  const histogram = buildQindexHistogram(blocks.slice(0, 2));
  assert.equal(histogram.bins[0].count, 1);
  assert.equal(histogram.bins[15].count, 1);
});

test("block visibility filters use luma by default and preserve explicit all-plane access", () => {
  assert.equal(filterBlockRecords(blocks, "all").length, 2);
  assert.equal(filterBlockRecords(blocks, "all-planes").length, 3);
  assert.deepEqual(filterBlockRecords(blocks, "inter").map(({ blockId }) => blockId), [1]);
  assert.deepEqual(filterBlockRecords(blocks, "compound").map(({ blockId }) => blockId), [1]);
  assert.deepEqual(filterBlockRecords(blocks, "motion").map(({ blockId }) => blockId), [1]);
  assert.deepEqual(filterBlockRecords(blocks, "coeff").map(({ blockId }) => blockId), [0]);
});

test("block statistics preserve real libaom Golden overlap and sparse coverage semantics", async () => {
  const root = new URL("fixtures/libaom-v3.12.1/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  let frameCount = 0;
  let blockCount = 0;
  let framesWithOverlap = 0;
  let framesWithIncompleteCoverage = 0;
  let q255Count = 0;
  for (const item of manifest.cases) {
    const encoded = (await readFile(new URL(item.expectedOverlayFile, root), "utf8")).trim();
    const overlay = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")));
    for (const frame of overlay.frames) {
      const summary = summarizeBlockStatistics(frame.blocks, {
        frameWidth: item.width,
        frameHeight: item.height,
      });
      frameCount += 1;
      blockCount += summary.lumaRecordCount;
      if (summary.coverage.overlapArea > 0) framesWithOverlap += 1;
      if (summary.coverage.coverageRatio < 1) framesWithIncompleteCoverage += 1;
      q255Count += frame.blocks.filter(({ qindex }) => qindex === 255).length;
    }
  }
  assert.equal(frameCount, 32);
  assert.equal(blockCount, 1_086);
  assert.ok(framesWithOverlap > 0);
  assert.ok(framesWithIncompleteCoverage > 0);
  assert.ok(q255Count > 0);
});
