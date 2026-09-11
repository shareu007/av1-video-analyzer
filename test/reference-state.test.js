import test from "node:test";
import assert from "node:assert/strict";
import { REFERENCE_NAMES, namedReferenceBindings, buildReferenceStateIndex, blockPredictionSources, timelineReferenceArcs, pictureLabel, currentPictureDescription, samePacketReference, referenceBlockUsage } from "../public/reference-state.js";
import { blockAnnotationContent } from "../public/block-annotations.js";

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

test("names multiple hidden pictures in one packet and preserves identity through show_existing", () => {
  const states = buildReferenceStateIndex({ obus: [
    key(10, 1, { showFrame: 0, refreshFrameFlags: 1 }),
    obu(11, 1, { frameTypeName: "INTER_FRAME", showFrame: 0, refreshFrameFlags: 16, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0], referenceFrameIds: [1] }),
    obu(12, 1, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0, 4], referenceFrameIds: [1, 1] }),
    obu(13, 2, { frameTypeName: "INTER_FRAME", showExistingFrame: 1, frameToShowMapIdx: 4, showFrame: 1,
      refreshFrameFlags: 0, frameWidth: 64, frameHeight: 64, referenceSlotIndices: [4], referenceFrameIds: [1] }),
  ] });
  const packet = states.get(1), shown = packet.picture, replay = states.get(2).picture;
  assert.equal(pictureLabel(packet.packetPictures[0], { compact: true }), "F1·H1");
  assert.equal(pictureLabel(packet.packetPictures[1], { compact: true }), "F1·H2");
  assert.match(currentPictureDescription(packet), /hidden reference pictures/);
  assert.equal(replay, packet.packetPictures[1]);
  assert.equal(pictureLabel(replay), "Frame 1 · hidden picture 2");
  assert.equal(replay.previewFrameId, 2);
  assert.match(currentPictureDescription(states.get(2)), /Frame 2 displays Frame 1 · hidden picture 2 from the reference cache; no new picture is coded/);
  assert.equal(pictureLabel(shown, { compact: true }), "F1·shown");
  assert.equal(samePacketReference(shown, packet), false);
  assert.equal(samePacketReference(replay, states.get(2)), false);
  assert.equal(pictureLabel(null, { frameId: 1 }), "Frame 1 · picture unresolved");
});

test("distinguishes same-packet references and counts luma block usage without inventing zeros", () => {
  const states = buildReferenceStateIndex({ obus: [
    key(20, 5, { showFrame: 0, refreshFrameFlags: 1 }),
    obu(21, 5, { frameTypeName: "INTER_FRAME", showFrame: 0, refreshFrameFlags: 16, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0], referenceFrameIds: [5] }),
    obu(22, 5, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0, frameWidth: 64, frameHeight: 64,
      referenceSlotIndices: [0, 4, 0, 0, 0, 0, 0], referenceFrameIds: [5, 5, 5, 5, 5, 5, 5] }),
  ] });
  const state = states.get(5);
  assert.equal(samePacketReference(state.bindings[0].picture, state), true);
  assert.equal(samePacketReference(state.bindings[4].picture, state), true);
  const content = blockAnnotationContent({ mode: "inter", refs: [1], interMode: "NEAREST" }, "mode", { referenceState: state });
  assert.match(content.lines[0], /INTER ← F5·H1/);
  assert.match(content.detail.join(" "), /still INTER/);
  assert.deepEqual(referenceBlockUsage([
    { plane: 0, mode: "inter", refs: [1, 5] }, { plane: 0, mode: "inter", refs: [1, 1] },
    { plane: 1, mode: "inter", refs: [1] }, { plane: 0, mode: "intra" }, { plane: 0, mode: "inter" },
  ]), { counts: [0, 2, 0, 0, 0, 1, 0, 0], totalBlocks: 4, interBlocks: 3, unknownBlocks: 1 });
  assert.equal(referenceBlockUsage([]), null);
  assert.equal(referenceBlockUsage(null), null);
  assert.equal(referenceBlockUsage([{ plane: 1, mode: "inter", refs: [1] }]), null);
  assert.deepEqual(referenceBlockUsage([{ mode: "unknown" }]), { counts: Array(8).fill(0), totalBlocks: 1, interBlocks: 0, unknownBlocks: 1 });
  assert.deepEqual(referenceBlockUsage([{ mode: "inter", refs: [1, null] }]), { counts: [0, 1, 0, 0, 0, 0, 0, 0], totalBlocks: 1, interBlocks: 1, unknownBlocks: 1 });
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

test("names all seven AV1 references and maps them to arbitrary DPB slots", () => {
  assert.deepEqual([...REFERENCE_NAMES], ["LAST", "LAST2", "LAST3", "GOLDEN", "BWDREF", "ALTREF2", "ALTREF"]);
  const bindings = namedReferenceBindings({
    summary: { frameTypeName: "INTER_FRAME" },
    bindings: [
      { reference: 1, slot: 7, frameId: 70, picture: { frameId: 70 } },
      { reference: 2, slot: 0, frameId: 10, picture: { frameId: 10 } },
      { reference: 3, slot: 7, frameId: 70, picture: { frameId: 70 } },
      { reference: 4, slot: 3, frameId: 30, picture: { frameId: 30 } },
      { reference: 5, slot: 6, frameId: 60, picture: { frameId: 60 } },
      { reference: 6, slot: 1, frameId: 10, picture: { frameId: 10 } },
      { reference: 7, slot: 4, frameId: 40, picture: { frameId: 40 } },
    ],
  });
  assert.deepEqual(bindings.map(({ reference, name, slot }) => [reference, name, slot]), [
    [1, "LAST_FRAME", 7], [2, "LAST2_FRAME", 0], [3, "LAST3_FRAME", 7],
    [4, "GOLDEN_FRAME", 3], [5, "BWDREF_FRAME", 6], [6, "ALTREF2_FRAME", 1], [7, "ALTREF_FRAME", 4],
  ]);
});

test("returns seven rows without fabricating active references for missing, intra, or show-existing state", () => {
  for (const state of [
    { summary: { frameTypeName: "INTER_FRAME" }, bindings: [{ reference: null, slot: 2 }] },
    { summary: { frameTypeName: "KEY_FRAME" }, bindings: [] },
    { summary: { frameTypeName: "INTRA_ONLY_FRAME" }, bindings: [] },
    { summary: { frameTypeName: "INTER_FRAME", showExistingFrame: 1 }, bindings: [{ reference: null, slot: 4 }] },
  ]) {
    const rows = namedReferenceBindings(state);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map(({ reference, slot, status }) => [reference, slot, status]),
      Array.from({ length: 7 }, (_, index) => [index + 1, null, state.summary.frameTypeName === "INTER_FRAME" && !state.summary.showExistingFrame ? "unavailable" : "not-applicable"]));
  }
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
