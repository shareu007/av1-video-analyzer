import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBlockGoldenCoverage,
  REQUIRED_BLOCK_GOLDEN_COVERAGE,
  validateBlockGoldenManifest,
} from "../src/block-golden.js";

const hex = (value) => value.repeat(64);

function goldenManifest() {
  return {
    schemaVersion: 1,
    kind: "av1scope-block-golden-suite",
    buildId: "a".repeat(40),
    coverage: [...REQUIRED_BLOCK_GOLDEN_COVERAGE].reverse(),
    cases: [{
      name: "all-tools",
      sourceLicense: "CC0-1.0",
      inputFile: "media/all-tools.ivf",
      inputSha256: hex("1"),
      expectedOverlayFile: "expected/all-tools.json",
      expectedOverlaySha256: hex("2"),
      width: 64,
      height: 64,
      frames: [{ frameId: 0, payloadRange: { start: 32, length: 100 } }],
    }],
  };
}

function coveredOverlay() {
  return {
    frames: [{ frameId: 0, blocks: [{
      partition: "split",
      mode: "intra",
      segmentId: 1,
      qindex: 255,
      refs: [],
      mv: [],
      txSize: "TX_8X8",
      txType: "DCT_DCT",
      coeffNonZero: 3,
      filter: "lf=4",
      miRow: 0,
      miColumn: 0,
      compoundType: null,
      quantDelta: 163,
    }, {
      partition: "none",
      mode: "inter",
      segmentId: null,
      qindex: 92,
      refs: [0, 1],
      mv: [{ x: 2, y: 3 }],
      txSize: null,
      txType: null,
      coeffNonZero: null,
      filter: null,
      miRow: 0,
      miColumn: 2,
      compoundType: "COMPOUND_1",
      quantDelta: 0,
    }] }],
  };
}

test("Block Golden manifest freezes paths, ranges, digests and coverage", () => {
  const result = validateBlockGoldenManifest(goldenManifest());
  assert.equal(result.cases.length, 1);
  assert.deepEqual(result.coverage, REQUIRED_BLOCK_GOLDEN_COVERAGE);
  assert.throws(() => validateBlockGoldenManifest({
    ...goldenManifest(),
    cases: [{ ...goldenManifest().cases[0], inputFile: "../escape.ivf" }],
  }), /relative path/u);
});

test("Block Golden semantic coverage requires every deep-analysis family", () => {
  assert.deepEqual(assertBlockGoldenCoverage([coveredOverlay()]), {
    caseCount: 1,
    blockCount: 2,
  });
  const missing = coveredOverlay();
  missing.frames[0].blocks.forEach((block) => { block.filter = null; });
  assert.throws(() => assertBlockGoldenCoverage([missing]), /loopFilters/u);
});
