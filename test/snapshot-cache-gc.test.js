import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import {
  rebuildDerivedSyntaxIndex,
  writeDerivedSyntaxSnapshot,
} from "../src/derived-syntax-store.js";
import { garbageCollectSnapshotCache } from "../src/snapshot-cache-gc.js";
import { inspectSnapshotObuPayload } from "../src/snapshot-inspector.js";
import { rebuildSnapshotQueryIndex } from "../src/snapshot-query-index.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { writeSyntaxOverlaySnapshot } from "../src/syntax-overlay-store.js";
import { makeObu } from "./fixtures.js";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(root) {
  const input = Buffer.concat([
    makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") }),
    makeObu({ type: 5, payload: Buffer.from([0x01, 0x03, 0xe8, 0x01, 0x90, 0x80]) }),
  ]);
  const report = analyzeBuffer(input, { sourceName: "gc.obu" });
  const parent = await writeReportSnapshot(report, root);
  const derived = [];
  for (const record of report.obus) {
    const payload = input.subarray(
      record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length,
    );
    derived.push(await writeDerivedSyntaxSnapshot(root, {
      parentSnapshotId: parent.snapshotId,
      obuId: record.obuId,
      payload,
      inspection: inspectSnapshotObuPayload(record, payload),
    }));
    if (derived.length === 1) await rebuildDerivedSyntaxIndex(root, parent.snapshotId);
  }
  const currentIndex = await rebuildDerivedSyntaxIndex(root, parent.snapshotId);
  const queryIndex = await rebuildSnapshotQueryIndex(root, parent.snapshotId, "obus");
  const overlay = await writeSyntaxOverlaySnapshot(root, {
    parentSnapshotId: parent.snapshotId,
    derivedSnapshotIds: [derived[0].derivedSnapshotId],
  });
  return { parent, derived, currentIndex, queryIndex, overlay };
}

