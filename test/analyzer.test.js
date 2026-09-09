import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeBuffer,
  analyzeIsoBmffPackets,
  analyzeMatroskaPackets,
  analyzeMediaBuffer,
  detectInputFormat,
} from "../src/analyzer.js";
import { stringifyReport } from "../src/json.js";
import { InputFormat } from "../src/model.js";
import { makeIvf, makeObu } from "./fixtures.js";

test("detects IVF and low-overhead OBU input", () => {
  assert.equal(detectInputFormat(Buffer.from("DKIF")), InputFormat.IVF);
  assert.equal(
    detectInputFormat(makeObu({ type: 1 })),
    InputFormat.LOW_OVERHEAD_OBU,
  );
  const mp4 = Buffer.alloc(12);
  mp4.write("ftyp", 4, "ascii");
  assert.equal(detectInputFormat(mp4), InputFormat.ISOBMFF);
  assert.equal(
    detectInputFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    InputFormat.MATROSKA,
  );
});

test("asynchronous container analysis forwards cancellation to the packet probe", async () => {
  const input = Buffer.alloc(12);
  input.write("ftyp", 4, "ascii");
  const controller = new AbortController();
  let receivedSignal = null;

  await analyzeMediaBuffer(input, {
    signal: controller.signal,
    probe: async (_buffer, options) => {
      receivedSignal = options.signal;
      return { streams: [], packets: [] };
    },
  });

  assert.equal(receivedSignal, controller.signal);
});

test("indexes ISO BMFF AV1 packet ranges supplied by ffprobe", () => {
  const sequence = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
  const frame = makeObu({ type: 6, payload: Buffer.from([0x00]), hasSizeField: false });
  const packet = Buffer.concat([sequence, frame]);
  const input = Buffer.alloc(64);
  input.writeUInt32BE(20, 0);
  input.write("ftyp", 4, "ascii");
  packet.copy(input, 24);
  const report = analyzeIsoBmffPackets(input, {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16, time_base: "1/30" }],
    packets: [{
      stream_index: 0, pts: 7, dts: 6, duration: 1,
      pos: "24", size: String(packet.length), flags: "K__",
    }],
  }, "clip.mp4");

  assert.equal(report.source.format, InputFormat.ISOBMFF);
  assert.deepEqual(report.frames[0].payloadRange, { start: 24, length: packet.length });
  assert.equal(report.frames[0].timestamp, "7");
  assert.equal(report.frames[0].pts, "7");
  assert.equal(report.frames[0].dts, "6");
  assert.equal(report.frames[0].duration, "1");
  assert.equal(report.frames[0].keyframe, true);
  assert.equal(report.frameStatistics.timingMode, "explicit");
  assert.equal(
    report.frameStatistics.averageBitrateBitsPerSecond,
    packet.length * 8 * 30,
  );
  assert.deepEqual(report.obus.map(({ type }) => type.name), ["sequence_header", "frame"]);
  assert.equal(report.obus[0].byteRange.start, 24);
});

test("skips a Matroska Block header and preserves AV1 payload offsets", () => {
  const obu = makeObu({ type: 15, payload: Buffer.from([0xaa]) });
  const input = Buffer.alloc(40);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(input);
  Buffer.from([0x81, 0x00, 0x00, 0x80]).copy(input, 20);
  obu.copy(input, 24);
  const report = analyzeMatroskaPackets(input, {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16, time_base: "1/1000" }],
    packets: [{ stream_index: 0, pts: 0, pos: "20", size: String(obu.length), flags: "K__" }],
  }, "clip.webm");

  assert.equal(report.source.format, InputFormat.MATROSKA);
  assert.deepEqual(report.frames[0].payloadRange, { start: 24, length: obu.length });
  assert.equal(report.obus[0].byteRange.start, 24);
  assert.equal(report.summary.complete, true);
});

function analyzeLacedBlock({ flags, laceHeader, payloads }, options = {}) {
  const start = 20;
  const blockHeader = Buffer.from([0x81, 0x00, 0x00, flags]);
  const input = Buffer.alloc(start);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(input);
  const full = Buffer.concat([input, blockHeader, laceHeader, ...payloads]);
  return analyzeMatroskaPackets(full, {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16, time_base: "1/1000" }],
    packets: payloads.map((payload, index) => ({
      stream_index: 0, pts: index, pos: String(start), size: String(payload.length), flags: index === 0 ? "K__" : "___",
    })),
  }, "laced.webm", options);
}

