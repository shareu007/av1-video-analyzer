import assert from "node:assert/strict";
import test from "node:test";

import {
  referenceDirection,
  referenceTimelineTargets,
  referenceUsageTone,
} from "../public/reference-state.js";

test("referenceDirection classifies named AV1 groups, independently of source frame IDs", () => {
  assert.deepEqual([1, 2, 3, 4].map(referenceDirection), ["forward", "forward", "forward", "forward"]);
  assert.deepEqual([5, 6, 7].map(referenceDirection), ["backward", "backward", "backward"]);
  assert.deepEqual([0, 8, -1, 1.5, null, "5"].map(referenceDirection), [null, null, null, null, null, null]);
  assert.notEqual(referenceDirection(1), referenceDirection(5));
});

test("usage tone recognizes every positively-used named group and ignores zero or unknown usage", () => {
  const bindings = [1, 2, 3, 4, 5, 6, 7].map((reference) => ({ reference, frameId: 9000 - reference }));
  const counts = Array(8).fill(0);
  counts[1] = 10;
  counts[5] = 25;
  assert.equal(referenceUsageTone(bindings, { counts }), "mixed");
  assert.equal(referenceUsageTone(bindings, null), null);
  assert.equal(referenceUsageTone(bindings, { counts, unknownBlocks: 1 }), "mixed");

  counts[1] = 0;
  counts[5] = 0;
  counts[7] = 4;
  assert.equal(referenceUsageTone(bindings, { counts }), "backward");
  counts[7] = 0;
  counts[2] = 0;
  counts[6] = 0;
  counts[99] = 3;
  assert.equal(referenceUsageTone(bindings, { counts }), null);
});

test("DPB aliases across bindings still produce a mixed tone", () => {
  const counts = Array(8).fill(0);
  counts[2] = 1;
  counts[6] = 1;
  assert.equal(referenceUsageTone([
    { reference: 2, slot: 3, frameId: 42 },
    { reference: 6, slot: 3, frameId: 42 },
  ], { counts }), "mixed");
});

test("timeline splits one source frame into directional arcs and keeps unused candidates", () => {
  const targets = [{ frameId: 1, x: 20 }, { frameId: 2, x: 40 }];
  const state = { bindings: [
    { reference: 1, frameId: 1, slot: 0 },
    { reference: 5, frameId: 1, slot: 0 },
    { reference: 2, frameId: 2, slot: 1 },
  ], summary: {} };
  const counts = Array(8).fill(0);
  counts[1] = 3;
  const result = referenceTimelineTargets(targets, state, { counts, unknownBlocks: false });
  assert.deepEqual(result.map(({ frameId, direction }) => ({ frameId, direction })), [
    { frameId: 1, direction: "forward" },
    { frameId: 1, direction: "backward" },
    { frameId: 2, direction: "forward" },
  ]);
  assert.equal(result[0].used, true);
  assert.equal(result[1].used, false);
  assert.equal(result[2].used, false);
  counts[5] = 25;
  const usedBoth = referenceTimelineTargets(targets, state, { counts, unknownBlocks: 0 });
  assert.deepEqual(usedBoth.map((entry) => entry.used), [true, true, false]);
  assert.equal(usedBoth[1].direction, "backward");
  const unknown = referenceTimelineTargets(targets, state, null);
  assert.ok(unknown.every((entry) => !entry.used && !entry.verified));
});

test("show-existing targets remain display arcs, while missing mappings stay unknown", () => {
  const counts = Array(8).fill(0);
  const display = referenceTimelineTargets([{ frameId: "F1", x: 1 }], {
    summary: { showExistingFrame: true },
    bindings: [{ reference: 5, frameId: "F1" }],
  }, { counts, unknownBlocks: false });
  assert.equal(display[0].direction, "display");
  assert.equal(display[0].used, true);

  const missing = referenceTimelineTargets([{ frameId: "missing", x: 2 }], { summary: {} }, { counts, unknownBlocks: false });
  assert.equal(missing[0].direction, "unknown");
  assert.equal(missing[0].used, false);
  assert.equal(missing[0].verified, false);
});
