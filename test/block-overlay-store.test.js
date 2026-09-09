import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import {
  cleanupBlockOverlayStaging,
  listBlockOverlaySnapshots,
  readBlockOverlayManifest,
  readBlockOverlayPage,
  readBlockOverlaySnapshot,
  verifyBlockOverlaySnapshot,
  writeBlockOverlaySnapshot,
} from "../src/block-overlay-store.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";

const DEMO_IVF = Buffer.from(
  "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
  "base64",
);

function overlay() {
  return {
    schemaVersion: 1,
    provenance: { producer: "block-store-test", build: "fixed-test-build" },
    frames: [{ frameId: 0, blocks: [
      { x: 0, y: 0, width: 8, height: 16, partition: "vert", mode: "intra", qindex: 255,
        miRow: 0, miColumn: 0, compoundType: null, quantDelta: 163 },
      { x: 8, y: 0, width: 8, height: 16, partition: "none", mode: "skip", skip: true, qindex: null },
    ] }],
  };
}

test("block overlay store writes, reuses, pages and verifies chunked snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-block-overlay-store-"));
  try {
    const report = analyzeBuffer(DEMO_IVF, { sourceName: "demo.ivf" });
    const parent = await writeReportSnapshot(report, root);
    const created = await writeBlockOverlaySnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      overlay: overlay(),
    }, { chunkSize: 1 });
    assert.equal(created.created, true);
    assert.match(created.blockOverlaySnapshotId, /^[0-9a-f]{64}$/u);
    assert.equal(created.manifest.summary.frameCount, 1);
    assert.equal(created.manifest.summary.blockCount, 2);
    assert.equal(created.manifest.collections.blocks.chunks.length, 2);

    const reused = await writeBlockOverlaySnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      overlay: overlay(),
    }, { chunkSize: 2 });
    assert.equal(reused.created, false);
    assert.equal(reused.blockOverlaySnapshotId, created.blockOverlaySnapshotId);

    const framePage = await readBlockOverlayPage(
      root, created.blockOverlaySnapshotId, "frames", { offset: 0, limit: 1 },
    );
    assert.deepEqual(framePage.records, [{ frameId: 0, blockStart: 0, blockCount: 2 }]);
    const secondBlock = await readBlockOverlayPage(
      root, created.blockOverlaySnapshotId, "blocks", { offset: 1, limit: 1 },
    );
    assert.equal(secondBlock.records[0].frameId, 0);
    assert.equal(secondBlock.records[0].qindex, null);

    const replay = await readBlockOverlaySnapshot(root, created.blockOverlaySnapshotId);
    assert.equal(replay.frames[0].blocks[0].qindex, 255);
    assert.equal(replay.frames[0].blocks[0].miColumn, 0);
    assert.equal(replay.frames[0].blocks[0].quantDelta, 163);
    assert.equal(replay.frames[0].blocks[1].skip, true);
    assert.equal((await verifyBlockOverlaySnapshot(root, created.blockOverlaySnapshotId))
      .parentSnapshotId, parent.snapshotId);
    assert.deepEqual((await listBlockOverlaySnapshots(root, parent.snapshotId))
      .map(({ blockOverlaySnapshotId }) => blockOverlaySnapshotId), [created.blockOverlaySnapshotId]);

    const manifest = await readBlockOverlayManifest(root, created.blockOverlaySnapshotId);
    const damaged = path.join(
      root, "block-overlays", created.blockOverlaySnapshotId,
      manifest.collections.blocks.chunks[1].file,
    );
    await writeFile(damaged, `${await readFile(damaged, "utf8")} `);
    await assert.rejects(
      readBlockOverlayPage(root, created.blockOverlaySnapshotId, "blocks", { offset: 1, limit: 1 }),
      /checksum mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("block overlay staging cleanup only removes recognized old transactions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-block-overlay-cleanup-"));
  try {
    const overlayRoot = path.join(root, "block-overlays");
    const old = path.join(overlayRoot, ".pending.7.77777777-7777-4777-8777-777777777777.tmp");
    const recent = path.join(overlayRoot, ".pending.8.88888888-8888-4888-8888-888888888888.tmp");
    const unrelated = path.join(overlayRoot, "keep-me");
    await Promise.all([
      mkdir(old, { recursive: true }),
      mkdir(recent, { recursive: true }),
      mkdir(unrelated, { recursive: true }),
    ]);
    await utimes(old, new Date(0), new Date(0));
    await utimes(recent, new Date(9_000), new Date(9_000));
    assert.equal(await cleanupBlockOverlayStaging(root, {
      minimumAgeMs: 5_000,
      now: 10_000,
    }), 1);
    await assert.rejects(stat(old), { code: "ENOENT" });
    assert.equal((await stat(unrelated)).isDirectory(), true);
    assert.equal((await cleanupBlockOverlayStaging(root, { minimumAgeMs: 0, now: 10_000 })), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