test("indexes Xiph-laced Matroska packets at absolute payload offsets", () => {
  const payloads = [
    makeObu({ type: 15, payload: Buffer.from([0x11]) }),
    makeObu({ type: 15, payload: Buffer.from([0x22, 0x23]) }),
  ];
  const report = analyzeLacedBlock({ flags: 0x02, laceHeader: Buffer.from([1, payloads[0].length]), payloads });
  const firstStart = 20 + 4 + 2;

  assert.deepEqual(report.frames.map(({ payloadRange }) => payloadRange), [
    { start: firstStart, length: payloads[0].length },
    { start: firstStart + payloads[0].length, length: payloads[1].length },
  ]);
  assert.equal(report.diagnostics.length, 0);
});

test("indexes fixed-size Matroska laces", () => {
  const payloads = [
    makeObu({ type: 15, payload: Buffer.from([0x31]) }),
    makeObu({ type: 15, payload: Buffer.from([0x32]) }),
  ];
  const report = analyzeLacedBlock({ flags: 0x04, laceHeader: Buffer.from([1]), payloads });
  const firstStart = 20 + 4 + 1;

  assert.deepEqual(report.frames.map(({ payloadRange }) => payloadRange), [
    { start: firstStart, length: payloads[0].length },
    { start: firstStart + payloads[0].length, length: payloads[1].length },
  ]);
  assert.equal(report.diagnostics.length, 0);
});

test("indexes EBML-laced Matroska packets with signed size differences", () => {
  const payloads = [
    makeObu({ type: 15, payload: Buffer.from([0x41]) }),
    makeObu({ type: 15, payload: Buffer.from([0x42, 0x43]) }),
    makeObu({ type: 15, payload: Buffer.from([0x44]) }),
  ];
  // 3 laces, first size 3 (0x83), second size delta +1 (signed VINT 0xc0).
  const report = analyzeLacedBlock({ flags: 0x06, laceHeader: Buffer.from([2, 0x83, 0xc0]), payloads });
  const firstStart = 20 + 4 + 3;

  assert.deepEqual(report.frames.map(({ payloadRange }) => payloadRange), [
    { start: firstStart, length: payloads[0].length },
    { start: firstStart + payloads[0].length, length: payloads[1].length },
    { start: firstStart + payloads[0].length + payloads[1].length, length: payloads[2].length },
  ]);
  assert.equal(report.diagnostics.length, 0);
});

test("diagnoses a Matroska lace-count mismatch without guessing payload boundaries", () => {
  const payload = makeObu({ type: 15, payload: Buffer.from([0x51]) });
  const report = analyzeLacedBlock({ flags: 0x02, laceHeader: Buffer.from([1, payload.length]), payloads: [payload] });

  assert.equal(report.frames.length, 0);
  assert.equal(report.diagnostics[0].code, "MATROSKA_BLOCK_HEADER_INVALID");
  assert.match(report.diagnostics[0].message, /declares 2 laces/);
  assert.equal(report.summary.complete, false);
});

test("Matroska lacing respects the frame-record budget", () => {
  const payloads = [0x61, 0x62, 0x63].map((value) =>
    makeObu({ type: 15, payload: Buffer.from([value]) }),
  );
  const report = analyzeLacedBlock({
    flags: 0x04, laceHeader: Buffer.from([2]), payloads,
  }, { maxFrames: 2 });

  assert.equal(report.frames.length, 2);
  assert.equal(report.obus.length, 2);
  assert.equal(report.diagnostics[0].code, "FRAME_RECORD_LIMIT_REACHED");
  assert.equal(report.summary.complete, false);
});

test("ISO BMFF packet indexing respects the frame-record budget", () => {
  const units = [0x71, 0x72, 0x73].map((value) =>
    makeObu({ type: 15, payload: Buffer.from([value]) }),
  );
  const input = Buffer.concat(units);
  let cursor = 0;
  const packets = units.map((unit, index) => {
    const packet = { stream_index: 0, pts: index, pos: String(cursor), size: String(unit.length) };
    cursor += unit.length;
    return packet;
  });
  const report = analyzeIsoBmffPackets(input, {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16 }], packets,
  }, "bounded.mp4", { maxFrames: 2 });

  assert.equal(report.frames.length, 2);
  assert.equal(report.obus.length, 2);
  assert.equal(report.diagnostics.at(-1).code, "FRAME_RECORD_LIMIT_REACHED");
  assert.equal(report.summary.complete, false);
});

