import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readDerivedSyntaxIndex,
  readDerivedSyntaxSnapshot,
  rebuildDerivedSyntaxIndex,
} from "./derived-syntax-store.js";
import {
  listBlockOverlaySnapshots,
  readBlockOverlayManifest,
} from "./block-overlay-store.js";
import { stringifyCanonical } from "./json.js";
import { garbageCollectSnapshotCache } from "./snapshot-cache-gc.js";
import {
  readSnapshotQueryIndex,
  rebuildSnapshotQueryIndex,
} from "./snapshot-query-index.js";
import { readReportSnapshot } from "./snapshot-store.js";
import { readSyntaxOverlayManifest } from "./syntax-overlay-store.js";

export const CACHE_RECOVERY_REHEARSAL_SCHEMA_VERSION = 1;
export const CACHE_RECOVERY_REHEARSAL_KIND = "av1scope-cache-recovery-rehearsal";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function directoryIds(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SHA256_PATTERN.test(entry.name))
      .map(({ name }) => name)
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function derivedIdsForParent(rootDirectory, parentSnapshotId) {
  const result = [];
  const ids = await directoryIds(path.join(rootDirectory, "derived-syntax"));
  if (ids.length > 10_000) {
    throw new RangeError("cache recovery rehearsal supports at most 10,000 derived snapshots");
  }
  for (const id of ids) {
    const manifest = await readDerivedSyntaxSnapshot(rootDirectory, id);
    if (manifest.parentSnapshotId === parentSnapshotId) result.push(id);
  }
  return result;
}

async function overlayIdsForParent(rootDirectory, parentSnapshotId, allowedDerivedIds) {
  const allowed = new Set(allowedDerivedIds);
  const result = [];
  for (const id of await directoryIds(path.join(rootDirectory, "syntax-overlays"))) {
    const manifest = await readSyntaxOverlayManifest(rootDirectory, id);
    if (manifest.parentSnapshotId !== parentSnapshotId) continue;
    if (manifest.derivedSnapshotIds.some((derivedId) => !allowed.has(derivedId))) {
      throw new Error("parent overlay references a derived snapshot outside its recovery checkpoint");
    }
    result.push(id);
  }
  return result;
}

async function copyDirectory(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true });
}

async function verifyCheckpoint(rootDirectory, checkpoint) {
  const report = await readReportSnapshot(rootDirectory, checkpoint.parentSnapshotId);
  if (report.summary.frameCount !== checkpoint.frameCount ||
      report.summary.obuCount !== checkpoint.obuCount) {
    throw new Error("recovery checkpoint report summary changed");
  }
  for (const id of checkpoint.derivedSnapshotIds) {
    const manifest = await readDerivedSyntaxSnapshot(rootDirectory, id);
    if (manifest.parentSnapshotId !== checkpoint.parentSnapshotId) {
      throw new Error("recovery checkpoint derived parent changed");
    }
  }
  for (const id of checkpoint.overlaySnapshotIds) {
    const manifest = await readSyntaxOverlayManifest(rootDirectory, id);
    if (manifest.parentSnapshotId !== checkpoint.parentSnapshotId) {
      throw new Error("recovery checkpoint overlay parent changed");
    }
  }
  for (const id of checkpoint.blockOverlaySnapshotIds) {
    const manifest = await readBlockOverlayManifest(rootDirectory, id);
    if (manifest.parentSnapshotId !== checkpoint.parentSnapshotId) {
      throw new Error("recovery checkpoint block overlay parent changed");
    }
  }
}

/**
 * Exercise cache loss, malformed cache cleanup, and deterministic rebuild in an
 * isolated temporary clone. The source store is read-only throughout.
 */
