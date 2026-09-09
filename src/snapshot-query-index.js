import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringifyCanonical } from "./json.js";
import { readSnapshotManifest, readSnapshotPage } from "./snapshot-store.js";

export const SNAPSHOT_QUERY_INDEX_SCHEMA_VERSION = 1;
export const SNAPSHOT_QUERY_INDEX_KIND = "av1scope-snapshot-query-index";

const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_EXACT_VALUES = 64;
const MAX_INDEXED_STRING_BYTES = 4_096;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_PAGE = 10_000;
const INDEX_ROOT = "indexes/snapshot-query";
const INDEXED_FIELDS = Object.freeze({
  frames: Object.freeze([
    "frameId", "streamId", "trackId", "dts", "pts", "duration", "keyFrame",
    "payloadRange.start", "payloadRange.length", "byteRange.start", "byteRange.length",
    "complete",
  ]),
  obus: Object.freeze([
    "obuId", "frameId", "type.code", "type.name", "header.temporalId",
    "header.spatialId", "byteRange.start", "byteRange.length", "payloadRange.start",
    "payloadRange.length", "complete", "syntaxStatus",
  ]),
  syntaxNodes: Object.freeze([
    "nodeId", "obuId", "frameId", "path", "coding", "bitRange.startBit",
    "bitRange.lengthBits", "specAnchor",
  ]),
  diagnostics: Object.freeze([
    "frameId", "obuId", "code", "severity", "byteRange.start", "byteRange.length",
  ]),
});
export const SNAPSHOT_QUERY_INDEX_COLLECTIONS = Object.freeze(Object.keys(INDEXED_FIELDS));

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const timedOut = signal.reason === "timeout";
  const error = new Error(timedOut
    ? "snapshot query index deadline exceeded" : "snapshot query index cancelled");
  error.name = "AbortError";
  error.code = timedOut ? "SNAPSHOT_QUERY_TIMEOUT" : "SNAPSHOT_QUERY_CANCELLED";
  error.statusCode = timedOut ? 504 : 499;
  throw error;
}

function ownPath(record, dottedPath) {
  let value = record;
  for (const segment of dottedPath.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      return { exists: false, value: undefined };
    }
    value = value[segment];
  }
  return { exists: true, value };
}

function isScalar(value) {
  return value === null || typeof value === "boolean"
    || (typeof value === "string" && Buffer.byteLength(value) <= MAX_INDEXED_STRING_BYTES)
    || (typeof value === "number" && Number.isFinite(value));
}

function createFieldSummary() {
  return {
    presentCount: 0,
    scalarCount: 0,
    numberCount: 0,
    numberMinimum: null,
    numberMaximum: null,
    exact: new Map(),
  };
}

function addFieldValue(summary, record, field) {
  const selected = ownPath(record, field);
  if (!selected.exists) return;
  summary.presentCount += 1;
  if (!isScalar(selected.value)) return;
  summary.scalarCount += 1;
  if (typeof selected.value === "number") {
    summary.numberCount += 1;
    summary.numberMinimum = summary.numberMinimum === null
      ? selected.value : Math.min(summary.numberMinimum, selected.value);
    summary.numberMaximum = summary.numberMaximum === null
      ? selected.value : Math.max(summary.numberMaximum, selected.value);
  }
  if (summary.exact !== null) {
    summary.exact.set(stringifyCanonical(selected.value), selected.value);
    if (summary.exact.size > MAX_EXACT_VALUES) summary.exact = null;
  }
}

