import assert from "node:assert/strict";
import test from "node:test";

import { validateReportSemantics } from "../src/validator.js";

test("semantic validator diagnoses dimensions and unresolved references", () => {
  const diagnostics = validateReportSemantics({
    container: { width: 1920, height: 1080 },
    frames: [{
      frameId: 0,
      payloadRange: { start: 100, length: 20 },
      headerSummary: {
        frameTypeName: "KEY_FRAME",
        frameWidth: 1280,
        frameHeight: 720,
        referenceFrameIds: [],
      },
    }, {
      frameId: 1,
      payloadRange: { start: 120, length: 10 },
      headerSummary: {
        frameTypeName: "INTER_FRAME",
        frameWidth: 1280,
        frameHeight: 720,
        referenceFrameIds: [null, 1],
      },
    }],
    obus: [],
  });
  assert.deepEqual(diagnostics.map(({ code }) => code), [
    "CONTAINER_CODED_DIMENSIONS_MISMATCH",
    "REFERENCE_SLOT_UNAVAILABLE",
    "REFERENCE_FRAME_NOT_EARLIER",
  ]);
});

test("semantic validator checks parser bit consumption", () => {
  const diagnostics = validateReportSemantics({
    container: null,
    frames: [],
    obus: [{
      obuId: 3,
      frameId: null,
      payloadRange: { start: 5, length: 1 },
      parsedPayloadBitLength: 9,
    }],
  });
  assert.equal(diagnostics[0].code, "SYNTAX_RANGE_EXCEEDS_PAYLOAD");
});
