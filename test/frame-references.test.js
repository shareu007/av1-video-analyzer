import assert from "node:assert/strict";
import test from "node:test";

import { frameReferenceTargets } from "../public/frame-references.js";

test("frameReferenceTargets deduplicates resolved IDs and preserves parallel slots", () => {
  const report = { frames: [{ frameId: 4, label: "four" }, { frameId: 7, label: "seven" }] };
  const result = frameReferenceTargets(report, { frameId: 8 }, {
    referenceFrameIds: [7, 4, 7, null, "4", 99],
    referenceSlotIndices: [2, 0, 5, 6, 1, 3],
  });
  assert.deepEqual(result.targets, [
    { frameId: 7, frame: report.frames[1], slotIndices: [2, 5] },
    { frameId: 4, frame: report.frames[0], slotIndices: [0] },
  ]);
  assert.deepEqual(result.unresolvedSlots, [{ frameId: null, slotIndex: 6 }, { frameId: null, slotIndex: 1 }, { frameId: 99, slotIndex: 3 }]);
});

test("frameReferenceTargets tolerates missing report and summaries", () => {
  assert.deepEqual(frameReferenceTargets(null, null), { targets: [], unresolvedSlots: [] });
});