function finishFieldSummary(summary) {
  const values = summary.exact === null ? null : [...summary.exact.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
  return {
    presentCount: summary.presentCount,
    scalarCount: summary.scalarCount,
    numberCount: summary.numberCount,
    numberMinimum: summary.numberMinimum,
    numberMaximum: summary.numberMaximum,
    values,
  };
}

function collectionRevision(descriptor) {
  return sha256(stringifyCanonical({ count: descriptor.count, chunks: descriptor.chunks }));
}

function indexPayload(index) {
  return {
    schemaVersion: index.schemaVersion,
    kind: index.kind,
    snapshotId: index.snapshotId,
    snapshotPayloadSha256: index.snapshotPayloadSha256,
    collection: index.collection,
    collectionRevision: index.collectionRevision,
    sourceTotal: index.sourceTotal,
    fields: index.fields,
    chunks: index.chunks,
  };
}

function indexDirectory(rootDirectory, snapshotId, collection) {
  if (!SHA256.test(snapshotId) || !Object.hasOwn(INDEXED_FIELDS, collection)) {
    throw new TypeError("snapshot query index target is invalid");
  }
  return path.join(path.resolve(rootDirectory), INDEX_ROOT, snapshotId, collection);
}

function validateStats(stats, count, label) {
  for (const key of ["presentCount", "scalarCount", "numberCount"]) {
    if (!Number.isSafeInteger(stats?.[key]) || stats[key] < 0 || stats[key] > count) {
      throw new Error(`${label}.${key} is invalid`);
    }
  }
  if (stats.scalarCount > stats.presentCount || stats.numberCount > stats.scalarCount) {
    throw new Error(`${label} counts are inconsistent`);
  }
  if (stats.numberCount === 0) {
    if (stats.numberMinimum !== null || stats.numberMaximum !== null) {
      throw new Error(`${label} numeric bounds must be null`);
    }
  } else if (typeof stats.numberMinimum !== "number"
      || !Number.isFinite(stats.numberMinimum)
      || typeof stats.numberMaximum !== "number"
      || !Number.isFinite(stats.numberMaximum)
      || stats.numberMinimum > stats.numberMaximum) {
    throw new Error(`${label} numeric bounds are invalid`);
  }
  if (stats.values !== null) {
    if (!Array.isArray(stats.values) || stats.values.length > MAX_EXACT_VALUES
        || stats.values.length > stats.scalarCount
        || stats.values.some((value) => !isScalar(value))) {
      throw new Error(`${label}.values is invalid`);
    }
    const canonical = stats.values.map((value) => stringifyCanonical(value));
    if (new Set(canonical).size !== canonical.length
        || canonical.some((value, index) => index > 0
          && value.localeCompare(canonical[index - 1]) <= 0)) {
      throw new Error(`${label}.values ordering is invalid`);
    }
  }
}

export function validateSnapshotQueryIndexDocument(index, manifest, collection, indexId) {
  if (!Object.hasOwn(INDEXED_FIELDS, collection)) {
    throw new RangeError("snapshot query index collection is unsupported");
  }
  const descriptor = manifest.collections[collection];
  const fields = INDEXED_FIELDS[collection];
  if (!index || index.schemaVersion !== SNAPSHOT_QUERY_INDEX_SCHEMA_VERSION
      || index.kind !== SNAPSHOT_QUERY_INDEX_KIND
      || index.snapshotId !== manifest.snapshotId
      || index.snapshotPayloadSha256 !== manifest.payloadSha256
      || index.collection !== collection
      || index.collectionRevision !== collectionRevision(descriptor)
      || index.sourceTotal !== descriptor.count
      || stringifyCanonical(index.fields) !== stringifyCanonical(fields)
      || index.indexId !== indexId
      || sha256(stringifyCanonical(indexPayload(index))) !== indexId
      || !Array.isArray(index.chunks)
      || index.chunks.length !== descriptor.chunks.length) {
    throw new Error("snapshot query index is invalid or stale");
  }
  for (let indexPosition = 0; indexPosition < index.chunks.length; indexPosition += 1) {
    const chunk = index.chunks[indexPosition];
    const source = descriptor.chunks[indexPosition];
    if (chunk?.file !== source.file || chunk.start !== source.start || chunk.count !== source.count
        || chunk.sourceSha256 !== source.sha256 || !chunk.stats
        || typeof chunk.stats !== "object" || Array.isArray(chunk.stats)
        || Object.keys(chunk.stats).length !== fields.length) {
      throw new Error("snapshot query index chunk binding is invalid");
    }
    for (const field of fields) validateStats(chunk.stats[field], chunk.count, field);
  }
  return index;
}

export async function rebuildSnapshotQueryIndex(
  rootDirectory,
  snapshotId,
  collection,
  { signal = null } = {},
) {
  throwIfCancelled(signal);
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  if (!Object.hasOwn(INDEXED_FIELDS, collection)) {
    throw new RangeError("snapshot query index collection is unsupported");
  }
  const descriptor = manifest.collections[collection];
  const fields = INDEXED_FIELDS[collection];
  const chunks = [];
  for (const source of descriptor.chunks) {
    throwIfCancelled(signal);
    const summaries = Object.fromEntries(fields.map((field) => [field, createFieldSummary()]));
    let consumed = 0;
    while (consumed < source.count) {
      throwIfCancelled(signal);
      const page = await readSnapshotPage(rootDirectory, snapshotId, collection, {
        offset: source.start + consumed,
        limit: Math.min(MAX_SOURCE_PAGE, source.count - consumed),
      });
      if (page.records.length === 0) {
        throw new Error("snapshot query index source chunk made no progress");
      }
      for (const record of page.records) {
        for (const field of fields) addFieldValue(summaries[field], record, field);
      }
      consumed += page.records.length;
    }
    chunks.push({
      file: source.file,
      start: source.start,
      count: source.count,
      sourceSha256: source.sha256,
      stats: Object.fromEntries(fields.map((field) => [field, finishFieldSummary(summaries[field])])),
    });
  }
  const payload = {
    schemaVersion: SNAPSHOT_QUERY_INDEX_SCHEMA_VERSION,
    kind: SNAPSHOT_QUERY_INDEX_KIND,
    snapshotId,
    snapshotPayloadSha256: manifest.payloadSha256,
    collection,
    collectionRevision: collectionRevision(descriptor),
    sourceTotal: descriptor.count,
    fields: [...fields],
    chunks,
  };
  const indexId = sha256(stringifyCanonical(payload));
  const index = { indexId, ...payload };
  const directory = indexDirectory(rootDirectory, snapshotId, collection);
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${indexId}.json`);
  const temporary = path.join(directory, `.pending.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, stringifyCanonical(index), { encoding: "utf8", flag: "wx" });
  try {
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(["EEXIST", "EPERM"].includes(error.code))) throw error;
      await rm(destination, { force: true });
      await rename(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return { ...index, cacheStatus: "rebuilt" };
}

export async function readSnapshotQueryIndex(
  rootDirectory,
  snapshotId,
  collection,
  { signal = null } = {},
) {
  throwIfCancelled(signal);
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const directory = indexDirectory(rootDirectory, snapshotId, collection);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
    const match = entry.isFile() && /^([0-9a-f]{64})\.json$/u.exec(entry.name);
    if (!match) continue;
    try {
      const target = path.join(directory, entry.name);
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.size > MAX_INDEX_BYTES) continue;
      const index = JSON.parse(await readFile(target, "utf8"));
      return {
        ...validateSnapshotQueryIndexDocument(index, manifest, collection, match[1]),
        cacheStatus: "hit",
      };
    } catch {
      // Sidecars are recoverable caches. Try another revision or rebuild from verified chunks.
    }
  }
  return rebuildSnapshotQueryIndex(rootDirectory, snapshotId, collection, { signal });
}

