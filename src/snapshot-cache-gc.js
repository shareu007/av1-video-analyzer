import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { stringifyCanonical } from "./json.js";
import {
  SNAPSHOT_QUERY_INDEX_COLLECTIONS,
  validateSnapshotQueryIndexDocument,
} from "./snapshot-query-index.js";
import { readSnapshotManifest } from "./snapshot-store.js";

export const SNAPSHOT_CACHE_GC_SCHEMA_VERSION = 1;
export const SNAPSHOT_CACHE_GC_KIND = "av1scope-snapshot-cache-gc-plan";
export const DEFAULT_CACHE_GC_MINIMUM_AGE_MS = 60 * 60 * 1_000;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INDEX_FILE_PATTERN = /^([0-9a-f]{64})\.json$/;
const STAGING_DIRECTORY_PATTERN = /^\.pending\.\d+\.[0-9a-f-]{36}\.tmp$/;
const STAGING_FILE_PATTERN = STAGING_DIRECTORY_PATTERN;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function relativePath(rootDirectory, target) {
  return path.relative(rootDirectory, target).split(path.sep).join("/");
}

async function readDirectory(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function contentDirectoryIds(directory) {
  return (await readDirectory(directory))
    .filter((entry) => entry.isDirectory() && SHA256_PATTERN.test(entry.name))
    .map(({ name }) => name)
    .sort();
}

async function readJson(file) {
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { error };
  }
  try {
    return { contents, value: JSON.parse(contents) };
  } catch (error) {
    return { contents, error };
  }
}

