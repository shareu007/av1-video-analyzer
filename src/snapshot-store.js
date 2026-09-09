import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringifyCanonical } from "./json.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const DEFAULT_SNAPSHOT_CHUNK_SIZE = 1_000;
const MAX_PAGE_SIZE = 10_000;
const COLLECTION_NAMES = Object.freeze(["frames", "obus", "syntaxNodes", "diagnostics"]);
const COLLECTION_SET = new Set(COLLECTION_NAMES);
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_DIRECTORY_PATTERN = /^\.pending\.\d+\.[0-9a-f-]{36}\.tmp$/;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
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

function validateSnapshotId(snapshotId) {
  if (typeof snapshotId !== "string" || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw new TypeError("snapshotId must be a lowercase SHA-256 digest");
  }
}

function validateCollection(collection) {
  if (!COLLECTION_SET.has(collection)) {
    throw new RangeError(`unknown snapshot collection: ${collection}`);
  }
}

function snapshotDirectory(rootDirectory, snapshotId) {
  validateSnapshotId(snapshotId);
  return path.join(path.resolve(rootDirectory), snapshotId);
}

function manifestPayload(manifest) {
  return {
    reportSchemaVersion: manifest.reportSchemaVersion,
    chunkSize: manifest.chunkSize,
    header: manifest.header,
    collections: manifest.collections,
  };
}

export function computeSnapshotId(report) {
  return sha256(stringifyCanonical(report));
}

export async function cleanupSnapshotStaging(
  rootDirectory,
  { minimumAgeMs = 60 * 60 * 1_000, now = Date.now() } = {},
) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RangeError("snapshot staging minimumAgeMs must be a non-negative safe integer");
  }
  const root = path.resolve(rootDirectory);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !STAGING_DIRECTORY_PATTERN.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    const metadata = await stat(target);
    if (now - metadata.mtimeMs < minimumAgeMs) continue;
    await rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function requireIterable(records, collection) {
  if (!records || (typeof records[Symbol.iterator] !== "function" &&
      typeof records[Symbol.asyncIterator] !== "function")) {
    throw new TypeError(`snapshot collection must be iterable: ${collection}`);
  }
  return records;
}

async function writeCollection(stagingDirectory, collection, records, chunkSize) {
  const chunks = [];
  let chunkRecords = [];
  let count = 0;
  let index = 0;
  const flush = async () => {
    if (chunkRecords.length === 0) return;
    const contents = stringifyCanonical(chunkRecords);
    const file = `${collection}-${String(index).padStart(6, "0")}.json`;
    await writeFile(path.join(stagingDirectory, file), contents, { encoding: "utf8", flag: "wx" });
    chunks.push({
      file,
      start: count - chunkRecords.length,
      count: chunkRecords.length,
      sha256: sha256(contents),
    });
    index += 1;
    chunkRecords = [];
  };
  for await (const record of requireIterable(records, collection)) {
    chunkRecords.push(record);
    count += 1;
    if (chunkRecords.length === chunkSize) await flush();
  }
  await flush();
  return { count, chunks };
}

export async function readSnapshotManifest(rootDirectory, snapshotId) {
  const directory = snapshotDirectory(rootDirectory, snapshotId);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`unsupported snapshot schema version: ${manifest.schemaVersion}`);
  }
  if (manifest.snapshotId !== snapshotId) throw new Error("snapshot manifest ID mismatch");
  for (const collection of COLLECTION_NAMES) {
    const descriptor = manifest.collections?.[collection];
    if (!descriptor || !Number.isSafeInteger(descriptor.count) || descriptor.count < 0 || !Array.isArray(descriptor.chunks)) {
      throw new Error(`snapshot manifest is missing collection metadata: ${collection}`);
    }
    let expectedStart = 0;
    for (const chunk of descriptor.chunks) {
      if (!chunk || !Number.isSafeInteger(chunk.start) || chunk.start !== expectedStart ||
          !Number.isSafeInteger(chunk.count) || chunk.count < 1 ||
          typeof chunk.file !== "string" || !/^[-A-Za-z0-9]+\.json$/.test(chunk.file) ||
          typeof chunk.sha256 !== "string" || !SNAPSHOT_ID_PATTERN.test(chunk.sha256)) {
        throw new Error(`snapshot manifest has invalid chunk metadata: ${collection}`);
      }
      expectedStart += chunk.count;
    }
    if (expectedStart !== descriptor.count) {
      throw new Error(`snapshot manifest collection count mismatch: ${collection}`);
    }
  }
  if (typeof manifest.payloadSha256 !== "string" ||
      sha256(stringifyCanonical(manifestPayload(manifest))) !== manifest.payloadSha256) {
    throw new Error("snapshot manifest payload checksum mismatch");
  }
  return manifest;
}