export async function rehearseSnapshotCacheRecovery(rootDirectory, parentSnapshotId) {
  if (typeof parentSnapshotId !== "string" || !SHA256_PATTERN.test(parentSnapshotId)) {
    throw new TypeError("cache recovery rehearsal requires a parent snapshot SHA-256 ID");
  }
  const sourceRoot = path.resolve(rootDirectory);
  const sourceReport = await readReportSnapshot(sourceRoot, parentSnapshotId);
  const derivedSnapshotIds = await derivedIdsForParent(sourceRoot, parentSnapshotId);
  const overlaySnapshotIds = await overlayIdsForParent(
    sourceRoot, parentSnapshotId, derivedSnapshotIds,
  );
  const blockOverlaySnapshotIds = (await listBlockOverlaySnapshots(sourceRoot, parentSnapshotId))
    .map(({ blockOverlaySnapshotId }) => blockOverlaySnapshotId);
  const checkpoint = {
    parentSnapshotId,
    frameCount: sourceReport.summary.frameCount,
    obuCount: sourceReport.summary.obuCount,
    derivedSnapshotIds,
    overlaySnapshotIds,
    blockOverlaySnapshotIds,
  };
  const checkpointId = sha256(stringifyCanonical(checkpoint));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "av1scope-recovery-"));
  const cloneRoot = path.join(workspace, "store");
  try {
    await mkdir(cloneRoot);
    await copyDirectory(
      path.join(sourceRoot, parentSnapshotId),
      path.join(cloneRoot, parentSnapshotId),
    );
    for (const id of derivedSnapshotIds) {
      await copyDirectory(
        path.join(sourceRoot, "derived-syntax", id),
        path.join(cloneRoot, "derived-syntax", id),
      );
    }
    for (const id of overlaySnapshotIds) {
      await copyDirectory(
        path.join(sourceRoot, "syntax-overlays", id),
        path.join(cloneRoot, "syntax-overlays", id),
      );
    }
    for (const id of blockOverlaySnapshotIds) {
      await copyDirectory(
        path.join(sourceRoot, "block-overlays", id),
        path.join(cloneRoot, "block-overlays", id),
      );
    }

    await verifyCheckpoint(cloneRoot, checkpoint);
    const initialIndex = await rebuildDerivedSyntaxIndex(cloneRoot, parentSnapshotId);
    const initialQueryIndex = await rebuildSnapshotQueryIndex(
      cloneRoot, parentSnapshotId, "obus",
    );
    const invalidIndexId = sha256("av1scope-recovery-invalid-index");
    const indexDirectory = path.join(
      cloneRoot, "indexes", "derived-syntax", parentSnapshotId,
    );
    await writeFile(path.join(indexDirectory, `${invalidIndexId}.json`), "{broken", "utf8");
    const queryIndexDirectory = path.join(
      cloneRoot, "indexes", "snapshot-query", parentSnapshotId, "obus",
    );
    await writeFile(
      path.join(queryIndexDirectory, `${sha256("av1scope-recovery-invalid-query-index")}.json`),
      "{broken",
      "utf8",
    );
    await writeFile(
      path.join(
        queryIndexDirectory,
        ".pending.5.55555555-5555-4555-8555-555555555555.tmp",
      ),
      "pending",
      "utf8",
    );
    const stagingNames = [
      [cloneRoot, ".pending.1.11111111-1111-4111-8111-111111111111.tmp"],
      [path.join(cloneRoot, "derived-syntax"), ".pending.2.22222222-2222-4222-8222-222222222222.tmp"],
      [path.join(cloneRoot, "syntax-overlays"), ".pending.3.33333333-3333-4333-8333-333333333333.tmp"],
      [path.join(cloneRoot, "block-overlays"), ".pending.4.44444444-4444-4444-8444-444444444444.tmp"],
    ];
    for (const [directory, name] of stagingNames) {
      await mkdir(path.join(directory, name), { recursive: true });
    }
    const rehearsalNow = Date.now() + 10_000;
    const preview = await garbageCollectSnapshotCache(cloneRoot, {
      minimumAgeMs: 0,
      now: rehearsalNow,
    });
    const applied = await garbageCollectSnapshotCache(cloneRoot, {
      apply: true,
      expectedPlanId: preview.planId,
      minimumAgeMs: 0,
      now: rehearsalNow,
    });
    if (preview.planId !== applied.planId || applied.removedCount !== preview.summary.candidateCount ||
        applied.summary.contentSnapshotDeletionCount !== 0) {
      throw new Error("cache recovery GC rehearsal did not apply its exact safe plan");
    }
    await verifyCheckpoint(cloneRoot, checkpoint);

    await rm(path.join(cloneRoot, "indexes"), { recursive: true, force: true });
    const rebuiltIndex = await readDerivedSyntaxIndex(cloneRoot, parentSnapshotId);
    const rebuiltQueryIndex = await readSnapshotQueryIndex(cloneRoot, parentSnapshotId, "obus");
    if (rebuiltIndex.entries.length !== derivedSnapshotIds.length ||
        rebuiltIndex.indexId !== initialIndex.indexId) {
      throw new Error("cache recovery index rebuild did not restore the checkpoint");
    }
    if (rebuiltQueryIndex.indexId !== initialQueryIndex.indexId ||
        rebuiltQueryIndex.sourceTotal !== sourceReport.obus.length) {
      throw new Error("cache recovery query index rebuild did not restore the checkpoint");
    }
    await verifyCheckpoint(cloneRoot, checkpoint);
    await verifyCheckpoint(sourceRoot, checkpoint);

    return {
      schemaVersion: CACHE_RECOVERY_REHEARSAL_SCHEMA_VERSION,
      kind: CACHE_RECOVERY_REHEARSAL_KIND,
      parentSnapshotId,
      checkpointId,
      content: {
        parentSnapshotCount: 1,
        derivedSnapshotCount: derivedSnapshotIds.length,
        syntaxOverlayCount: overlaySnapshotIds.length,
        blockOverlayCount: blockOverlaySnapshotIds.length,
      },
      phases: {
        isolatedCloneVerified: true,
        malformedCachePlanned: true,
        exactPlanApplied: true,
        contentRetained: true,
        cacheLossRebuilt: true,
        sourceStoreUnchanged: true,
      },
      cache: {
        plannedCandidateCount: preview.summary.candidateCount,
        removedCandidateCount: applied.removedCount,
        contentDeletionCount: applied.summary.contentSnapshotDeletionCount,
        derivedIndexEntryCount: rebuiltIndex.entries.length,
        derivedIndexStable: rebuiltIndex.indexId === initialIndex.indexId,
        queryIndexSourceTotal: rebuiltQueryIndex.sourceTotal,
        queryIndexStable: rebuiltQueryIndex.indexId === initialQueryIndex.indexId,
      },
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