test("indexes an IVF frame and its OBU with absolute ranges", () => {
  const obu = makeObu({ type: 15, payload: Buffer.from([0xaa, 0xbb]) });
  const ivf = makeIvf([{ payload: obu, timestamp: 7n }]);
  const report = analyzeBuffer(ivf, { sourceName: "/private/video.ivf" });

  assert.equal(report.source.name, "video.ivf");
  assert.equal(report.source.format, "ivf");
  assert.deepEqual(report.container.timebase, { rate: 30, scale: 1 });
  assert.equal(report.frames.length, 1);
  assert.deepEqual(report.frames[0].sampleRange, { start: 32, length: 16 });
  assert.deepEqual(report.frames[0].payloadRange, { start: 44, length: 4 });
  assert.equal(report.frames[0].timestamp, "7");
  assert.deepEqual(report.frames[0].obuIds, [0]);
  assert.deepEqual(report.obus[0].byteRange, { start: 44, length: 4 });
  assert.equal(report.summary.complete, true);
});

test("keeps a partial IVF frame and reports its declared-size mismatch", () => {
  const obu = makeObu({ type: 6, payload: Buffer.from([0xaa]) });
  const ivf = makeIvf([{ payload: obu, declaredSize: obu.length + 9 }]);
  const report = analyzeBuffer(ivf);

  assert.equal(report.frames.length, 1);
  assert.equal(report.frames[0].complete, false);
  assert.equal(report.frames[0].payloadRange.length, obu.length);
  assert.ok(
    report.diagnostics.some(
      ({ code }) => code === "IVF_FRAME_PAYLOAD_TRUNCATED",
    ),
  );
  assert.equal(report.summary.complete, false);
});

test("reports the IVF declared frame count independently of indexed frames", () => {
  const ivf = makeIvf([], { declaredFrameCount: 2 });
  const report = analyzeBuffer(ivf);

  assert.equal(report.summary.frameCount, 0);
  assert.equal(report.diagnostics[0].code, "IVF_FRAME_COUNT_MISMATCH");
  assert.equal(report.summary.warningCount, 1);
});

test("a truncated DKIF signature is treated as an incomplete IVF header", () => {
  const report = analyzeBuffer(Buffer.from("DKIF"));
  assert.equal(report.source.format, "ivf");
  assert.equal(report.diagnostics[0].code, "IVF_HEADER_TRUNCATED");
  assert.equal(report.summary.errorCount, 1);
});

test("canonical JSON is deterministic and path-redacted to a basename", () => {
  const input = makeObu({ type: 2 });
  const first = stringifyReport(
    analyzeBuffer(input, { sourceName: "/one/location/sample.obu" }),
  );
  const second = stringifyReport(
    analyzeBuffer(input, { sourceName: "/another/location/sample.obu" }),
  );
  assert.equal(first, second);
  assert.match(first, /"name": "sample\.obu"/);
  assert.doesNotMatch(first, /another|location/);
});

test("an empty raw input is diagnosed instead of throwing", () => {
  const report = analyzeBuffer(Buffer.alloc(0));
  assert.equal(report.diagnostics[0].code, "INPUT_EMPTY");
  assert.equal(report.summary.complete, false);
});

test("analysis publishes an incomplete bounded report after the OBU record limit", () => {
  const unit = makeObu({ type: 2 });
  const report = analyzeBuffer(Buffer.concat(Array(5).fill(unit)), { maxObus: 3 });

  assert.equal(report.obus.length, 3);
  assert.equal(report.summary.obuCount, 3);
  assert.equal(report.summary.complete, false);
  assert.equal(report.summary.errorCount, 1);
  assert.equal(report.diagnostics[0].code, "OBU_RECORD_LIMIT_REACHED");
});

test("analysis stops before a syntax OBU that would exceed the node budget", () => {
  const sequence = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
  const report = analyzeBuffer(Buffer.concat([sequence, sequence]), { maxSyntaxNodes: 29 });

  assert.equal(report.obus.length, 2);
  assert.equal(report.syntaxNodes.length, 29);
  assert.equal(report.obus[0].syntaxStatus, "complete");
  assert.equal(report.obus[1].syntaxStatus, "pending");
  assert.equal(report.summary.complete, false);
  assert.equal(report.diagnostics[0].code, "SYNTAX_NODE_LIMIT_REACHED");
});

test("IVF indexing stops at the configured frame-record budget", () => {
  const payload = makeObu({ type: 15, payload: Buffer.from([0xaa]) });
  const report = analyzeBuffer(makeIvf([
    { payload, timestamp: 0n }, { payload, timestamp: 1n }, { payload, timestamp: 2n },
  ]), { maxFrames: 2 });

  assert.equal(report.frames.length, 2);
  assert.equal(report.summary.frameCount, 2);
  assert.equal(report.summary.complete, false);
  assert.ok(report.diagnostics.some(({ code }) => code === "FRAME_RECORD_LIMIT_REACHED"));
});
