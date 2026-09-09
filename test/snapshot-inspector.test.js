import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { inspectSnapshotObuPayload } from "../src/snapshot-inspector.js";
import { parseSequenceHeader } from "../src/sequence-header-parser.js";
import { parseFrameHeaderPrefix, sequenceContextFromNodes } from "../src/frame-header-parser.js";
import { makeObu } from "./fixtures.js";

test("snapshot inspector remaps sequence syntax nodes to absolute source bits", () => {
  const prefix = Buffer.alloc(137, 0x55);
  const sequence = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
  const eager = analyzeBuffer(Buffer.concat([prefix, sequence]).subarray(prefix.length));
  const original = eager.obus[0];
  const record = {
    ...original,
    byteRange: { start: original.byteRange.start + prefix.length, length: original.byteRange.length },
    headerRange: { start: original.headerRange.start + prefix.length, length: original.headerRange.length },
    sizeFieldRange: { start: original.sizeFieldRange.start + prefix.length, length: original.sizeFieldRange.length },
    payloadRange: { start: original.payloadRange.start + prefix.length, length: original.payloadRange.length },
  };
  const result = inspectSnapshotObuPayload(record, sequence.subarray(2));

  assert.equal(result.status, "complete");
  assert.equal(result.nodes.length, 29);
  assert.equal(result.inspectedPayloadBytes, record.payloadRange.length);
  assert.equal(result.nodes[0].bitRange.startBit, record.payloadRange.start * 8);
  assert.equal(result.nodes.at(-1).bitRange.startBit, record.payloadRange.start * 8 + 47);
});

test("snapshot inspector parses metadata and rejects unsupported payload types", () => {
  const metadata = makeObu({ type: 5, payload: Buffer.from([0x01, 0x03, 0xe8, 0x01, 0x90, 0x80]) });
  const report = analyzeBuffer(metadata);
  const record = report.obus[0];
  const result = inspectSnapshotObuPayload(record, metadata.subarray(2));
  assert.equal(result.summary.metadataTypeName, "HDR_CLL");
  assert.throws(
    () => inspectSnapshotObuPayload({ ...record, type: { code: 15, name: "padding" } }, Buffer.from([0])),
    /no supported payload inspector/,
  );
});

test("snapshot inspector uses a complete sequence header context for frame payloads", () => {
  const ivf = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  const report = analyzeBuffer(ivf);
  const sequenceRecord = report.obus.find(({ type }) => type.code === 1);
  const frameRecord = report.obus.find(({ type }) => type.code === 6);
  assert.equal(frameRecord.syntaxStatus, "complete");
  assert.equal(frameRecord.tileGroupSummary.completeFrame, true);
  assert.deepEqual(frameRecord.tileGroupSummary.tiles.map(({ tileSize }) => tileSize), [5]);
  const payload = (record) => ivf.subarray(
    record.payloadRange.start,
    record.payloadRange.start + record.payloadRange.length,
  );
  const result = inspectSnapshotObuPayload(frameRecord, payload(frameRecord), {
    sequenceRecord,
    sequencePayload: payload(sequenceRecord),
  });

  assert.equal(result.status, frameRecord.syntaxStatus);
  assert.equal(result.summary.frameTypeName, "KEY_FRAME");
  assert.equal(result.tileGroupSummary.kind, "tile_group");
  assert.equal(result.tileGroupSummary.embeddedFrame, true);
  assert.equal(result.tileGroupSummary.completeFrame, true);
  assert.equal(result.parsedBitLength, payload(frameRecord).length * 8);
  assert.ok(result.nodes.length > 10);
  assert.ok(result.nodes.every(({ bitRange }) =>
    bitRange === null || bitRange.startBit >= frameRecord.payloadRange.start * 8));
  assert.throws(
    () => inspectSnapshotObuPayload(frameRecord, payload(frameRecord), {
      sequenceRecord,
      sequencePayload: payload(sequenceRecord).subarray(0, 1),
    }),
    /sequence payload length does not match/,
  );
});

function standaloneTileGroupFixture() {
  const ivf = Buffer.from(
    "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
    "base64",
  );
  const eager = analyzeBuffer(ivf);
  const sourceSequence = eager.obus.find(({ type }) => type.code === 1);
  const sourceFrame = eager.obus.find(({ type }) => type.code === 6);
  const sourcePayload = (record) => ivf.subarray(
    record.payloadRange.start,
    record.payloadRange.start + record.payloadRange.length,
  );
  const sequenceParsed = parseSequenceHeader(
    sourcePayload(sourceSequence),
    { ...sourceSequence, payloadRange: { start: 0, length: sourcePayload(sourceSequence).length } },
  );
  const frameParsed = parseFrameHeaderPrefix(
    sourcePayload(sourceFrame),
    { ...sourceFrame, payloadRange: { start: 0, length: sourcePayload(sourceFrame).length } },
    sequenceContextFromNodes(sequenceParsed.nodes),
    { referenceSlots: Array(8).fill(null) },
  );
  const headerBytes = Math.ceil(frameParsed.parsedBitLength / 8);
  const input = Buffer.concat([
    makeObu({ type: 1, payload: sourcePayload(sourceSequence) }),
    makeObu({ type: 3, payload: sourcePayload(sourceFrame).subarray(0, headerBytes) }),
    makeObu({ type: 4, payload: sourcePayload(sourceFrame).subarray(headerBytes) }),
  ]);
  const report = analyzeBuffer(input, { sourceName: "standalone-tile-group.obu" });
  const payload = (record) => input.subarray(
    record.payloadRange.start,
    record.payloadRange.start + record.payloadRange.length,
  );
  return {
    input,
    report,
    payload,
    sequence: report.obus.find(({ type }) => type.code === 1),
    frameHeader: report.obus.find(({ type }) => type.code === 3),
    tileGroup: report.obus.find(({ type }) => type.code === 4),
  };
}

test("snapshot inspector binds standalone Tile Group parsing to both header contexts", () => {
  const fixture = standaloneTileGroupFixture();
  assert.equal(fixture.report.diagnostics.length, 0);
  assert.equal(fixture.tileGroup.tileGroupSummary.completeFrame, true);
  const result = inspectSnapshotObuPayload(
    fixture.tileGroup,
    fixture.payload(fixture.tileGroup),
    {
      sequenceRecord: fixture.sequence,
      sequencePayload: fixture.payload(fixture.sequence),
      frameHeaderRecord: fixture.frameHeader,
      frameHeaderPayload: fixture.payload(fixture.frameHeader),
    },
  );
  assert.equal(result.status, "complete");
  assert.equal(result.summary.contextFrameHeaderObuId, fixture.frameHeader.obuId);
  assert.deepEqual(result.summary.tiles.map(({ tileSize }) => tileSize), [5]);
  assert.ok(result.nodes.every(({ bitRange }) =>
    bitRange === null || bitRange.startBit >= fixture.tileGroup.payloadRange.start * 8));
  assert.throws(
    () => inspectSnapshotObuPayload(
      fixture.tileGroup,
      fixture.payload(fixture.tileGroup),
      {
        sequenceRecord: fixture.sequence,
        sequencePayload: fixture.payload(fixture.sequence),
      },
    ),
    /requires a Frame Header context/,
  );
});
