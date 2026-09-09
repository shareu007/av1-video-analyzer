import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { rehearseSnapshotCacheRecovery } from "../src/cache-recovery-rehearsal.js";
import { writeDerivedSyntaxSnapshot } from "../src/derived-syntax-store.js";
import { inspectSnapshotObuPayload } from "../src/snapshot-inspector.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { writeSyntaxOverlaySnapshot } from "../src/syntax-overlay-store.js";
import { makeObu } from "./fixtures.js";

async function fixture(root) {
  const input = Buffer.concat([
    makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") }),
    makeObu({ type: 5, payload: Buffer.from([1, 0, 1, 0, 2, 0x80]) }),
  ]);
  const report = analyzeBuffer(input, { sourceName: "recovery.obu" });
  const parent = await writeReportSnapshot(report, root);
  const derived = [];
  for (const record of report.obus) {
    const payload = input.subarray(
      record.payloadRange.start, record.payloadRange.start + record.payloadRange.length,
    );
    derived.push(await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection: inspectSnapshotObuPayload(record, payload),
    }));
  }
  const overlay = await writeSyntaxOverlaySnapshot(root, {
    parentSnapshotId: parent.snapshotId,
    derivedSnapshotIds: derived.map(({ derivedSnapshotId }) => derivedSnapshotId),
  });
  return { parent, derived, overlay };
}

test("cache recovery rehearsal rebuilds only an isolated clone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-recovery-test-"));
  try {
    const data = await fixture(root);
    const parentManifest = path.join(root, data.parent.snapshotId, "manifest.json");
    const before = await readFile(parentManifest, "utf8");
    const first = await rehearseSnapshotCacheRecovery(root, data.parent.snapshotId);
    const second = await rehearseSnapshotCacheRecovery(root, data.parent.snapshotId);

    assert.equal(first.kind, "av1scope-cache-recovery-rehearsal");
    assert.equal(first.parentSnapshotId, data.parent.snapshotId);
    assert.equal(first.checkpointId, second.checkpointId);
    assert.deepEqual(first.content, {
      parentSnapshotCount: 1,
      derivedSnapshotCount: 2,
      syntaxOverlayCount: 1,
      blockOverlayCount: 0,
    });
    assert.ok(Object.values(first.phases).every(Boolean));
    assert.equal(first.cache.plannedCandidateCount, 7);
    assert.equal(first.cache.removedCandidateCount, 7);
    assert.equal(first.cache.contentDeletionCount, 0);
    assert.equal(first.cache.derivedIndexEntryCount, 2);
    assert.equal(first.cache.derivedIndexStable, true);
    assert.equal(first.cache.queryIndexSourceTotal, 2);
    assert.equal(first.cache.queryIndexStable, true);
    assert.equal(await readFile(parentManifest, "utf8"), before);
    await access(path.join(root, "derived-syntax", data.derived[0].derivedSnapshotId, "manifest.json"));
    await access(path.join(root, "syntax-overlays", data.overlay.overlaySnapshotId, "manifest.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache recovery rehearsal validates its parent ID", async () => {
  await assert.rejects(
    rehearseSnapshotCacheRecovery(process.cwd(), "invalid"),
    /parent snapshot SHA-256/,
  );
});
