import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { makeObu } from "./fixtures.js";

test("normalized complete Sequence Header field-tree golden remains stable", () => {
  const report = analyzeBuffer(
    makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") }),
    { sourceName: "reduced-still.obu" },
  );
  const values = Object.fromEntries(
    report.syntaxNodes.map(({ path, value }) => [path, value]),
  );

  assert.deepEqual(
    {
      source: report.source,
      summary: report.summary,
      obuType: report.obus[0].type,
      obuRange: report.obus[0].byteRange,
      payloadRange: report.obus[0].payloadRange,
      syntaxStatus: report.obus[0].syntaxStatus,
      parsedPayloadBitLength: report.obus[0].parsedPayloadBitLength,
      nodeCount: report.syntaxNodes.length,
      firstNode: report.syntaxNodes[0],
      lastNode: report.syntaxNodes.at(-1),
      values: {
        profile: values["sequence_header.seq_profile"],
        still: values["sequence_header.still_picture"],
        reduced: values["sequence_header.reduced_still_picture_header"],
        maxWidth: values["sequence_header.max_frame_width_minus_1"] + 1,
        maxHeight: values["sequence_header.max_frame_height_minus_1"] + 1,
        filterIntra: values["sequence_header.enable_filter_intra"],
        cdef: values["sequence_header.enable_cdef"],
        bitDepthHigh: values["sequence_header.color_config.high_bitdepth"],
        mono: values["sequence_header.color_config.mono_chrome"],
        colorRange: values["sequence_header.color_config.color_range"],
        filmGrain: values["sequence_header.film_grain_params_present"],
      },
      diagnostics: report.diagnostics,
    },
    {
      source: { name: "reduced-still.obu", size: 8, format: "low_overhead_obu" },
      summary: { frameCount: 0, obuCount: 1, errorCount: 0, warningCount: 0, complete: true },
      obuType: { code: 1, name: "sequence_header" },
      obuRange: { start: 0, length: 8 },
      payloadRange: { start: 2, length: 6 },
      syntaxStatus: "complete",
      parsedPayloadBitLength: 48,
      nodeCount: 29,
      firstNode: {
        schemaVersion: 1,
        nodeId: 0,
        obuId: 0,
        path: "sequence_header.seq_profile",
        value: 0,
        coding: "f(3)",
        presence: "true",
        bitRange: { startBit: 16, lengthBits: 3 },
        specAnchor: "AV1 §5.5.1 General sequence header OBU syntax",
      },
      lastNode: {
        schemaVersion: 1,
        nodeId: 28,
        obuId: 0,
        path: "sequence_header.trailing_bits.trailing_zero_bit[7]",
        value: 0,
        coding: "f(1)",
        presence: "true",
        bitRange: { startBit: 63, lengthBits: 1 },
        specAnchor: "AV1 §5.5.1 General sequence header OBU syntax",
      },
      values: {
        profile: 0,
        still: 1,
        reduced: 1,
        maxWidth: 16,
        maxHeight: 16,
        filterIntra: 1,
        cdef: 1,
        bitDepthHigh: 0,
        mono: 0,
        colorRange: 0,
        filmGrain: 0,
      },
      diagnostics: [],
    },
  );
});
