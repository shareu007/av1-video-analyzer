import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeIsoBmffPackets, analyzeMatroskaPackets } from "../src/analyzer.js";
import { createContainerFileSnapshotInput } from "../src/container-file-indexer.js";
import { InputFormat } from "../src/model.js";
import { readReportSnapshot, writeReportSnapshotStream } from "../src/snapshot-store.js";
import { makeObu } from "./fixtures.js";

function structuralObu(record) {
  return {
    obuId: record.obuId,
    frameId: record.frameId,
    type: record.type,
    header: record.header,
    byteRange: record.byteRange,
    headerRange: record.headerRange,
    sizeFieldRange: record.sizeFieldRange,
    payloadRange: record.payloadRange,
    declaredPayloadSize: record.declaredPayloadSize,
    complete: record.complete,
  };
}

async function commit(input, filename, format, probe) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-container-index-"));
  const inputPath = path.join(directory, filename);
  const snapshotRoot = path.join(directory, "snapshots");
  await writeFile(inputPath, input);
  const snapshot = await writeReportSnapshotStream(
    await createContainerFileSnapshotInput(inputPath, format, {
      probe: async () => probe,
    }),
    snapshotRoot,
  );
  return {
    report: await readReportSnapshot(snapshotRoot, snapshot.snapshotId),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("MP4 file indexer streams ffprobe packet ranges with eager-path parity", async () => {
  const sequence = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
  const padding = makeObu({ type: 15, payload: Buffer.from([0xaa]) });
  const packet = Buffer.concat([sequence, padding]);
  const input = Buffer.alloc(80);
  input.writeUInt32BE(20, 0);
  input.write("ftyp", 4, "ascii");
  packet.copy(input, 24);
  const probe = {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16, time_base: "1/30" }],
    packets: [{
      stream_index: 0, pts: 7, dts: 6, duration: 1,
      pos: "24", size: String(packet.length), flags: "K__",
    }],
  };
  const fixture = await commit(input, "sample.mp4", InputFormat.ISOBMFF, probe);
  try {
    const eager = analyzeIsoBmffPackets(input, probe, "sample.mp4");
    assert.deepEqual(fixture.report.frames, eager.frames);
    assert.deepEqual(fixture.report.obus.map(structuralObu), eager.obus.map(structuralObu));
    assert.deepEqual(fixture.report.container, eager.container);
    assert.deepEqual(fixture.report.frameStatistics, eager.frameStatistics);
    assert.deepEqual(
      fixture.report.frames.map(({ pts, dts, duration }) => ({ pts, dts, duration })),
      [{ pts: "7", dts: "6", duration: "1" }],
    );
    assert.equal(fixture.report.frameStatistics.timingMode, "explicit");
    assert.equal(fixture.report.summary.complete, true);
    assert.equal(fixture.report.diagnostics[0].code, "SYNTAX_INDEX_DEFERRED");
  } finally {
    await fixture.cleanup();
  }
});

test("WebM file indexer skips a Block header without loading packet payloads", async () => {
  const obu = makeObu({ type: 15, payload: Buffer.from([0xaa]) });
  const input = Buffer.alloc(40);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(input);
  Buffer.from([0x81, 0x00, 0x00, 0x80]).copy(input, 20);
  obu.copy(input, 24);
  const probe = {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16, time_base: "1/1000" }],
    packets: [{ stream_index: 0, pts: 0, pos: "20", size: String(obu.length), flags: "K__" }],
  };
  const fixture = await commit(input, "sample.webm", InputFormat.MATROSKA, probe);
  try {
    const eager = analyzeMatroskaPackets(input, probe, "sample.webm");
    assert.deepEqual(fixture.report.frames, eager.frames);
    assert.deepEqual(fixture.report.obus, eager.obus);
    assert.deepEqual(fixture.report.frameStatistics, eager.frameStatistics);
    assert.deepEqual(fixture.report.frames[0].payloadRange, { start: 24, length: obu.length });
    assert.equal(fixture.report.summary.complete, true);
  } finally {
    await fixture.cleanup();
  }
});

async function commitLacedBlock({ flags, laceHeader, payloads }) {
  const start = 20;
  const prefix = Buffer.alloc(start);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(prefix);
  const input = Buffer.concat([
    prefix, Buffer.from([0x81, 0x00, 0x00, flags]), laceHeader, ...payloads,
  ]);
  const probe = {
    streams: [{ index: 0, codec_name: "av1", width: 16, height: 16, time_base: "1/1000" }],
    packets: payloads.map((payload, index) => ({
      stream_index: 0,
      pts: index,
      pos: String(start),
      size: String(payload.length),
      flags: index === 0 ? "K__" : "___",
    })),
  };
  return { fixture: await commit(input, "laced.webm", InputFormat.MATROSKA, probe), input, probe };
}

test("WebM streaming index decodes Xiph, fixed and EBML lacing", async () => {
  const cases = [
    {
      flags: 0x02,
      payloads: [
        makeObu({ type: 15, payload: Buffer.from([0x11]) }),
        makeObu({ type: 15, payload: Buffer.from([0x22, 0x23]) }),
      ],
      laceHeader: null,
    },
    {
      flags: 0x04,
      payloads: [
        makeObu({ type: 15, payload: Buffer.from([0x31]) }),
        makeObu({ type: 15, payload: Buffer.from([0x32]) }),
      ],
      laceHeader: Buffer.from([1]),
    },
    {
      flags: 0x06,
      payloads: [
        makeObu({ type: 15, payload: Buffer.from([0x41]) }),
        makeObu({ type: 15, payload: Buffer.from([0x42, 0x43]) }),
        makeObu({ type: 15, payload: Buffer.from([0x44]) }),
      ],
      laceHeader: Buffer.from([2, 0x83, 0xc0]),
    },
  ];
  cases[0].laceHeader = Buffer.from([1, cases[0].payloads[0].length]);

  for (const item of cases) {
    const { fixture, input, probe } = await commitLacedBlock(item);
    try {
      const eager = analyzeMatroskaPackets(input, probe, "laced.webm");
      assert.deepEqual(fixture.report.frames, eager.frames);
      assert.deepEqual(fixture.report.obus.map(structuralObu), eager.obus.map(structuralObu));
      assert.equal(fixture.report.summary.complete, true);
    } finally {
      await fixture.cleanup();
    }
  }
});