test("cache GC is reference-aware, dry-run by default and deletes only recoverable cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-cache-gc-"));
  try {
    const data = await fixture(root);
    const indexDirectory = path.join(root, "indexes", "derived-syntax", data.parent.snapshotId);
    const invalidIndex = path.join(indexDirectory, `${"f".repeat(64)}.json`);
    await writeFile(invalidIndex, "{broken", "utf8");

    const queryIndexDirectory = path.join(
      root, "indexes", "snapshot-query", data.parent.snapshotId, "obus",
    );
    const currentQueryIndex = path.join(queryIndexDirectory, `${data.queryIndex.indexId}.json`);
    const invalidQueryIndex = path.join(queryIndexDirectory, `${"e".repeat(64)}.json`);
    const staleQueryIndex = path.join(queryIndexDirectory, `${"d".repeat(64)}.json`);
    await writeFile(invalidQueryIndex, "{broken", "utf8");
    await writeFile(staleQueryIndex, await readFile(currentQueryIndex, "utf8"), "utf8");
    const orphanQueryDirectory = path.join(
      root, "indexes", "snapshot-query", "9".repeat(64), "obus",
    );
    const orphanQueryIndex = path.join(orphanQueryDirectory, `${"c".repeat(64)}.json`);
    await mkdir(orphanQueryDirectory, { recursive: true });
    await writeFile(orphanQueryIndex, "{\"orphan\":true}", "utf8");
    const futureCollectionDirectory = path.join(
      root, "indexes", "snapshot-query", data.parent.snapshotId, "future-v2",
    );
    const futureCollectionIndex = path.join(futureCollectionDirectory, `${"b".repeat(64)}.json`);
    await mkdir(futureCollectionDirectory, { recursive: true });
    await writeFile(futureCollectionIndex, "{\"future\":true}", "utf8");

    const staleNames = [
      path.join(root, `.pending.1.11111111-1111-4111-8111-111111111111.tmp`),
      path.join(root, "derived-syntax", `.pending.2.22222222-2222-4222-8222-222222222222.tmp`),
      path.join(root, "syntax-overlays", `.pending.3.33333333-3333-4333-8333-333333333333.tmp`),
      path.join(root, "block-overlays", `.pending.4.44444444-4444-4444-8444-444444444444.tmp`),
    ];
    const old = new Date("2020-01-01T00:00:00.000Z");
    for (const directory of staleNames) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "partial"), "pending", "utf8");
      await utimes(directory, old, old);
    }
    const staleQueryStaging = path.join(
      queryIndexDirectory, ".pending.5.55555555-5555-4555-8555-555555555555.tmp",
    );
    await writeFile(staleQueryStaging, "pending", "utf8");
    await utimes(staleQueryStaging, old, old);
    const ignored = path.join(root, "syntax-overlays", ".pending.keep.tmp");
    await mkdir(ignored);
    const ignoredQueryStaging = path.join(queryIndexDirectory, ".pending.keep.tmp");
    await writeFile(ignoredQueryStaging, "pending", "utf8");

    const plan = await garbageCollectSnapshotCache(root, {
      minimumAgeMs: 1_000,
      now: old.getTime() + 2_000,
    });
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.removedCount, 0);
    assert.equal(plan.references.parents.count, 1);
    assert.equal(plan.references.derivedSyntax.count, 2);
    assert.equal(plan.references.derivedSyntax.referencedByOverlayCount, 1);
    assert.equal(plan.references.derivedSyntax.unreferencedCount, 1);
    assert.equal(plan.references.syntaxOverlays.count, 1);
    assert.equal(plan.references.blockOverlays.count, 0);
    assert.equal(plan.summary.contentSnapshotDeletionCount, 0);
    assert.equal(plan.summary.categoryCounts["expired-staging"], 4);
    assert.equal(plan.summary.categoryCounts["expired-query-index-staging"], 1);
    assert.equal(plan.summary.categoryCounts["obsolete-derived-index"], 2);
    assert.equal(plan.summary.categoryCounts["obsolete-query-index"], 3);
    assert.equal(plan.summary.candidateCount, 10);
    for (const candidate of plan.candidates) {
      assert.equal(await exists(path.join(root, ...candidate.relativePath.split("/"))), true);
    }
    await assert.rejects(
      garbageCollectSnapshotCache(root, {
        apply: true,
        expectedPlanId: "0".repeat(64),
        minimumAgeMs: 1_000,
        now: old.getTime() + 2_000,
      }),
      (error) => error.code === "CACHE_GC_PLAN_STALE",
    );
    await writeFile(invalidQueryIndex, "{changed", "utf8");
    await assert.rejects(
      garbageCollectSnapshotCache(root, {
        apply: true,
        expectedPlanId: plan.planId,
        minimumAgeMs: 1_000,
        now: old.getTime() + 2_000,
      }),
      (error) => error.code === "CACHE_GC_PLAN_STALE",
    );
    await writeFile(invalidQueryIndex, "{broken", "utf8");

    const applied = await garbageCollectSnapshotCache(root, {
      apply: true,
      expectedPlanId: plan.planId,
      minimumAgeMs: 1_000,
      now: old.getTime() + 2_000,
    });
    assert.equal(applied.planId, plan.planId);
    assert.equal(applied.mode, "apply");
    assert.equal(applied.removedCount, 10);
    for (const candidate of applied.candidates) {
      assert.equal(await exists(path.join(root, ...candidate.relativePath.split("/"))), false);
    }
    assert.equal(await exists(ignored), true);
    assert.equal(await exists(ignoredQueryStaging), true);
    assert.equal(await exists(futureCollectionIndex), true);
    assert.equal(await exists(path.join(
      indexDirectory, `${data.currentIndex.indexId}.json`,
    )), true);
    assert.equal(await exists(currentQueryIndex), true);
    assert.equal(await exists(path.join(root, data.parent.snapshotId, "manifest.json")), true);
    for (const item of data.derived) {
      assert.equal(await exists(path.join(
        root, "derived-syntax", item.derivedSnapshotId, "manifest.json",
      )), true);
    }
    assert.equal(await exists(path.join(
      root, "syntax-overlays", data.overlay.overlaySnapshotId, "manifest.json",
    )), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache GC refuses unsafe options and filesystem roots", async () => {
  await assert.rejects(
    garbageCollectSnapshotCache(path.parse(process.cwd()).root),
    /refuses a filesystem root/,
  );
  await assert.rejects(
    garbageCollectSnapshotCache(process.cwd(), { minimumAgeMs: -1 }),
    /non-negative safe integer/,
  );
});
