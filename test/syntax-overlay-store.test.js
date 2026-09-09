import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import {
  listDerivedSyntaxSnapshots,
  writeDerivedSyntaxSnapshot,
} from "../src/derived-syntax-store.js";
import { inspectSnapshotObuPayload } from "../src/snapshot-inspector.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import {
  cleanupSyntaxOverlayStaging,
  readSyntaxOverlayManifest,
  readSyntaxOverlayPage,
  readSyntaxOverlaySnapshot,
  verifySyntaxOverlaySnapshot,
  writeSyntaxOverlaySnapshot,
} from "../src/syntax-overlay-store.js";
import { makeObu } from "./fixtures.js";

async function createFixture(root) {
  const sequence = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
  const metadata = makeObu({
    type: 5,
    payload: Buffer.from([0x01, 0x03, 0xe8, 0x01, 0x90, 0x80]),
  });
  const input = Buffer.concat([sequence, metadata]);
  const report = analyzeBuffer(input, { sourceName: "overlay.obu" });
  const parent = await writeReportSnapshot(report, root);
  const derived = [];
  for (const record of report.obus) {
    const payload = input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    derived.push(await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection: inspectSnapshotObuPayload(record, payload),
    }));
  }
  return { input, report, parent, derived };
}

test("syntax overlay merges derived fields with stable global node IDs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-syntax-overlay-"));
  try {
    const fixture = await createFixture(root);
    const ids = fixture.derived.map(({ derivedSnapshotId }) => derivedSnapshotId).reverse();
    const first = await writeSyntaxOverlaySnapshot(root, {
      parentSnapshotId: fixture.parent.snapshotId,
      derivedSnapshotIds: ids,
    }, { chunkSize: 10 });
    const second = await writeSyntaxOverlaySnapshot(root, {
      parentSnapshotId: fixture.parent.snapshotId,
      derivedSnapshotIds: [...ids].reverse(),
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.manifest, null);
    assert.equal(second.overlaySnapshotId, first.overlaySnapshotId);
    assert.equal(
      (await verifySyntaxOverlaySnapshot(root, first.overlaySnapshotId)).overlaySnapshotId,
      first.overlaySnapshotId,
    );
    const replay = await readSyntaxOverlaySnapshot(root, first.overlaySnapshotId);
    assert.equal(replay.parentSnapshotId, fixture.parent.snapshotId);
    assert.deepEqual(replay.provenance.contributors.map(({ obuId }) => obuId), [0, 1]);
    assert.deepEqual(replay.syntaxNodes.map(({ nodeId }) => nodeId),
      Array.from({ length: replay.syntaxNodes.length }, (_, index) => index));
    assert.ok(replay.syntaxNodes.every(({ sourceNodeId, derivedSnapshotId }) =>
      Number.isSafeInteger(sourceNodeId) && /^[0-9a-f]{64}$/.test(derivedSnapshotId)));
    assert.equal(replay.summary.coveredObuCount, 2);
    assert.equal(replay.summary.syntaxNodeCount,
      fixture.derived.reduce((sum, item) => sum + item.manifest.inspection.nodes.length, 0));
    assert.equal(replay.summary.complete, true);
    const storageManifest = await readSyntaxOverlayManifest(root, first.overlaySnapshotId);
    assert.equal(storageManifest.storageLayout, "chunked-v1");
    assert.ok(storageManifest.collections.syntaxNodes.chunks.length > 1);
    assert.equal(storageManifest.syntaxNodes, undefined);
    const crossChunk = await readSyntaxOverlayPage(
      root, first.overlaySnapshotId, "syntaxNodes", { offset: 8, limit: 5 },
    );
    assert.deepEqual(crossChunk.records.map(({ nodeId }) => nodeId), [8, 9, 10, 11, 12]);

    const page = await listDerivedSyntaxSnapshots(root, fixture.parent.snapshotId, {
      offset: 1,
      limit: 1,
    });
    assert.equal(page.total, 2);
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0].obuId, 1);

    const lastChunk = storageManifest.collections.syntaxNodes.chunks.at(-1);
    const lastChunkPath = path.join(first.directory, lastChunk.file);
    const tampered = JSON.parse(await readFile(lastChunkPath, "utf8"));
    tampered[0].value = "tampered";
    await writeFile(lastChunkPath, JSON.stringify(tampered));
    const unaffected = await readSyntaxOverlayPage(
      root, first.overlaySnapshotId, "syntaxNodes", { offset: 0, limit: 2 },
    );
    assert.deepEqual(unaffected.records.map(({ nodeId }) => nodeId), [0, 1]);
    await assert.rejects(
      readSyntaxOverlayPage(root, first.overlaySnapshotId, "syntaxNodes", {
        offset: lastChunk.start,
        limit: 1,
      }),
      /chunk checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syntax overlay rejects duplicate OBU results and content tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-overlay-tamper-"));
  try {
    const fixture = await createFixture(root);
    const record = fixture.report.obus[0];
    const payload = fixture.input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    const alternate = await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: fixture.parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection: {
        ...inspectSnapshotObuPayload(record, payload),
        status: "partial",
      },
    });
    await assert.rejects(
      writeSyntaxOverlaySnapshot(root, {
        parentSnapshotId: fixture.parent.snapshotId,
        derivedSnapshotIds: [
          fixture.derived[0].derivedSnapshotId,
          alternate.derivedSnapshotId,
        ],
      }),
      /multiple results for OBU 0/,
    );

    const overlay = await writeSyntaxOverlaySnapshot(root, {
      parentSnapshotId: fixture.parent.snapshotId,
      derivedSnapshotIds: fixture.derived.map(({ derivedSnapshotId }) => derivedSnapshotId),
    });
    const manifest = await readSyntaxOverlayManifest(root, overlay.overlaySnapshotId);
    const chunkPath = path.join(
      overlay.directory, manifest.collections.syntaxNodes.chunks[0].file,
    );
    const chunk = JSON.parse(await readFile(chunkPath, "utf8"));
    chunk[0].value = 999;
    await writeFile(chunkPath, JSON.stringify(chunk));
    await assert.rejects(
      readSyntaxOverlaySnapshot(root, overlay.overlaySnapshotId),
      /chunk checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syntax overlay cleanup removes only recognized stale transactions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-overlay-cleanup-"));
  try {
    const overlayRoot = path.join(root, "syntax-overlays");
    const stale = path.join(overlayRoot, ".pending.77.12345678-1234-1234-1234-123456789abc.tmp");
    const unrelated = path.join(overlayRoot, "user-data");
    await mkdir(stale, { recursive: true });
    await mkdir(unrelated);
    await utimes(stale, new Date(1_000), new Date(1_000));
    assert.equal(await cleanupSyntaxOverlayStaging(root, {
      minimumAgeMs: 1_000,
      now: 3_000,
    }), 1);
    await assert.rejects(access(stale), /ENOENT/);
    await access(unrelated);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