export async function writeReportSnapshotStream(
  { header, collections: collectionInputs },
  rootDirectory,
  { chunkSize = DEFAULT_SNAPSHOT_CHUNK_SIZE } = {},
) {
  if (typeof header !== "function" && (!header || typeof header !== "object" || Array.isArray(header))) {
    throw new TypeError("snapshot header must be an object or async factory");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("snapshot chunkSize must be a positive safe integer");
  }
  for (const collection of COLLECTION_NAMES) {
    requireIterable(collectionInputs?.[collection], collection);
    if (typeof header !== "function" && Object.hasOwn(header, collection)) {
      throw new Error(`snapshot header includes collection: ${collection}`);
    }
  }

  const root = path.resolve(rootDirectory);
  await mkdir(root, { recursive: true });
  const staging = path.join(root, `.pending.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    const collections = {};
    for (const collection of COLLECTION_NAMES) {
      collections[collection] = await writeCollection(
        staging, collection, collectionInputs[collection], chunkSize,
      );
    }
    const resolvedHeader = typeof header === "function" ? await header() : header;
    if (!resolvedHeader || typeof resolvedHeader !== "object" || Array.isArray(resolvedHeader)) {
      throw new TypeError("snapshot header factory must resolve to an object");
    }
    for (const collection of COLLECTION_NAMES) {
      if (Object.hasOwn(resolvedHeader, collection)) {
        throw new Error(`snapshot header includes collection: ${collection}`);
      }
    }
    const normalizedHeader = JSON.parse(stringifyCanonical(resolvedHeader));
    const snapshotId = await computeStoredReportId(staging, normalizedHeader, collections);
    const destination = snapshotDirectory(root, snapshotId);
    if (await exists(destination)) {
      const manifest = await verifyReportSnapshot(root, snapshotId);
      await rm(staging, { recursive: true, force: true });
      return { snapshotId, directory: destination, manifest, created: false };
    }
    const payload = {
      reportSchemaVersion: normalizedHeader.schemaVersion,
      chunkSize,
      header: normalizedHeader,
      collections,
    };
    const manifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      payloadSha256: sha256(stringifyCanonical(payload)),
      ...payload,
    };
    await writeFile(path.join(staging, "manifest.json"), stringifyCanonical(manifest, { pretty: true }), {
      encoding: "utf8",
      flag: "wx",
    });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !(await exists(destination))) throw error;
      await rm(staging, { recursive: true, force: true });
      const existing = await verifyReportSnapshot(root, snapshotId);
      return { snapshotId, directory: destination, manifest: existing, created: false };
    }
    return { snapshotId, directory: destination, manifest, created: true };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function writeReportSnapshot(
  report,
  rootDirectory,
  options = {},
) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("writeReportSnapshot expects an AnalysisReport object");
  }
  for (const collection of COLLECTION_NAMES) {
    if (!Array.isArray(report[collection])) {
      throw new TypeError(`AnalysisReport collection must be an array: ${collection}`);
    }
  }
  const header = Object.fromEntries(
    Object.entries(report).filter(([key]) => !COLLECTION_SET.has(key)),
  );
  const collections = Object.fromEntries(
    COLLECTION_NAMES.map((collection) => [collection, report[collection]]),
  );
  return writeReportSnapshotStream({ header, collections }, rootDirectory, options);
}

async function readVerifiedChunkContents(directory, descriptor) {
  if (!/^[-A-Za-z0-9]+\.json$/.test(descriptor.file)) {
    throw new Error("snapshot chunk filename is invalid");
  }
  const contents = await readFile(path.join(directory, descriptor.file), "utf8");
  if (sha256(contents) !== descriptor.sha256) {
    throw new Error(`snapshot chunk checksum mismatch: ${descriptor.file}`);
  }
  const records = JSON.parse(contents);
  if (!Array.isArray(records) || records.length !== descriptor.count) {
    throw new Error(`snapshot chunk record count mismatch: ${descriptor.file}`);
  }
  return { contents, records };
}

async function readVerifiedChunk(directory, descriptor) {
  return (await readVerifiedChunkContents(directory, descriptor)).records;
}

async function computeStoredReportId(directory, header, collections) {
  const hash = createHash("sha256");
  const keys = [...Object.keys(header), ...COLLECTION_NAMES].sort();
  hash.update("{");
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) hash.update(",");
    const key = keys[index];
    hash.update(JSON.stringify(key));
    hash.update(":");
    if (!COLLECTION_SET.has(key)) {
      const encoded = stringifyCanonical(header[key]);
      hash.update(encoded.slice(0, -1));
      continue;
    }
    hash.update("[");
    let hasRecords = false;
    for (const chunk of collections[key].chunks) {
      const { contents } = await readVerifiedChunkContents(directory, chunk);
      const inner = contents.slice(1, -2);
      if (!inner) continue;
      if (hasRecords) hash.update(",");
      hash.update(inner);
      hasRecords = true;
    }
    hash.update("]");
  }
  hash.update("}\n");
  return hash.digest("hex");
}

export async function verifyReportSnapshot(rootDirectory, snapshotId) {
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const directory = snapshotDirectory(rootDirectory, snapshotId);
  const actual = await computeStoredReportId(directory, manifest.header, manifest.collections);
  if (actual !== snapshotId) throw new Error("snapshot report digest mismatch");
  return manifest;
}

export async function readSnapshotPage(
  rootDirectory,
  snapshotId,
  collection,
  { offset = 0, limit = 1_000 } = {},
) {
  validateCollection(collection);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("snapshot page offset must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`snapshot page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const descriptor = manifest.collections[collection];
  const end = Math.min(descriptor.count, offset + limit);
  const records = [];
  const directory = snapshotDirectory(rootDirectory, snapshotId);
  for (const chunk of descriptor.chunks) {
    const chunkEnd = chunk.start + chunk.count;
    if (chunkEnd <= offset || chunk.start >= end) continue;
    const chunkRecords = await readVerifiedChunk(directory, chunk);
    const from = Math.max(offset, chunk.start) - chunk.start;
    const to = Math.min(end, chunkEnd) - chunk.start;
    records.push(...chunkRecords.slice(from, to));
  }
  return {
    snapshotId,
    collection,
    offset,
    limit,
    total: descriptor.count,
    records,
  };
}

export async function readReportSnapshot(rootDirectory, snapshotId) {
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const report = { ...manifest.header };
  for (const collection of COLLECTION_NAMES) {
    const descriptor = manifest.collections[collection];
    const page = await readSnapshotPage(rootDirectory, snapshotId, collection, {
      offset: 0,
      limit: Math.max(1, Math.min(MAX_PAGE_SIZE, descriptor.count || 1)),
    });
    const records = [...page.records];
    while (records.length < descriptor.count) {
      const next = await readSnapshotPage(rootDirectory, snapshotId, collection, {
        offset: records.length,
        limit: Math.min(MAX_PAGE_SIZE, descriptor.count - records.length),
      });
      if (next.records.length === 0) {
        throw new Error(`snapshot collection made no read progress: ${collection}`);
      }
      records.push(...next.records);
    }
    report[collection] = records;
  }
  if (computeSnapshotId(report) !== snapshotId) throw new Error("snapshot report digest mismatch");
  return report;
}