function validDigest(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function indexPayload(index) {
  return {
    schemaVersion: index.schemaVersion,
    kind: index.kind,
    parentSnapshotId: index.parentSnapshotId,
    storeRevision: index.storeRevision,
    entries: index.entries,
  };
}

function hasValidIndexEntries(entries) {
  if (!Array.isArray(entries)) return false;
  let previousObuId = -1;
  let previousId = "";
  for (const entry of entries) {
    if (!validDigest(entry?.derivedSnapshotId) ||
        !Number.isSafeInteger(entry.obuId) || entry.obuId < 0 ||
        entry.obuId < previousObuId ||
        (entry.obuId === previousObuId && entry.derivedSnapshotId <= previousId)) {
      return false;
    }
    previousObuId = entry.obuId;
    previousId = entry.derivedSnapshotId;
  }
  return true;
}

function isCurrentIndex(index, parentSnapshotId, indexId, storeRevision) {
  return index?.schemaVersion === 1 && index.kind === "av1scope-derived-syntax-index" &&
    index.parentSnapshotId === parentSnapshotId && index.indexId === indexId &&
    index.storeRevision === storeRevision && hasValidIndexEntries(index.entries) &&
    sha256(stringifyCanonical(indexPayload(index))) === indexId;
}

async function addStagingCandidates(
  candidates,
  rootDirectory,
  directory,
  scope,
  minimumAgeMs,
  now,
) {
  for (const entry of await readDirectory(directory)) {
    if (!entry.isDirectory() || !STAGING_DIRECTORY_PATTERN.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const metadata = await stat(target);
    if (now - metadata.mtimeMs < minimumAgeMs) continue;
    candidates.push({
      category: "expired-staging",
      scope,
      relativePath: relativePath(rootDirectory, target),
      reason: `recognized ${scope} transaction is older than minimumAgeMs`,
      expectedMtimeMs: metadata.mtimeMs,
    });
  }
}

async function scanReferences(rootDirectory, parentIds, derivedIds, overlayIds, blockOverlayIds) {
  const parentSet = new Set(parentIds);
  const derivedSet = new Set(derivedIds);
  const parentReferencedByDerived = new Set();
  const parentReferencedByOverlay = new Set();
  const parentReferencedByBlockOverlay = new Set();
  const derivedReferencedByOverlay = new Set();
  const orphanedDerived = new Set();
  const orphanedOverlays = new Set();
  const orphanedBlockOverlays = new Set();

  for (const id of derivedIds) {
    const document = await readJson(path.join(rootDirectory, "derived-syntax", id, "manifest.json"));
    const manifest = document?.value;
    if (!manifest || manifest.derivedSnapshotId !== id || !validDigest(manifest.parentSnapshotId)) {
      orphanedDerived.add(id);
      continue;
    }
    parentReferencedByDerived.add(manifest.parentSnapshotId);
    if (!parentSet.has(manifest.parentSnapshotId)) orphanedDerived.add(id);
  }

  for (const id of overlayIds) {
    const document = await readJson(path.join(rootDirectory, "syntax-overlays", id, "manifest.json"));
    const manifest = document?.value;
    if (!manifest || manifest.overlaySnapshotId !== id || !validDigest(manifest.parentSnapshotId) ||
        !Array.isArray(manifest.derivedSnapshotIds) ||
        manifest.derivedSnapshotIds.some((derivedId) => !validDigest(derivedId))) {
      orphanedOverlays.add(id);
      continue;
    }
    parentReferencedByOverlay.add(manifest.parentSnapshotId);
    if (!parentSet.has(manifest.parentSnapshotId)) orphanedOverlays.add(id);
    for (const derivedId of manifest.derivedSnapshotIds) {
      derivedReferencedByOverlay.add(derivedId);
      if (!derivedSet.has(derivedId)) orphanedOverlays.add(id);
    }
  }

  for (const id of blockOverlayIds) {
    const document = await readJson(path.join(rootDirectory, "block-overlays", id, "manifest.json"));
    const manifest = document?.value;
    if (!manifest || manifest.blockOverlaySnapshotId !== id
        || !validDigest(manifest.parentSnapshotId)) {
      orphanedBlockOverlays.add(id);
      continue;
    }
    parentReferencedByBlockOverlay.add(manifest.parentSnapshotId);
    if (!parentSet.has(manifest.parentSnapshotId)) orphanedBlockOverlays.add(id);
  }

  return {
    parents: {
      count: parentIds.length,
      referencedByDerivedCount: [...parentReferencedByDerived]
        .filter((id) => parentSet.has(id)).length,
      referencedByOverlayCount: [...parentReferencedByOverlay]
        .filter((id) => parentSet.has(id)).length,
      referencedByBlockOverlayCount: [...parentReferencedByBlockOverlay]
        .filter((id) => parentSet.has(id)).length,
    },
    derivedSyntax: {
      count: derivedIds.length,
      referencedByOverlayCount: [...derivedReferencedByOverlay]
        .filter((id) => derivedSet.has(id)).length,
      unreferencedCount: derivedIds.filter((id) => !derivedReferencedByOverlay.has(id)).length,
      orphanedCount: orphanedDerived.size,
    },
    syntaxOverlays: {
      count: overlayIds.length,
      orphanedCount: orphanedOverlays.size,
    },
    blockOverlays: {
      count: blockOverlayIds.length,
      orphanedCount: orphanedBlockOverlays.size,
    },
  };
}

async function addIndexCandidates(
  candidates,
  rootDirectory,
  parentIds,
  storeRevision,
) {
  const parentSet = new Set(parentIds);
  const indexRoot = path.join(rootDirectory, "indexes", "derived-syntax");
  for (const parentEntry of await readDirectory(indexRoot)) {
    if (!parentEntry.isDirectory() || !SHA256_PATTERN.test(parentEntry.name)) continue;
    const directory = path.join(indexRoot, parentEntry.name);
    for (const entry of await readDirectory(directory)) {
      const match = entry.isFile() && entry.name.match(INDEX_FILE_PATTERN);
      if (!match) continue;
      const target = path.join(directory, entry.name);
      const document = await readJson(target);
      const current = document?.value && parentSet.has(parentEntry.name) &&
        isCurrentIndex(document.value, parentEntry.name, match[1], storeRevision);
      if (current) continue;
      candidates.push({
        category: "obsolete-derived-index",
        scope: "derived-index",
        relativePath: relativePath(rootDirectory, target),
        reason: !parentSet.has(parentEntry.name)
          ? "index parent snapshot is absent"
          : document?.value?.storeRevision !== storeRevision
            ? "index storeRevision is not current"
            : "index is malformed or its content ID is invalid",
        expectedSha256: document?.contents ? sha256(document.contents) : null,
      });
    }
  }
}

async function addQueryIndexStagingCandidates(
  candidates,
  rootDirectory,
  directory,
  minimumAgeMs,
  now,
) {
  for (const entry of await readDirectory(directory)) {
    if (!entry.isFile() || !STAGING_FILE_PATTERN.test(entry.name)) continue;
    const target = path.join(directory, entry.name);
    const metadata = await stat(target);
    if (now - metadata.mtimeMs < minimumAgeMs) continue;
    candidates.push({
      category: "expired-query-index-staging",
      scope: "snapshot-query-index",
      relativePath: relativePath(rootDirectory, target),
      reason: "recognized snapshot-query-index transaction is older than minimumAgeMs",
      expectedMtimeMs: metadata.mtimeMs,
      expectedSize: metadata.size,
    });
  }
}

async function addQueryIndexCandidates(
  candidates,
  rootDirectory,
  parentIds,
  minimumAgeMs,
  now,
) {
  const parentSet = new Set(parentIds);
  const queryRoot = path.join(rootDirectory, "indexes", "snapshot-query");
  for (const parentEntry of await readDirectory(queryRoot)) {
    if (!parentEntry.isDirectory() || !SHA256_PATTERN.test(parentEntry.name)) continue;
    const parentDirectory = path.join(queryRoot, parentEntry.name);
    let manifest = null;
    if (parentSet.has(parentEntry.name)) {
      try {
        manifest = await readSnapshotManifest(rootDirectory, parentEntry.name);
      } catch {
        // Query indexes are recoverable. A missing/invalid parent manifest makes them obsolete.
      }
    }
    for (const collectionEntry of await readDirectory(parentDirectory)) {
      if (!collectionEntry.isDirectory()
          || !SNAPSHOT_QUERY_INDEX_COLLECTIONS.includes(collectionEntry.name)) continue;
      const collection = collectionEntry.name;
      const collectionDirectory = path.join(parentDirectory, collection);
      await addQueryIndexStagingCandidates(
        candidates,
        rootDirectory,
        collectionDirectory,
        minimumAgeMs,
        now,
      );
      for (const entry of await readDirectory(collectionDirectory)) {
        const match = entry.isFile() && entry.name.match(INDEX_FILE_PATTERN);
        if (!match) continue;
        const target = path.join(collectionDirectory, entry.name);
        const document = await readJson(target);
        let current = false;
        if (manifest !== null && document?.value) {
          try {
            validateSnapshotQueryIndexDocument(
              document.value,
              manifest,
              collection,
              match[1],
            );
            current = true;
          } catch {
            // Invalid and stale sidecars are safe GC candidates.
          }
        }
        if (current) continue;
        candidates.push({
          category: "obsolete-query-index",
          scope: "snapshot-query-index",
          relativePath: relativePath(rootDirectory, target),
          reason: !parentSet.has(parentEntry.name)
            ? "index parent snapshot is absent"
            : manifest === null
              ? "index parent snapshot manifest is invalid"
              : "index is malformed, stale or its content ID is invalid",
          expectedSha256: document?.contents ? sha256(document.contents) : null,
        });
      }
    }
  }
}

async function applyCandidate(rootDirectory, candidate) {
  const target = path.resolve(rootDirectory, ...candidate.relativePath.split("/"));
  if (!target.startsWith(`${rootDirectory}${path.sep}`)) {
    throw new Error(`cache GC candidate escapes snapshot root: ${candidate.relativePath}`);
  }
  if (candidate.category === "expired-staging") {
    let metadata;
    try {
      metadata = await stat(target);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.mtimeMs !== candidate.expectedMtimeMs) {
      throw new Error(`cache GC candidate changed after planning: ${candidate.relativePath}`);
    }
    await rm(target, { recursive: true, force: true });
    return true;
  }
  if (candidate.category === "expired-query-index-staging") {
    let metadata;
    try {
      metadata = await stat(target);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    if (!metadata.isFile() || metadata.mtimeMs !== candidate.expectedMtimeMs
        || metadata.size !== candidate.expectedSize) {
      throw new Error(`cache GC candidate changed after planning: ${candidate.relativePath}`);
    }
    await rm(target, { force: true });
    return true;
  }
  let contents;
  try {
    contents = await readFile(target, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (candidate.expectedSha256 === null || sha256(contents) !== candidate.expectedSha256) {
    throw new Error(`cache GC candidate changed after planning: ${candidate.relativePath}`);
  }
  await rm(target, { force: true });
  return true;
}

export async function garbageCollectSnapshotCache(
  rootDirectory,
  {
    apply = false,
    expectedPlanId = null,
    minimumAgeMs = DEFAULT_CACHE_GC_MINIMUM_AGE_MS,
    now = Date.now(),
  } = {},
) {
  if (typeof apply !== "boolean") throw new TypeError("cache GC apply must be a boolean");
  if (expectedPlanId !== null && !validDigest(expectedPlanId)) {
    throw new TypeError("cache GC expectedPlanId must be a lowercase SHA-256 digest");
  }
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RangeError("cache GC minimumAgeMs must be a non-negative safe integer");
  }
  if (!Number.isFinite(now)) throw new TypeError("cache GC now must be finite");
  const root = path.resolve(rootDirectory);
  if (root === path.parse(root).root) throw new Error("cache GC refuses a filesystem root");

  const [parentIds, derivedIds, overlayIds, blockOverlayIds] = await Promise.all([
    contentDirectoryIds(root),
    contentDirectoryIds(path.join(root, "derived-syntax")),
    contentDirectoryIds(path.join(root, "syntax-overlays")),
    contentDirectoryIds(path.join(root, "block-overlays")),
  ]);
  const storeRevision = sha256(stringifyCanonical(derivedIds));
  const references = await scanReferences(
    root, parentIds, derivedIds, overlayIds, blockOverlayIds,
  );
  const candidates = [];
  await Promise.all([
    addStagingCandidates(candidates, root, root, "parent-snapshot", minimumAgeMs, now),
    addStagingCandidates(
      candidates, root, path.join(root, "derived-syntax"), "derived-syntax", minimumAgeMs, now,
    ),
    addStagingCandidates(
      candidates, root, path.join(root, "syntax-overlays"), "syntax-overlay", minimumAgeMs, now,
    ),
    addStagingCandidates(
      candidates, root, path.join(root, "block-overlays"), "block-overlay", minimumAgeMs, now,
    ),
    addIndexCandidates(candidates, root, parentIds, storeRevision),
    addQueryIndexCandidates(candidates, root, parentIds, minimumAgeMs, now),
  ]);
  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const categoryCounts = Object.create(null);
  for (const candidate of candidates) {
    categoryCounts[candidate.category] = (categoryCounts[candidate.category] ?? 0) + 1;
  }
  const payload = {
    schemaVersion: SNAPSHOT_CACHE_GC_SCHEMA_VERSION,
    kind: SNAPSHOT_CACHE_GC_KIND,
    minimumAgeMs,
    derivedStoreRevision: storeRevision,
    references,
    candidates,
    summary: {
      candidateCount: candidates.length,
      categoryCounts,
      contentSnapshotDeletionCount: 0,
    },
  };
  const planId = sha256(stringifyCanonical(payload));
  let removedCount = 0;
  if (apply) {
    if (expectedPlanId !== null && expectedPlanId !== planId) {
      const error = new Error("cache GC plan is stale; preview the current store before applying");
      error.code = "CACHE_GC_PLAN_STALE";
      throw error;
    }
    for (const candidate of candidates) {
      if (await applyCandidate(root, candidate)) removedCount += 1;
    }
  }
  return {
    planId,
    mode: apply ? "apply" : "dry-run",
    ...payload,
    removedCount,
  };
}
