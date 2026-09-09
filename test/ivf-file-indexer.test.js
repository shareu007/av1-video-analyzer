import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { createIvfFileSnapshotInput } from "../src/ivf-file-indexer.js";
import { readReportSnapshot, writeReportSnapshotStream } from "../src/snapshot-store.js";
import { makeIvf, makeObu } from "./fixtures.js";

test("IVF file indexer streams frame and OBU ranges with eager-path parity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-ivf-index-"));
  try {
    const inputPath = path.join(directory, "sample.ivf");
    const snapshotRoot = path.join(directory, "snapshots");
    const units = [0xaa, 0xbb, 0xcc].map((value) =>
      makeObu({ type: 15, payload: Buffer.from([value]) }),
    );
    const input = makeIvf([
      { payload: Buffer.concat([units[0], units[1]]), timestamp: 7n },
      { payload: units[2], timestamp: 9n },
    ]);
    await writeFile(inputPath, input);
    const snapshot = await writeReportSnapshotStream(
      await createIvfFileSnapshotInput(inputPath), snapshotRoot, { chunkSize: 1 },
    );
    const streamed = await readReportSnapshot(snapshotRoot, snapshot.snapshotId);
    const eager = analyzeBuffer(input, { sourceName: inputPath });

    assert.deepEqual(streamed.frames, eager.frames);
    assert.deepEqual(streamed.obus, eager.obus);
    assert.deepEqual(streamed.container, eager.container);
    assert.deepEqual(streamed.frameStatistics, eager.frameStatistics);
    assert.deepEqual(
      streamed.frames.map(({ pts, dts, duration }) => ({ pts, dts, duration })),
      [
        { pts: "7", dts: "7", duration: null },
        { pts: "9", dts: "9", duration: null },
      ],
    );
    assert.equal(streamed.frameStatistics.timingMode, "inferred");
    assert.equal(streamed.frameStatistics.gop.count, 1);
    assert.equal(streamed.summary.frameCount, 2);
    assert.equal(streamed.summary.obuCount, 3);
    assert.equal(streamed.summary.complete, true);
    assert.equal(streamed.diagnostics[0].code, "SYNTAX_INDEX_DEFERRED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("IVF file indexer bounds frame records and reports incomplete snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-ivf-index-"));
  try {
    const inputPath = path.join(directory, "bounded.ivf");
    const snapshotRoot = path.join(directory, "snapshots");
    const unit = makeObu({ type: 15, payload: Buffer.from([0xaa]) });
    await writeFile(inputPath, makeIvf([
      { payload: unit, timestamp: 0n },
      { payload: unit, timestamp: 1n },
      { payload: unit, timestamp: 2n },
    ]));
    const snapshot = await writeReportSnapshotStream(
      await createIvfFileSnapshotInput(inputPath, { maxFrames: 2 }), snapshotRoot,
    );
    const report = await readReportSnapshot(snapshotRoot, snapshot.snapshotId);

    assert.equal(report.frames.length, 2);
    assert.equal(report.frameStatistics.frameCount, 2);
    assert.equal(report.obus.length, 2);
    assert.equal(report.summary.complete, false);
    assert.ok(report.diagnostics.some(({ code }) => code === "FRAME_RECORD_LIMIT_REACHED"));
    assert.ok(report.diagnostics.some(({ code }) => code === "IVF_FRAME_COUNT_MISMATCH"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
