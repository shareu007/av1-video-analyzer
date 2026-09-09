import assert from "node:assert/strict";
import test from "node:test";

import { validateBlockOverlayDocument } from "../src/block-overlay.js";

const report = {
  container: { width: 64, height: 36 },
  frames: [{ frameId: 0, headerSummary: { frameWidth: 64, frameHeight: 36 } }],
};

test("validates and normalizes external block overlays", () => {
  const overlay = validateBlockOverlayDocument({
    schemaVersion: 1,
    provenance: { producer: "libaom-inspect-test" },
    frames: [{ frameId: 0, blocks: [
      { x: 0, y: 0, width: 32, height: 16, mode: "intra", qindex: 92,
        partition: "split", segmentId: 2, intraMode: "DC_PRED", refs: [],
        txSize: "TX_16X16", txType: "DCT_DCT", coeffNonZero: 23, filter: "CDEF:3" },
      { x: 32, y: 0, width: 32, height: 16, mode: "custom" },
    ] }],
  }, report);
  assert.equal(overlay.frames[0].blocks[1].mode, "unknown");
  assert.equal(overlay.frames[0].blocks[1].partition, "unknown");
  assert.equal(overlay.frames[0].blocks[1].qindex, null);
  assert.equal(overlay.frames[0].blocks[0].blockId, 0);
  assert.equal(overlay.frames[0].blocks[0].segmentId, 2);
  assert.equal(overlay.frames[0].blocks[0].txType, "DCT_DCT");
});

test("validates motion vectors and reference slots", () => {
  const overlay = validateBlockOverlayDocument({
    schemaVersion: 1,
    frames: [{ frameId: 0, blocks: [{
      x: 0, y: 0, width: 16, height: 16, mode: "inter", refs: [0, 3],
      mv: [{ x: -12, y: 4, precision: "1/8 pel" }, { x: 8, y: 0 }],
    }] }],
  }, report);
  assert.deepEqual(overlay.frames[0].blocks[0].refs, [0, 3]);
  assert.equal(overlay.frames[0].blocks[0].mv[0].x, -12);

  assert.throws(() => validateBlockOverlayDocument({
    schemaVersion: 1,
    frames: [{ frameId: 0, blocks: [{ x: 0, y: 0, width: 8, height: 8, refs: [9] }] }],
  }, report), /refs/);
});

test("preserves optional BlockRecord v2 producer details in overlay v1", () => {
  const overlay = validateBlockOverlayDocument({
    schemaVersion: 1,
    frames: [{ frameId: 0, blocks: [{
      x: 8, y: 4, width: 16, height: 8, mode: "inter",
      miRow: 1, miColumn: 2, compoundType: "COMPOUND_5", quantDelta: -12,
    }] }],
  }, report);
  assert.deepEqual({
    miRow: overlay.frames[0].blocks[0].miRow,
    miColumn: overlay.frames[0].blocks[0].miColumn,
    compoundType: overlay.frames[0].blocks[0].compoundType,
    quantDelta: overlay.frames[0].blocks[0].quantDelta,
  }, { miRow: 1, miColumn: 2, compoundType: "COMPOUND_5", quantDelta: -12 });
  assert.throws(() => validateBlockOverlayDocument({
    schemaVersion: 1,
    frames: [{ frameId: 0, blocks: [{
      x: 0, y: 0, width: 8, height: 8, quantDelta: 256,
    }] }],
  }, report), /quantDelta/u);
});

test("rejects block geometry outside the decoded frame", () => {
  assert.throws(() => validateBlockOverlayDocument({
    schemaVersion: 1,
    frames: [{ frameId: 0, blocks: [{ x: 60, y: 0, width: 8, height: 8 }] }],
  }, report), /outside 64x36/);
});
