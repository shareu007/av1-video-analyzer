import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceStateIndex, blockPredictionSources, timelineReferenceArcs } from "../public/reference-state.js";

const obu = (obuId, frameId, summary) => ({ obuId, frameId, type: { code: 3 }, frameHeaderSummary: summary });
const key = (obuId, frameId, extra = {}) => obu(obuId, frameId, {
  frameType: 0, frameTypeName: "KEY_FRAME", showFrame: 1, refreshFrameFlags: 0xff,
  frameWidth: 64, frameHeight: 64, referenceSlotIndices: [], referenceFrameIds: [], ...extra,
});

test("replays eight reference slots, preserving partial refreshes and clearing invalidated slots", () => {
  const report = { obus: [
    key(0, 0),
    obu(1, 1, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 1, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0, 1, 2, 3, 4, 5, 6], referenceFrameIds: [0, null, null, null, null, null, null] }),
    obu(2, 2, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 4, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0, 1, 2, 3, 4, 5, 6], referenceFrameIds: [0, 0, 0, 0, 0, 0, 0] }),
    obu(3, 3, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0, invalidatedReferenceSlots: [0], frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [], referenceFrameIds: [] }),
  ] };
  const states = buildReferenceStateIndex(report);
  assert.equal(states.get(0).after.filter(Boolean).length, 8);
  assert.equal(states.get(1).after[0].frameId, 1);
  assert.equal(states.get(1).after[1].frameId, 0);
  assert.equal(states.get(2).after[0].frameId, 1);
  assert.equal(states.get(2).after[2].frameId, 2);
  assert.equal(states.get(3).after[0], null);
});

test("keeps hidden and shown headers distinct within one container frame and resolves show_existing", () => {
  const report = { obus: [
    key(10, 7, { showFrame: 0 }),
    obu(11, 7, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0, 1, 2, 3, 4, 5, 6], referenceFrameIds: [7, null, null, null, null, null, null] }),
    obu(12, 8, { frameTypeName: "INTER_FRAME", showExistingFrame: 1, frameToShowMapIdx: 0, showFrame: 1,
      refreshFrameFlags: 0, frameWidth: 64, frameHeight: 64, referenceSlotIndices: [0], referenceFrameIds: [7] }),
  ] };
  const states = buildReferenceStateIndex(report);
  assert.equal(states.get(7).obuId, 11);
  assert.equal(states.get(7).picture.obuId, 11);
  assert.equal(states.get(8).picture.obuId, 10);
  assert.equal(states.get(8).picture.previewFrameId, 8);
  assert.equal(states.get(8).after[0].obuId, 10);
});

test("maps R1..R7 through seven-entry references and does not invent R ids for short signaling", () => {
  const report = { obus: [key(0, 0), obu(1, 1, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0,
    frameWidth: 64, frameHeight: 64, referenceSlotIndices: [0, 1], referenceFrameIds: [0, 0] })] };
  const state = buildReferenceStateIndex(report).get(1);
  assert.deepEqual(state.bindings.map(({ reference }) => reference), [null, null]);
  const full = buildReferenceStateIndex({ obus: [key(0, 0), obu(1, 1, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0,
    frameWidth: 64, frameHeight: 64, referenceSlotIndices: [0, 1, 2, 3, 4, 5, 6], referenceFrameIds: [0, 0, 0, 0, 0, 0, 0] })] }).get(1);
  assert.deepEqual(full.bindings.map(({ reference }) => reference), [1, 2, 3, 4, 5, 6, 7]);
});

test("produces pixel MV regions, compound overlaps, safe rejection, and clamped timeline arcs", () => {
  const report = { obus: [key(0, 0), obu(1, 1, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0,
    frameWidth: 64, frameHeight: 64, referenceSlotIndices: [0, 1, 2, 3, 4, 5, 6], referenceFrameIds: [0, 0, 0, 0, 0, 0, 0] })] };
  const state = buildReferenceStateIndex(report).get(1);
  const overlay = { frames: [{ frameId: 0, blocks: [{ plane: 0, x: 12, y: 8, width: 8, height: 8 }] }] };
  const sources = blockPredictionSources({ mode: "inter", x: 8, y: 8, width: 8, height: 8, plane: 0, refs: [1, 2], mv: [
    { x: 8, y: 0, precision: "1/2 pel" }, { x: -4, y: 0, precision: "integer" },
  ] }, state, overlay);
  assert.deepEqual(sources[0].region, { x: 12, y: 8, width: 8, height: 8 });
  assert.equal(sources[0].overlaps.length, 1);
  assert.deepEqual(sources[1].region, { x: 4, y: 8, width: 8, height: 8 });
  assert.equal(blockPredictionSources({ mode: "inter", x: 0, y: 0, width: 8, height: 8, refs: [1], mv: [{ x: 1, y: 0, precision: "unknown" }] }, state, overlay)[0].region, null);
  const mismatched = buildReferenceStateIndex({ obus: [key(0, 0, { frameWidth: 32, frameHeight: 32 }), report.obus[1]] }).get(1);
  assert.equal(blockPredictionSources({ mode: "inter", x: 0, y: 0, width: 8, height: 8, refs: [1], mv: [{ x: 1, y: 0, precision: "integer" }] }, mismatched, overlay)[0].region, null);
  const arcs = timelineReferenceArcs(50, [{ x: -10 }, { x: 50 }, { x: 300 }], 100);
  assert.deepEqual(arcs.map((arc) => [arc.end, arc.outside]), [[10, true], [50, false], [90, true]]);
  assert.match(arcs[1].path, /C/);
});
