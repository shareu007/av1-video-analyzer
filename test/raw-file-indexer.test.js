import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRawFileSnapshotInput } from "../src/raw-file-indexer.js";
import {
  readReportSnapshot,
  readSnapshotPage,
  writeReportSnapshotStream,
} from "../src/snapshot-store.js";
import { makeObu } from "./fixtures.js";

test("raw file indexer streams OBU records directly into snapshot chunks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-raw-index-"));
  try {
    const inputPath = path.join(directory, "dense.obu");
    const snapshotRoot = path.join(directory, "snapshots");
    const unit = makeObu({ type: 15, payload: Buffer.alloc(24, 0x55) });
    await writeFile(inputPath, Buffer.concat(Array(2_500).fill(unit)));

    const input = await createRawFileSnapshotInput(inputPath, { maxObus: 3_000 });
    const snapshot = await writeReportSnapshotStream(input, snapshotRoot, { chunkSize: 1_000 });
    assert.equal(snapshot.manifest.collections.obus.count, 2_500);
    assert.equal(snapshot.manifest.collections.obus.chunks.length, 3);
    assert.equal(snapshot.manifest.header.summary.complete, true);
    assert.match(snapshot.manifest.header.provenance.implementation, /streaming-index/);

    const tail = await readSnapshotPage(snapshotRoot, snapshot.snapshotId, "obus", {
      offset: 2_499,
      limit: 1,
    });
    assert.deepEqual(tail.records[0].byteRange, {
      start: unit.length * 2_499,
      length: unit.length,
    });
    const report = await readReportSnapshot(snapshotRoot, snapshot.snapshotId);
    assert.equal(report.diagnostics[0].code, "SYNTAX_INDEX_DEFERRED");
    assert.equal(report.syntaxNodes.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw file indexer preserves truncated payload diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-raw-index-"));
  try {
    const inputPath = path.join(directory, "broken.obu");
    const snapshotRoot = path.join(directory, "snapshots");
    await writeFile(inputPath, Buffer.from([0x7a, 0x05, 0xaa, 0xbb]));
    const snapshot = await writeReportSnapshotStream(
      await createRawFileSnapshotInput(inputPath), snapshotRoot,
    );
    const report = await readReportSnapshot(snapshotRoot, snapshot.snapshotId);

    assert.equal(report.obus[0].complete, false);
    assert.equal(report.obus[0].declaredPayloadSize, 5);
    assert.equal(report.summary.complete, false);
    assert.ok(report.diagnostics.some(({ code }) => code === "OBU_PAYLOAD_TRUNCATED"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw file streaming index propagates cancellation and removes snapshot staging", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-raw-index-cancel-"));
  try {
    const inputPath = path.join(directory, "cancel.obu");
    const snapshotRoot = path.join(directory, "snapshots");
    await writeFile(inputPath, Buffer.concat(Array(10).fill(makeObu({ type: 2 }))));
    const controller = new AbortController();
    const input = await createRawFileSnapshotInput(inputPath, {
      signal: controller.signal,
      sourceName: "browser-selected.obu",
    });
    controller.abort();
    await assert.rejects(
      writeReportSnapshotStream(input, snapshotRoot),
      (error) => error.code === "INDEX_CANCELLED" && error.statusCode === 499,
    );
    assert.deepEqual(await readdir(snapshotRoot), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw file indexer refuses container input until a streaming demuxer is available", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-raw-index-"));
  try {
    const inputPath = path.join(directory, "sample.ivf");
    await writeFile(inputPath, Buffer.from("DKIF"));
    await assert.rejects(createRawFileSnapshotInput(inputPath), /raw low-overhead OBU/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw file indexer bounds records and preserves malformed header diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-raw-index-"));
  try {
    const snapshotRoot = path.join(directory, "snapshots");
    const densePath = path.join(directory, "bounded.obu");
    await writeFile(densePath, Buffer.concat(Array(5).fill(makeObu({ type: 2 }))));
    const bounded = await writeReportSnapshotStream(
      await createRawFileSnapshotInput(densePath, { maxObus: 3 }), snapshotRoot,
    );
    const boundedReport = await readReportSnapshot(snapshotRoot, bounded.snapshotId);
    assert.equal(boundedReport.obus.length, 3);
    assert.ok(boundedReport.diagnostics.some(({ code }) => code === "OBU_RECORD_LIMIT_REACHED"));

    const extensionPath = path.join(directory, "extension.obu");
    await writeFile(extensionPath, Buffer.from([0x36]));
    const extension = await writeReportSnapshotStream(
      await createRawFileSnapshotInput(extensionPath), snapshotRoot,
    );
    const extensionReport = await readReportSnapshot(snapshotRoot, extension.snapshotId);
    assert.equal(extensionReport.obus[0].complete, false);
    assert.ok(extensionReport.diagnostics.some(({ code }) => code === "OBU_EXTENSION_TRUNCATED"));

    const unsizedPath = path.join(directory, "unsized.obu");
    await writeFile(unsizedPath, makeObu({ type: 6, hasSizeField: false, payload: Buffer.from([1]) }));
    const unsized = await writeReportSnapshotStream(
      await createRawFileSnapshotInput(unsizedPath), snapshotRoot,
    );
    const unsizedReport = await readReportSnapshot(snapshotRoot, unsized.snapshotId);
    assert.ok(unsizedReport.diagnostics.some(({ code }) => code === "OBU_SIZE_FIELD_REQUIRED"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
