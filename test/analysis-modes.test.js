import assert from "node:assert/strict";
import test from "node:test";
import { analysisModes } from "../public/analysis-modes.js";

test("analysis modes require actual block data and distinguish unsupported decode stages", () => {
  assert.deepEqual(analysisModes([]).filter((mode) => mode.available).map((mode) => mode.id), ["yuv"]);
  const modes = analysisModes([{ mode: "inter", coeffNonZero: 0, qindex: 0, mv: [{ x: 0, y: 0 }] }]);
  for (const id of ["coding-flow", "predictions", "residuals", "info-overlays", "simple-motion", "yuv"]) {
    assert.equal(modes.find((mode) => mode.id === id).available, true, id);
  }
  for (const id of ["reconstruction", "deblocking", "sao"]) {
    assert.equal(modes.find((mode) => mode.id === id).available, false, id);
  }
  assert.match(modes.find((mode) => mode.id === "residuals").note, /Signed residual samples are not available/);
  assert.equal(analysisModes([{ coeffNonZero: 10 }], () => false).find((mode) => mode.id === "residuals").available, false);
});
