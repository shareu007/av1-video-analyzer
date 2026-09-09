import assert from "node:assert/strict";
import test from "node:test";
import { displayedFrameSummary, sourcePointFromClient } from "../public/preview-model.js";

test("preview uses the displayed header rather than an earlier hidden frame in the same packet", () => {
  const hidden = { showFrame: false, frameWidth: 128, referenceFrameIds: [0] };
  const shown = { showFrame: true, frameWidth: 256, referenceFrameIds: [5] };
  const report = { obus: [
    { obuId: 4, frameHeaderSummary: hidden },
    { obuId: 7, frameHeaderSummary: shown },
    { obuId: 9, frameHeaderSummary: { showExistingFrame: true, frameToShowMapIdx: 5 } },
  ] };
  assert.equal(displayedFrameSummary(report, { obuIds: [4, 7], headerSummary: hidden }), shown);
  assert.equal(displayedFrameSummary(report, { obuIds: [9] }).frameToShowMapIdx, 5);
  assert.equal(displayedFrameSummary(report, { obuIds: [], headerSummary: hidden }), hidden);
});

test("block hit coordinates remain aligned at zoom, DPR-independent and scrolled offsets", () => {
  for (const zoom of [0.5, 1, 2, 8]) {
    const bounds = { left: -80, top: 70, width: 256 * zoom, height: 128 * zoom };
    assert.deepEqual(sourcePointFromClient(bounds, -80 + 24 * zoom, 70 + 12 * zoom, 256, 128), { x: 24, y: 12 });
    assert.equal(sourcePointFromClient(bounds, -81, 70, 256, 128), null);
  }
  assert.equal(sourcePointFromClient({ left: 0, top: 0, width: 0, height: 0 }, 0, 0, 256, 128), null);
});
