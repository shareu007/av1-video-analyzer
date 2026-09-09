import assert from "node:assert/strict";
import test from "node:test";

import { buildNativeTraceFieldMap, compareTraceEntry } from "../public/trace-compare.js";

test("trace comparison preserves array indices and refuses ambiguous scalar aliases", () => {
  const fields = buildNativeTraceFieldMap([
    { path: "frame_header.loop_filter.loop_filter_level[0]", value: 4 },
    { path: "frame_header.loop_filter.loop_filter_level[1]", value: 7 },
    { path: "frame_header.one.shared", value: 1 },
    { path: "frame_header.two.shared", value: 2 },
    { path: "frame_header.one.repeated", value: 3 },
    { path: "frame_header.two.repeated", value: 3 },
  ]);

  assert.deepEqual(compareTraceEntry(fields, { name: "loop_filter_level[0]", value: 4 }), {
    comparable: true, match: true, nativeValue: 4,
  });
  assert.deepEqual(compareTraceEntry(fields, { name: "loop_filter_level[1]", value: 4 }), {
    comparable: true, match: false, nativeValue: 7,
  });
  assert.equal(compareTraceEntry(fields, { name: "loop_filter_level", value: 4 }).comparable, false);
  assert.equal(compareTraceEntry(fields, { name: "shared", value: 1 }).comparable, false);
  assert.equal(compareTraceEntry(fields, { name: "repeated", value: 3 }).comparable, false);
});

test("trace comparison maps global-motion coded values and segmentation feature matrices", () => {
  const fields = buildNativeTraceFieldMap([
    { path: "frame_header.global_motion.gm_params[1][2].subexp_code", value: 188 },
    { path: "frame_header.segmentation.segment[3].alt_q.feature_enabled", value: 1 },
    { path: "frame_header.segmentation.segment[3].alt_q.feature_value", value: -17 },
  ]);

  assert.equal(compareTraceEntry(fields, { name: "gm_params[1][2]", value: 188 }).match, true);
  assert.equal(compareTraceEntry(fields, { name: "feature_enabled[3][0]", value: 1 }).match, true);
  assert.equal(compareTraceEntry(fields, { name: "feature_value[3][0]", value: -17 }).match, true);
});
