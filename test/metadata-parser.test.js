import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { makeObu } from "./fixtures.js";

class MetadataBits {
  constructor(type) { this.bytes = [type]; this.bits = []; }
  write(value, width) {
    for (let shift = width - 1; shift >= 0; shift -= 1) this.bits.push((value >> shift) & 1);
    return this;
  }
  finish() {
    this.bits.push(1);
    while (this.bits.length % 8) this.bits.push(0);
    const content = Buffer.alloc(this.bits.length / 8);
    this.bits.forEach((bit, index) => { content[index >> 3] |= bit << (7 - (index & 7)); });
    return Buffer.concat([Buffer.from(this.bytes), content]);
  }
}

test("parses HDR content light level metadata with absolute bit ranges", () => {
  const payload = Buffer.alloc(6);
  payload[0] = 1;
  payload.writeUInt16BE(1000, 1);
  payload.writeUInt16BE(400, 3);
  payload[5] = 0x80;
  const report = analyzeBuffer(makeObu({ type: 5, payload }));
  const values = Object.fromEntries(report.syntaxNodes.map(({ path, value }) => [path, value]));

  assert.equal(values["metadata.metadata_type_name"], "HDR_CLL");
  assert.equal(values["metadata.hdr_cll.max_cll"], 1000);
  assert.equal(values["metadata.hdr_cll.max_fall"], 400);
  assert.equal(report.obus[0].metadataSummary.metadataTypeName, "HDR_CLL");
  assert.equal(report.obus[0].syntaxStatus, "complete");
  assert.deepEqual(report.syntaxNodes[2].bitRange, { startBit: 24, lengthBits: 16 });
});

test("parses ITU-T T.35 country identification and leaves external payload partial", () => {
  const report = analyzeBuffer(makeObu({
    type: 5,
    payload: Buffer.from([4, 0xff, 0x31, 0xb5, 0x00, 0x3c]),
  }));
  const values = Object.fromEntries(report.syntaxNodes.map(({ path, value }) => [path, value]));

  assert.equal(values["metadata.itut_t35.country_code"], 0xff);
  assert.equal(values["metadata.itut_t35.country_code_extension_byte"], 0x31);
  assert.equal(values["metadata.itut_t35.payload_byte_length"], 3);
  assert.equal(report.obus[0].syntaxStatus, "partial");
});

test("diagnoses a truncated fixed-size metadata record", () => {
  const report = analyzeBuffer(makeObu({ type: 5, payload: Buffer.from([1, 0x01]) }));
  assert.equal(report.obus[0].syntaxStatus, "error");
  assert.equal(report.diagnostics.at(-1).code, "METADATA_TRUNCATED");
});

test("diagnoses invalid fixed metadata trailing bits", () => {
  const report = analyzeBuffer(makeObu({
    type: 5,
    payload: Buffer.from([1, 0, 1, 0, 1, 0x40]),
  }));
  assert.equal(report.obus[0].syntaxStatus, "error");
  assert.ok(report.diagnostics.some(({ code }) => code === "METADATA_TRAILING_ONE_BIT_INVALID"));
});

test("parses a custom two-layer scalability structure and temporal group", () => {
  const payload = new MetadataBits(3)
    .write(14, 8)
    .write(1, 2).write(1, 1).write(1, 1).write(1, 1).write(0, 3)
    .write(640, 16).write(360, 16).write(1280, 16).write(720, 16)
    .write(255, 8).write(0, 8)
    .write(2, 8)
    .write(0, 3).write(1, 1).write(0, 1).write(1, 3).write(2, 8)
    .write(1, 3).write(1, 1).write(0, 1).write(1, 3).write(1, 8)
    .finish();
  const report = analyzeBuffer(makeObu({ type: 5, payload }));
  const values = Object.fromEntries(report.syntaxNodes.map(({ path, value }) => [path, value]));

  assert.equal(report.obus[0].syntaxStatus, "complete");
  assert.equal(report.diagnostics.length, 0);
  assert.equal(values["metadata.scalability.scalability_mode_idc"], 14);
  assert.equal(values["metadata.scalability.spatial_layers_cnt_minus_1"], 1);
  assert.equal(values["metadata.scalability.spatial_layer_max_width[1]"], 1280);
  assert.equal(values["metadata.scalability.spatial_layer_ref_id[0]"], 255);
  assert.equal(values["metadata.scalability.temporal_group_size"], 2);
  assert.equal(values["metadata.scalability.temporal_group_temporal_id[1]"], 1);
  assert.equal(values["metadata.scalability.temporal_group_ref_pic_diff[1][0]"], 1);
  assert.deepEqual(report.obus[0].metadataSummary, {
    metadataType: 3, metadataTypeName: "SCALABILITY", scalabilityModeIdc: 14,
    spatialLayerCount: 2, temporalGroupSize: 2,
  });
});

test("parses complete timecode metadata including time offset", () => {
  const payload = new MetadataBits(5)
    .write(2, 5).write(1, 1).write(0, 1).write(1, 1).write(30, 9)
    .write(58, 6).write(59, 6).write(23, 5)
    .write(5, 5).write(21, 5)
    .finish();
  const report = analyzeBuffer(makeObu({ type: 5, payload }));
  const values = Object.fromEntries(report.syntaxNodes.map(({ path, value }) => [path, value]));

  assert.equal(report.obus[0].syntaxStatus, "complete");
  assert.equal(report.diagnostics.length, 0);
  assert.equal(values["metadata.timecode.counting_type"], 2);
  assert.equal(values["metadata.timecode.n_frames"], 30);
  assert.equal(values["metadata.timecode.seconds_value"], 58);
  assert.equal(values["metadata.timecode.minutes_value"], 59);
  assert.equal(values["metadata.timecode.hours_value"], 23);
  assert.equal(values["metadata.timecode.time_offset_length"], 5);
  assert.equal(values["metadata.timecode.time_offset_value"], 21);
  assert.deepEqual(report.obus[0].metadataSummary.timecode, {
    countingType: 2, nFrames: 30, seconds: 58, minutes: 59, hours: 23,
    timeOffsetLength: 5, timeOffsetValue: 21,
  });
});

test("diagnoses reserved scalability bits and out-of-range timecode fields", () => {
  const scalability = new MetadataBits(3)
    .write(14, 8).write(0, 2).write(0, 1).write(0, 1).write(0, 1).write(7, 3)
    .finish();
  const timecode = new MetadataBits(5)
    .write(1, 5).write(1, 1).write(0, 1).write(0, 1).write(0, 9)
    .write(60, 6).write(61, 6).write(24, 5).write(0, 5)
    .finish();
  const scalabilityReport = analyzeBuffer(makeObu({ type: 5, payload: scalability }));
  const timecodeReport = analyzeBuffer(makeObu({ type: 5, payload: timecode }));

  assert.ok(scalabilityReport.diagnostics.some(({ code }) => code === "SCALABILITY_RESERVED_BITS_SET"));
  assert.deepEqual(timecodeReport.diagnostics.map(({ code }) => code), [
    "TIMECODE_SECONDS_INVALID", "TIMECODE_MINUTES_INVALID", "TIMECODE_HOURS_INVALID",
  ]);
  assert.equal(timecodeReport.obus[0].syntaxStatus, "error");
});
