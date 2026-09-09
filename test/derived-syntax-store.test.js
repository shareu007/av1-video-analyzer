import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import {
  cleanupDerivedSyntaxStaging,
  listDerivedSyntaxSnapshots,
  readDerivedSyntaxIndex,
  readDerivedSyntaxSnapshot,
  writeDerivedSyntaxSnapshot,
} from "../src/derived-syntax-store.js";
import { inspectSnapshotObuPayload } from "../src/snapshot-inspector.js";
import { parseSequenceHeader } from "../src/sequence-header-parser.js";
import { parseFrameHeaderPrefix, sequenceContextFromNodes } from "../src/frame-header-parser.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { makeObu } from "./fixtures.js";

test("derived syntax snapshots are content-addressed, replayable and immutable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-derived-syntax-"));
  try {
    const input = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
    const report = analyzeBuffer(input, { sourceName: "sequence.obu" });
    const parent = await writeReportSnapshot(report, root);
    const record = report.obus[0];
    const payload = input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    const inspection = inspectSnapshotObuPayload(record, payload);

    const first = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection,
    });
    const second = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection,
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.derivedSnapshotId, first.derivedSnapshotId);
    assert.match(first.derivedSnapshotId, /^[0-9a-f]{64}$/);
    const replay = await readDerivedSyntaxSnapshot(root, first.derivedSnapshotId);
    assert.equal(replay.parentSnapshotId, parent.snapshotId);
    assert.equal(replay.request.obuId, 0);
    assert.equal(replay.request.payloadBytes, payload.length);
    assert.equal(replay.request.transport, "client-submitted-payload");
    assert.match(replay.request.payloadSha256, /^[0-9a-f]{64}$/);
    assert.match(replay.sourceBinding.verificationBoundary, /browser-sampled/);
    assert.equal(replay.inspection.nodes.length, 29);
    assert.equal(replay.provenance.parserVersion, report.provenance.parserVersion);
    await assert.rejects(
      writeDerivedSyntaxSnapshot(root, {
        parentSnapshotId: parent.snapshotId,
        obuId: record.obuId,
        payload: payload.subarray(0, 1),
        inspection: { ...inspection, inspectedPayloadBytes: 1 },
      }),
      /target payload length binding mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived syntax parent index rebuilds after store changes or cache corruption", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-derived-index-"));
  try {
    const input = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
    const report = analyzeBuffer(input);
    const parent = await writeReportSnapshot(report, root);
    const record = report.obus[0];
    const payload = input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    const inspection = inspectSnapshotObuPayload(record, payload);
    await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: 0,
      payload,
      inspection,
    });
    const first = await listDerivedSyntaxSnapshots(root, parent.snapshotId);
    assert.equal(first.total, 1);
    assert.match(first.indexId, /^[0-9a-f]{64}$/);
    const indexDirectory = path.join(root, "indexes", "derived-syntax", parent.snapshotId);
    const currentPath = path.join(indexDirectory, `${first.indexId}.json`);
    await writeFile(currentPath, "{broken");
    const repaired = await readDerivedSyntaxIndex(root, parent.snapshotId);
    assert.equal(repaired.indexId, first.indexId);
    assert.equal(repaired.entries.length, 1);
    assert.equal(JSON.parse(await readFile(currentPath, "utf8")).indexId, first.indexId);

    await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: 0,
      payload,
      inspection: { ...inspection, status: "partial" },
    });
    const changed = await listDerivedSyntaxSnapshots(root, parent.snapshotId);
    assert.equal(changed.total, 2);
    assert.notEqual(changed.indexId, first.indexId);
    assert.ok((await readdir(indexDirectory)).filter((name) => name.endsWith(".json")).length >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived syntax reader rejects content and parent binding tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-derived-tamper-"));
  try {
    const input = makeObu({ type: 5, payload: Buffer.from([1, 0, 1, 0, 2, 0x80]) });
    const report = analyzeBuffer(input, { sourceName: "metadata.obu" });
    const parent = await writeReportSnapshot(report, root);
    const record = report.obus[0];
    const payload = input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    const stored = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: 0,
      payload,
      inspection: inspectSnapshotObuPayload(record, payload),
    });
    const manifestPath = path.join(stored.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.inspection.status = "forged";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      readDerivedSyntaxSnapshot(root, stored.derivedSnapshotId),
      /content digest mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived syntax snapshot binds frame inspection to an earlier sequence header", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-derived-context-"));
  try {
    const input = Buffer.from(
      "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
      "base64",
    );
    const report = analyzeBuffer(input, { sourceName: "frame.ivf" });
    const parent = await writeReportSnapshot(report, root);
    const sequence = report.obus.find(({ type }) => type.code === 1);
    const frame = report.obus.find(({ type }) => type.code === 6);
    const payload = (record) => input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    const inspection = inspectSnapshotObuPayload(frame, payload(frame), {
      sequenceRecord: sequence,
      sequencePayload: payload(sequence),
    });
    const derived = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: frame.obuId,
      payload: payload(frame),
      sequenceObuId: sequence.obuId,
      sequencePayload: payload(sequence),
      inspection,
    });
    const replay = await readDerivedSyntaxSnapshot(root, derived.derivedSnapshotId);
    assert.equal(replay.request.sequenceContext.obuId, sequence.obuId);
    assert.equal(replay.inspection.summary.frameTypeName, "KEY_FRAME");
    await assert.rejects(
      writeDerivedSyntaxSnapshot(root, {
        parentSnapshotId: parent.snapshotId,
        obuId: frame.obuId,
        payload: payload(frame),
        sequenceObuId: frame.obuId,
        sequencePayload: payload(frame),
        inspection,
      }),
      /sequence context must precede/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived syntax snapshot content-addresses standalone Tile Group frame context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-derived-tile-context-"));
  try {
    const ivf = Buffer.from(
      "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
      "base64",
    );
    const source = analyzeBuffer(ivf);
    const sourceSequence = source.obus.find(({ type }) => type.code === 1);
    const sourceFrame = source.obus.find(({ type }) => type.code === 6);
    const sourcePayload = (record) => ivf.subarray(
      record.payloadRange.start, record.payloadRange.start + record.payloadRange.length,
    );
    const parsedSequence = parseSequenceHeader(sourcePayload(sourceSequence), {
      ...sourceSequence, payloadRange: { start: 0, length: sourcePayload(sourceSequence).length },
    });
    const parsedFrame = parseFrameHeaderPrefix(sourcePayload(sourceFrame), {
      ...sourceFrame, payloadRange: { start: 0, length: sourcePayload(sourceFrame).length },
    }, sequenceContextFromNodes(parsedSequence.nodes), { referenceSlots: Array(8).fill(null) });
    const headerBytes = Math.ceil(parsedFrame.parsedBitLength / 8);
    const input = Buffer.concat([
      makeObu({ type: 1, payload: sourcePayload(sourceSequence) }),
      makeObu({ type: 3, payload: sourcePayload(sourceFrame).subarray(0, headerBytes) }),
      makeObu({ type: 4, payload: sourcePayload(sourceFrame).subarray(headerBytes) }),
    ]);
    const report = analyzeBuffer(input, { sourceName: "tile-context.obu" });
    const parent = await writeReportSnapshot(report, root);
    const sequence = report.obus.find(({ type }) => type.code === 1);
    const frameHeader = report.obus.find(({ type }) => type.code === 3);
    const tileGroup = report.obus.find(({ type }) => type.code === 4);
    const payload = (record) => input.subarray(
      record.payloadRange.start, record.payloadRange.start + record.payloadRange.length,
    );
    const inspection = inspectSnapshotObuPayload(tileGroup, payload(tileGroup), {
      sequenceRecord: sequence,
      sequencePayload: payload(sequence),
      frameHeaderRecord: frameHeader,
      frameHeaderPayload: payload(frameHeader),
    });
    const derived = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: tileGroup.obuId,
      payload: payload(tileGroup),
      sequenceObuId: sequence.obuId,
      sequencePayload: payload(sequence),
      frameHeaderObuId: frameHeader.obuId,
      frameHeaderPayload: payload(frameHeader),
      inspection,
    });
    const replay = await readDerivedSyntaxSnapshot(root, derived.derivedSnapshotId);
    assert.equal(replay.request.frameHeaderContext.obuId, frameHeader.obuId);
    assert.match(replay.request.frameHeaderContext.payloadSha256, /^[0-9a-f]{64}$/);
    assert.equal(replay.inspection.summary.kind, "tile_group");
    await assert.rejects(writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: tileGroup.obuId,
      payload: payload(tileGroup),
      sequenceObuId: sequence.obuId,
      sequencePayload: payload(sequence),
      inspection,
    }), /frame context is missing/);
    await assert.rejects(writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: tileGroup.obuId,
      payload: payload(tileGroup),
      sequenceObuId: sequence.obuId,
      sequencePayload: payload(sequence),
      frameHeaderObuId: sequence.obuId,
      frameHeaderPayload: payload(sequence),
      inspection,
    }), /frame context parent binding mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derived syntax cleanup removes only old staging directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-derived-cleanup-"));
  try {
    const derivedRoot = path.join(root, "derived-syntax");
    const old = path.join(derivedRoot, ".pending.42.12345678-1234-1234-1234-123456789abc.tmp");
    const recent = path.join(derivedRoot, ".pending.43.12345678-1234-1234-1234-123456789abc.tmp");
    const unrelated = path.join(derivedRoot, ".pending-user-data.tmp");
    await mkdir(derivedRoot, { recursive: true });
    await Promise.all([mkdir(old), mkdir(recent), mkdir(unrelated)]);
    await utimes(old, new Date(1_000), new Date(1_000));
    assert.equal(await cleanupDerivedSyntaxStaging(root, {
      minimumAgeMs: 1_000,
      now: 3_000,
    }), 1);
    await assert.rejects(access(old), /ENOENT/);
    await access(recent);
    await access(unrelated);
    assert.equal(await cleanupDerivedSyntaxStaging(root, {
      minimumAgeMs: 10_000,
      now: 3_000,
    }), 0);
    await rm(recent, { recursive: true });
    await rm(unrelated, { recursive: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
