import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { analyzeGuiBuffer } from "../src/gui-server.js";
import { buildPictureStateIndex, buildReferenceStateIndex } from "../public/reference-state.js";

const media = new URL("../media/test_256x256_av1.ivf", import.meta.url);

test("indexes real packet pictures by frame, header OBU, and displayed ordinal", async (t) => {
  try { await access(media); } catch { t.skip("local test media is not installed"); return; }
  const report = await analyzeGuiBuffer(await readFile(media), "test_256x256_av1.ivf");
  const index = buildPictureStateIndex(report);
  assert.ok(index.frames instanceof Map);
  assert.ok(index.obus instanceof Map);
  for (const [frameId, headerObu, label, previewFrameId, previewIndex] of [
    [1, 4, "H1", 8, 8], [1, 5, "H2", 4, 4], [1, 6, "H3", 2, 2], [1, 7, "shown", 1, 1],
  ]) {
    const state = index.frames.get(frameId);
    const picture = index.obus.get(headerObu).picture;
    assert.equal(picture.obuId, headerObu);
    assert.equal(picture.previewFrameId, previewFrameId);
    assert.equal(picture.previewIndex, previewIndex);
    assert.equal(state.packetPictures.includes(picture), true);
    assert.equal(picture.hidden ? `H${picture.hiddenIndex}` : "shown", label);
  }
  assert.equal(index.obus.has(8), false); // Temporal delimiter, not a picture.
  assert.equal(index.obus.get(9).picture, index.obus.get(6).picture);
  assert.equal(index.frames.get(1).obuId, 7);
  assert.equal(index.obus.get(4).before[0].obuId, 2);
  assert.equal(index.obus.get(5).before[0].obuId, 4);
  assert.notDeepEqual(index.obus.get(4).before, index.obus.get(7).before);
});

test("routes tiles to the preceding header without crossing packets and keeps old defaults", () => {
  const header = (obuId, frameId, summary) => ({ obuId, frameId, type: { code: 3 }, frameHeaderSummary: {
    frameType: 0, frameTypeName: "KEY_FRAME", showFrame: 1, refreshFrameFlags: 0xff,
    frameWidth: 64, frameHeight: 64, referenceSlotIndices: [], referenceFrameIds: [], ...summary,
  } });
  const report = { obus: [
    header(1, 4, { showFrame: 0, refreshFrameFlags: 1 }),
    { obuId: 2, frameId: 4, type: { code: 4 } },
    { obuId: 3, frameId: 4, type: { code: 7 } },
    header(4, 9, { showFrame: 1, frameTypeName: "INTER_FRAME", refreshFrameFlags: 2 }),
    { obuId: 5, frameId: 9, type: { code: 4 } },
    { obuId: 6, frameId: 9, type: { code: 7 } },
    { obuId: 7, frameId: 20, type: { code: 6 }, frameHeaderSummary: { showExistingFrame: 1, frameToShowMapIdx: 0, showFrame: 1, refreshFrameFlags: 0 } },
    { obuId: 8, frameId: 21, type: { code: 4 } },
    header(9, 22, { showFrame: 0, refreshFrameFlags: 4 }),
  ] };
  const index = buildPictureStateIndex(report);
  assert.equal(index.obus.get(2).picture, index.obus.get(1).picture);
  assert.equal(index.obus.get(3).picture, index.obus.get(1).picture);
  assert.equal(index.obus.get(5).picture, index.obus.get(4).picture);
  assert.equal(index.obus.get(6).picture, index.obus.get(4).picture);
  assert.notEqual(index.obus.get(2).picture, index.obus.get(4).picture);
  assert.equal(index.obus.get(1).picture.previewFrameId, 20);
  assert.equal(index.obus.get(1).picture.previewIndex, 1);
  assert.equal(index.obus.get(4).picture.previewIndex, 0);
  assert.equal(index.obus.has(8), false);
  assert.equal(index.obus.get(9).picture.previewIndex, null);
  assert.equal(index.obus.get(9).picture.previewFrameId, null);
  assert.equal(index.obus.get(1).picture.previewIndex !== index.obus.get(1).picture.frameId, true);
  const legacy = buildReferenceStateIndex(report);
  assert.ok(legacy instanceof Map);
  assert.equal(legacy.get(4).picture.obuId, 1);
  assert.equal(legacy.get(20).picture.obuId, 1);
});

test("an unparsed header makes later display ordinals unknown rather than guessing a packet index", () => {
  const index = buildPictureStateIndex({ obus: [
    { obuId: 1, frameId: 0, type: { code: 6 } },
    { obuId: 2, frameId: 1, type: { code: 6 }, frameHeaderSummary: { showFrame: 1, refreshFrameFlags: 255 } },
    { obuId: 3, frameId: 2, type: { code: 6 }, frameHeaderSummary: { showFrame: 1, refreshFrameFlags: 0 } },
  ] });
  assert.equal(index.obus.get(1).picture, null);
  assert.equal(index.obus.get(2).picture.previewIndex, null);
  assert.equal(index.obus.get(3).picture.previewIndex, null);
});
