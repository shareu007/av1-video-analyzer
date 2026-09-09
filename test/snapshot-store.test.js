import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { stringifyReport } from "../src/json.js";
import {
  cleanupSnapshotStaging,
  computeSnapshotId,
  readReportSnapshot,
  readSnapshotPage,
  verifyReportSnapshot,
  writeReportSnapshot,
  writeReportSnapshotStream,
} from "../src/snapshot-store.js";
import { makeIvf, makeObu } from "./fixtures.js";

test("snapshot store atomically commits, pages and rebuilds a report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshots-"));
  try {
    const sequenceHeader = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
    const padding = makeObu({ type: 15, payload: Buffer.from([0xaa]) });
    const report = analyzeBuffer(makeIvf([{ payload: Buffer.concat([sequenceHeader, padding]) }]));
    const first = await writeReportSnapshot(report, root, { chunkSize: 1 });

    assert.equal(first.created, true);
    assert.match(first.snapshotId, /^[0-9a-f]{64}$/);
    assert.equal(first.manifest.collections.obus.chunks.length, 2);
    const page = await readSnapshotPage(root, first.snapshotId, "obus", { offset: 1, limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].type.name, "padding");

    const rebuilt = await readReportSnapshot(root, first.snapshotId);
    assert.equal(stringifyReport(rebuilt), stringifyReport(report));
    const repeated = await writeReportSnapshot(report, root, { chunkSize: 20 });
    assert.equal(repeated.created, false);
    assert.equal(repeated.snapshotId, first.snapshotId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot store rejects a modified chunk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshots-"));
  try {
    const report = analyzeBuffer(makeObu({ type: 2 }));
    const snapshot = await writeReportSnapshot(report, root, { chunkSize: 1 });
    const manifest = JSON.parse(await readFile(
      path.join(snapshot.directory, "manifest.json"), "utf8",
    ));
    const file = manifest.collections.obus.chunks[0].file;
    await writeFile(path.join(snapshot.directory, file), "[]\n");

    await assert.rejects(
      readSnapshotPage(root, snapshot.snapshotId, "obus"),
      /checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot store rejects a discontinuous manifest before paging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshots-"));
  try {
    const report = analyzeBuffer(makeObu({ type: 2 }));
    const snapshot = await writeReportSnapshot(report, root, { chunkSize: 1 });
    const manifestPath = path.join(snapshot.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.collections.obus.chunks[0].start = 2;
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      readSnapshotPage(root, snapshot.snapshotId, "obus"),
      /invalid chunk metadata/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot store rejects modified manifest header data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshots-"));
  try {
    const report = analyzeBuffer(makeObu({ type: 2 }), { sourceName: "original.obu" });
    const snapshot = await writeReportSnapshot(report, root);
    const manifestPath = path.join(snapshot.directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.header.source.name = "modified.obu";
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      readSnapshotPage(root, snapshot.snapshotId, "obus"),
      /manifest payload checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming snapshot writer consumes one-pass collections without changing the ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshots-"));
  try {
    const report = analyzeBuffer(Buffer.concat(Array(5).fill(makeObu({ type: 2 }))));
    const { frames, obus, syntaxNodes, diagnostics, ...header } = report;
    let yielded = 0;
    async function* obuRecords() {
      for (const record of obus) {
        yielded += 1;
        yield record;
      }
    }
    const snapshot = await writeReportSnapshotStream({
      header,
      collections: { frames, obus: obuRecords(), syntaxNodes, diagnostics },
    }, root, { chunkSize: 2 });

    assert.equal(yielded, 5);
    assert.equal(snapshot.snapshotId, computeSnapshotId(report));
    assert.equal(snapshot.manifest.collections.obus.chunks.length, 3);
    assert.equal((await verifyReportSnapshot(root, snapshot.snapshotId)).snapshotId, snapshot.snapshotId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot staging cleanup only removes recognized expired transaction directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-snapshots-"));
  try {
    const pending = ".pending.123.00000000-0000-4000-8000-000000000000.tmp";
    await mkdir(path.join(root, pending));
    await mkdir(path.join(root, "keep.tmp"));

    assert.equal(await cleanupSnapshotStaging(root, { minimumAgeMs: 0 }), 1);
    assert.deepEqual(await readdir(root), ["keep.tmp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
