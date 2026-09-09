import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateBlockOverlayDocument } from "./block-overlay.js";
import { stringifyCanonical } from "./json.js";
import { readSnapshotManifest, readSnapshotPage } from "./snapshot-store.js";

export const BLOCK_OVERLAY_SNAPSHOT_SCHEMA_VERSION = 1;
export const BLOCK_OVERLAY_SNAPSHOT_KIND = "av1scope-block-overlay-snapshot";
export const DEFAULT_BLOCK_OVERLAY_CHUNK_SIZE = 1_000;

const ROOT_NAME = "block-overlays";
const COLLECTION_NAMES = Object.freeze(["frames", "blocks"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CHUNK_FILE_PATTERN = /^(frames|blocks)-\d{6}\.json$/;
const STAGING_PATTERN = /^\.pending\.\d+\.[0-9a-f-]{36}\.tmp$/;
const MAX_PAGE_SIZE = 10_000;
const MAX_OVERLAYS = 10_000;
const MAX_BLOCK_RECORDS = 1_000_000;
const PARENT_FRAME_PAGE_SIZE = 10_000;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validateDigest(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}

function rootDirectory(root) {
  return path.join(path.resolve(root), ROOT_NAME);
}

function snapshotDirectory(root, blockOverlaySnapshotId) {
  validateDigest(blockOverlaySnapshotId, "blockOverlaySnapshotId");
  return path.join(rootDirectory(root), blockOverlaySnapshotId);
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function semanticPayload({ parentSnapshotId, provenance, frames }) {
  return {
    schemaVersion: BLOCK_OVERLAY_SNAPSHOT_SCHEMA_VERSION,
    kind: BLOCK_OVERLAY_SNAPSHOT_KIND,
    parentSnapshotId,
    provenance,
    frames,
  };
}

function storagePayload(manifest) {
  return {
    storageLayout: manifest.storageLayout,
    chunkSize: manifest.chunkSize,
    parentSnapshotId: manifest.parentSnapshotId,
    provenance: manifest.provenance,
    summary: manifest.summary,
    collections: manifest.collections,
  };
}

async function writeCollection(staging, collection, records, chunkSize) {
  const chunks = [];
  let values = [];
  let count = 0;
  let index = 0;
  const flush = async () => {
    if (values.length === 0) return;
    const contents = stringifyCanonical(values);
    const file = `${collection}-${String(index).padStart(6, "0")}.json`;
    await writeFile(path.join(staging, file), contents, { encoding: "utf8", flag: "wx" });
    chunks.push({
      file,
      start: count - values.length,
      count: values.length,
      sha256: sha256(contents),
    });
    values = [];
    index += 1;
  };
  for await (const record of records) {
    values.push(record);
    count += 1;
    if (values.length === chunkSize) await flush();
  }
  await flush();
  return { count, chunks };
}

function validateCollectionDescriptor(collection, descriptor) {
  if (!descriptor || !Number.isSafeInteger(descriptor.count) || descriptor.count < 0
      || !Array.isArray(descriptor.chunks)) {
    throw new Error(`block overlay manifest is missing collection: ${collection}`);
  }
  let expectedStart = 0;
  for (const chunk of descriptor.chunks) {
    if (!chunk || chunk.start !== expectedStart || !Number.isSafeInteger(chunk.count)
        || chunk.count < 1 || typeof chunk.file !== "string"
        || !CHUNK_FILE_PATTERN.test(chunk.file) || !chunk.file.startsWith(`${collection}-`)
        || typeof chunk.sha256 !== "string" || !SHA256_PATTERN.test(chunk.sha256)) {
      throw new Error(`block overlay manifest has invalid ${collection} chunk metadata`);
    }
    expectedStart += chunk.count;
  }
  if (expectedStart !== descriptor.count) {
    throw new Error(`block overlay manifest ${collection} count mismatch`);
  }
}

async function readVerifiedChunk(directory, descriptor) {
  const contents = await readFile(path.join(directory, descriptor.file), "utf8");
  if (sha256(contents) !== descriptor.sha256) {
    throw new Error(`block overlay chunk checksum mismatch: ${descriptor.file}`);
  }
  const records = JSON.parse(contents);
  if (!Array.isArray(records) || records.length !== descriptor.count) {
    throw new Error(`block overlay chunk record count mismatch: ${descriptor.file}`);
  }
  return records;
}

export async function readBlockOverlayManifest(root, blockOverlaySnapshotId) {
  const directory = snapshotDirectory(root, blockOverlaySnapshotId);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== BLOCK_OVERLAY_SNAPSHOT_SCHEMA_VERSION
      || manifest.kind !== BLOCK_OVERLAY_SNAPSHOT_KIND
      || manifest.blockOverlaySnapshotId !== blockOverlaySnapshotId
      || manifest.storageLayout !== "chunked-v1"
      || !Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize < 1) {
    throw new Error("unsupported or mismatched block overlay snapshot");
  }
  validateDigest(manifest.parentSnapshotId, "parentSnapshotId");
  for (const collection of COLLECTION_NAMES) {
    validateCollectionDescriptor(collection, manifest.collections?.[collection]);
  }
  if (!manifest.summary || manifest.summary.frameCount !== manifest.collections.frames.count
      || manifest.summary.blockCount !== manifest.collections.blocks.count
      || typeof manifest.payloadSha256 !== "string"
      || sha256(stringifyCanonical(storagePayload(manifest))) !== manifest.payloadSha256) {
    throw new Error("block overlay manifest payload checksum mismatch");
  }
  return manifest;
}

export async function readBlockOverlayPage(
  root,
  blockOverlaySnapshotId,
  collection,
  { offset = 0, limit = 200 } = {},
) {
  if (!COLLECTION_NAMES.includes(collection)) {
    throw new RangeError(`unknown block overlay collection: ${collection}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`block overlay page requires offset >= 0 and limit 1..${MAX_PAGE_SIZE}`);
  }
  const manifest = await readBlockOverlayManifest(root, blockOverlaySnapshotId);
  const descriptor = manifest.collections[collection];
  const end = Math.min(descriptor.count, offset + limit);
  const records = [];
  const directory = snapshotDirectory(root, blockOverlaySnapshotId);
  for (const chunk of descriptor.chunks) {
    const chunkEnd = chunk.start + chunk.count;
    if (chunkEnd <= offset || chunk.start >= end) continue;
    const values = await readVerifiedChunk(directory, chunk);
    records.push(...values.slice(
      Math.max(offset, chunk.start) - chunk.start,
      Math.min(end, chunkEnd) - chunk.start,
    ));
  }
  return {
    schemaVersion: 1,
    kind: "av1scope-block-overlay-page",
    blockOverlaySnapshotId,
    collection,
    offset,
    limit,
    total: descriptor.count,
    records,
  };
}

async function readAll(root, id, collection, count) {
  const records = [];
  while (records.length < count) {
    const page = await readBlockOverlayPage(root, id, collection, {
      offset: records.length,
      limit: Math.min(MAX_PAGE_SIZE, count - records.length),
    });
    if (page.records.length === 0) throw new Error(`block overlay ${collection} made no read progress`);
    records.push(...page.records);
  }
  return records;
}

export async function readBlockOverlaySnapshot(root, blockOverlaySnapshotId) {
  const manifest = await readBlockOverlayManifest(root, blockOverlaySnapshotId);
  const frameRecords = await readAll(
    root, blockOverlaySnapshotId, "frames", manifest.collections.frames.count,
  );
  const blockRecords = await readAll(
    root, blockOverlaySnapshotId, "blocks", manifest.collections.blocks.count,
  );
  let expectedStart = 0;
  const frames = frameRecords.map((frame, index) => {
    if (!frame || !Number.isSafeInteger(frame.frameId) || frame.frameId < 0
        || !Number.isSafeInteger(frame.blockStart) || frame.blockStart !== expectedStart
        || !Number.isSafeInteger(frame.blockCount) || frame.blockCount < 0) {
      throw new Error(`block overlay frame index is invalid at ${index}`);
    }
    const values = blockRecords.slice(frame.blockStart, frame.blockStart + frame.blockCount)
      .map((record) => {
        if (record?.frameId !== frame.frameId) {
          throw new Error(`block overlay block belongs to the wrong frame ${frame.frameId}`);
        }
        const { frameId: _frameId, ...block } = record;
        return block;
      });
    if (values.length !== frame.blockCount) {
      throw new Error(`block overlay frame ${frame.frameId} block range is truncated`);
    }
    expectedStart += frame.blockCount;
    return { frameId: frame.frameId, blocks: values };
  });
  if (expectedStart !== blockRecords.length) {
    throw new Error("block overlay frame index does not cover all blocks");
  }
  const document = semanticPayload({
    parentSnapshotId: manifest.parentSnapshotId,
    provenance: manifest.provenance,
    frames,
  });
  if (sha256(stringifyCanonical(document)) !== blockOverlaySnapshotId) {
    throw new Error("block overlay snapshot content digest mismatch");
  }
  return { blockOverlaySnapshotId, ...document, summary: manifest.summary };
}

async function readParentFramesForOverlay(root, parentSnapshotId, overlay) {
  const manifest = await readSnapshotManifest(root, parentSnapshotId);
  const requested = new Set(overlay.frames.map(({ frameId }) => frameId));
  const frames = [];
  const offsets = [...new Set([...requested]
    .filter((frameId) => Number.isSafeInteger(frameId) && frameId >= 0)
    .map((frameId) => Math.floor(frameId / PARENT_FRAME_PAGE_SIZE) * PARENT_FRAME_PAGE_SIZE))]
    .sort((left, right) => left - right);
  for (const offset of offsets) {
    const page = await readSnapshotPage(root, parentSnapshotId, "frames", {
      offset,
      limit: PARENT_FRAME_PAGE_SIZE,
    });
    for (const frame of page.records) {
      if (requested.has(frame.frameId)) frames.push(frame);
    }
  }
  return { ...manifest.header, frames };
}

export async function verifyBlockOverlaySnapshot(root, blockOverlaySnapshotId) {
  const document = await readBlockOverlaySnapshot(root, blockOverlaySnapshotId);
  const parent = await readParentFramesForOverlay(root, document.parentSnapshotId, document);
  validateBlockOverlayDocument(document, parent);
  return readBlockOverlayManifest(root, blockOverlaySnapshotId);
}

export async function writeBlockOverlaySnapshot(
  root,
  { parentSnapshotId, overlay },
  { chunkSize = DEFAULT_BLOCK_OVERLAY_CHUNK_SIZE } = {},
) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_PAGE_SIZE) {
    throw new RangeError(`block overlay chunkSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const parent = await readParentFramesForOverlay(root, parentSnapshotId, overlay);
  const normalized = validateBlockOverlayDocument(overlay, parent);
  let blockCount = 0;
  const frames = normalized.frames.map((frame) => {
    const record = { frameId: frame.frameId, blockStart: blockCount, blockCount: frame.blocks.length };
    blockCount += frame.blocks.length;
    return record;
  });
  if (blockCount > MAX_BLOCK_RECORDS) {
    throw new RangeError(`block overlay exceeds the ${MAX_BLOCK_RECORDS}-record budget`);
  }
  const document = semanticPayload({
    parentSnapshotId,
    provenance: normalized.provenance,
    frames: normalized.frames,
  });
  const blockOverlaySnapshotId = sha256(stringifyCanonical(document));
  const destination = snapshotDirectory(root, blockOverlaySnapshotId);
  if (await exists(destination)) {
    const manifest = await verifyBlockOverlaySnapshot(root, blockOverlaySnapshotId);
    return { blockOverlaySnapshotId, directory: destination, manifest, created: false };
  }
  const overlayRoot = rootDirectory(root);
  await mkdir(overlayRoot, { recursive: true });
  const staging = path.join(overlayRoot, `.pending.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    async function* blocks() {
      for (const frame of normalized.frames) {
        for (const block of frame.blocks) yield { frameId: frame.frameId, ...block };
      }
    }
    const collections = {
      frames: await writeCollection(staging, "frames", frames, chunkSize),
      blocks: await writeCollection(staging, "blocks", blocks(), chunkSize),
    };
    if (collections.blocks.count !== blockCount) {
      throw new Error("block overlay changed while writing");
    }
    const storage = {
      storageLayout: "chunked-v1",
      chunkSize,
      parentSnapshotId,
      provenance: normalized.provenance,
      summary: { frameCount: frames.length, blockCount },
      collections,
    };
    const manifest = {
      schemaVersion: BLOCK_OVERLAY_SNAPSHOT_SCHEMA_VERSION,
      kind: BLOCK_OVERLAY_SNAPSHOT_KIND,
      blockOverlaySnapshotId,
      payloadSha256: sha256(stringifyCanonical(storage)),
      ...storage,
    };
    await writeFile(path.join(staging, "manifest.json"), stringifyCanonical(manifest, {
      pretty: true,
    }), { encoding: "utf8", flag: "wx" });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !(await exists(destination))) throw error;
      await rm(staging, { recursive: true, force: true });
      const existing = await verifyBlockOverlaySnapshot(root, blockOverlaySnapshotId);
      return { blockOverlaySnapshotId, directory: destination, manifest: existing, created: false };
    }
    return { blockOverlaySnapshotId, directory: destination, manifest, created: true };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function listBlockOverlaySnapshots(root, parentSnapshotId) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  const overlayRoot = rootDirectory(root);
  let entries;
  try {
    entries = await readdir(overlayRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (entries.length > MAX_OVERLAYS) throw new RangeError(`block overlay store exceeds ${MAX_OVERLAYS} entries`);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name)) continue;
    const manifest = await readBlockOverlayManifest(root, entry.name);
    if (manifest.parentSnapshotId === parentSnapshotId) matches.push(manifest);
  }
  return matches.sort((left, right) => left.blockOverlaySnapshotId.localeCompare(right.blockOverlaySnapshotId));
}

export async function cleanupBlockOverlayStaging(
  root,
  { minimumAgeMs = 60 * 60 * 1_000, now = Date.now() } = {},
) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RangeError("block overlay staging minimumAgeMs must be non-negative");
  }
  const overlayRoot = rootDirectory(root);
  await mkdir(overlayRoot, { recursive: true });
  const entries = await readdir(overlayRoot, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !STAGING_PATTERN.test(entry.name)) continue;
    const target = path.join(overlayRoot, entry.name);
    if (now - (await stat(target)).mtimeMs < minimumAgeMs) continue;
    await rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