export function snapshotQueryCanUseIndex(collection, filter) {
  const fields = new Set(INDEXED_FIELDS[collection] ?? []);
  const useful = (node) => {
    if (node === null) return false;
    if (node.not) return false;
    if (node.all || node.any) return (node.all ?? node.any).some(useful);
    return fields.has(node.path) && [
      "eq", "ne", "lt", "lte", "gt", "gte", "in", "exists",
    ].includes(node.op);
  };
  return useful(filter);
}

function exactIncludes(values, value) {
  return values.some((item) => stringifyCanonical(item) === stringifyCanonical(value));
}

function leafMayMatch(stats, count, filter) {
  if (!stats) return true;
  if (filter.op === "exists") {
    return filter.value ? stats.presentCount > 0 : stats.presentCount < count;
  }
  if (filter.op === "eq") {
    if (typeof filter.value === "number" && (stats.numberCount === 0
        || filter.value < stats.numberMinimum || filter.value > stats.numberMaximum)) return false;
    return stats.values === null || exactIncludes(stats.values, filter.value);
  }
  if (filter.op === "in") {
    return filter.value.some((value) => leafMayMatch(stats, count, {
      path: filter.path, op: "eq", value,
    }));
  }
  if (filter.op === "ne") {
    return !(stats.scalarCount === stats.presentCount && stats.values !== null
      && stats.values.length === 1 && exactIncludes(stats.values, filter.value));
  }
  if (!["lt", "lte", "gt", "gte"].includes(filter.op)) return true;
  if (stats.numberCount === 0) return false;
  if (filter.op === "lt") return stats.numberMinimum < filter.value;
  if (filter.op === "lte") return stats.numberMinimum <= filter.value;
  if (filter.op === "gt") return stats.numberMaximum > filter.value;
  if (filter.op === "gte") return stats.numberMaximum >= filter.value;
  return true;
}

export function snapshotQueryChunkMayMatch(chunk, filter) {
  if (filter === null || filter.not) return true;
  if (filter.all) return filter.all.every((child) => snapshotQueryChunkMayMatch(chunk, child));
  if (filter.any) return filter.any.some((child) => snapshotQueryChunkMayMatch(chunk, child));
  return leafMayMatch(chunk.stats[filter.path], chunk.count, filter);
}
