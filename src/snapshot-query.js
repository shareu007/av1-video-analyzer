import { createHash } from "node:crypto";

import { stringifyCanonical } from "./json.js";
import {
  readSnapshotQueryIndex,
  snapshotQueryCanUseIndex,
  snapshotQueryChunkMayMatch,
} from "./snapshot-query-index.js";
import { readSnapshotManifest, readSnapshotPage } from "./snapshot-store.js";

export const SNAPSHOT_QUERY_SCHEMA_VERSION = 1;
export const SNAPSHOT_QUERY_KIND = "av1scope-snapshot-query-page";
export const MAX_SNAPSHOT_QUERY_LIMIT = 1_000;

const COLLECTIONS = new Set(["frames", "obus", "syntaxNodes", "diagnostics"]);
const OPERATORS = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains", "exists"]);
const PATH_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.(?:[A-Za-z][A-Za-z0-9]*|\d+))*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_FILTER_NODES = 64;
const MAX_FILTER_DEPTH = 8;
const MAX_PROJECTION_FIELDS = 32;
const MAX_IN_VALUES = 100;
const MAX_STRING_BYTES = 4_096;
const QUERY_SCAN_PAGE_SIZE = 1_000;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validatePath(value, label) {
  if (typeof value !== "string" || value.length > 256 || !PATH_PATTERN.test(value) ||
      value.split(".").some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
    throw new TypeError(`${label} must be a safe dotted record path`);
  }
  return value;
}

function validateScalar(value, label) {
  if (value === null || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string" && Buffer.byteLength(value) <= MAX_STRING_BYTES) return value;
  throw new TypeError(`${label} must be a bounded JSON scalar`);
}

function normalizeFilterNode(node, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_FILTER_NODES || depth > MAX_FILTER_DEPTH) {
    throw new RangeError("snapshot query filter exceeds its complexity budget");
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new TypeError("snapshot query filter nodes must be objects");
  }
  const booleanKeys = ["all", "any", "not"].filter((key) => Object.hasOwn(node, key));
  if (booleanKeys.length > 0) {
    if (booleanKeys.length !== 1 || Object.hasOwn(node, "path") || Object.hasOwn(node, "op")) {
      throw new TypeError("snapshot query boolean nodes must use exactly one of all/any/not");
    }
    const key = booleanKeys[0];
    if (key === "not") return { not: normalizeFilterNode(node.not, state, depth + 1) };
    if (!Array.isArray(node[key]) || node[key].length < 1 || node[key].length > MAX_FILTER_NODES) {
      throw new RangeError(`snapshot query ${key} must contain 1..${MAX_FILTER_NODES} filters`);
    }
    return { [key]: node[key].map((child) => normalizeFilterNode(child, state, depth + 1)) };
  }
  const path = validatePath(node.path, "snapshot query filter path");
  if (!OPERATORS.has(node.op)) throw new TypeError("snapshot query filter operator is unsupported");
  if (node.op === "exists") {
    if (typeof node.value !== "boolean") {
      throw new TypeError("snapshot query exists requires a boolean value");
    }
    return { path, op: node.op, value: node.value };
  }
  if (node.op === "in") {
    if (!Array.isArray(node.value) || node.value.length < 1 || node.value.length > MAX_IN_VALUES) {
      throw new RangeError(`snapshot query in requires 1..${MAX_IN_VALUES} scalar values`);
    }
    return {
      path,
      op: node.op,
      value: node.value.map((value) => validateScalar(value, "snapshot query in value")),
    };
  }
  const value = validateScalar(node.value, "snapshot query filter value");
  if (["lt", "lte", "gt", "gte"].includes(node.op) && typeof value !== "number") {
    throw new TypeError(`snapshot query ${node.op} requires a numeric value`);
  }
  return { path, op: node.op, value };
}

export function normalizeSnapshotQuery({ collection, filter = null, projection = null }) {
  if (!COLLECTIONS.has(collection)) throw new RangeError("snapshot query collection is unsupported");
  const normalizedFilter = filter === null ? null : normalizeFilterNode(filter, { nodes: 0 });
  let normalizedProjection = null;
  if (projection !== null) {
    if (!Array.isArray(projection) || projection.length < 1 ||
        projection.length > MAX_PROJECTION_FIELDS) {
      throw new RangeError(
        `snapshot query projection must contain 1..${MAX_PROJECTION_FIELDS} paths`,
      );
    }
    normalizedProjection = projection.map((item) =>
      validatePath(item, "snapshot query projection path"));
    if (new Set(normalizedProjection).size !== normalizedProjection.length) {
      throw new Error("snapshot query projection paths must be unique");
    }
  }
  return { collection, filter: normalizedFilter, projection: normalizedProjection };
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

function equal(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  return stringifyCanonical(left) === stringifyCanonical(right);
}

function matchesLeaf(record, filter) {
  const selected = ownPath(record, filter.path);
  if (filter.op === "exists") return selected.exists === filter.value;
  if (!selected.exists) return false;
  switch (filter.op) {
    case "eq": return equal(selected.value, filter.value);
    case "ne": return !equal(selected.value, filter.value);
    case "lt": return typeof selected.value === "number" && selected.value < filter.value;
    case "lte": return typeof selected.value === "number" && selected.value <= filter.value;
    case "gt": return typeof selected.value === "number" && selected.value > filter.value;
    case "gte": return typeof selected.value === "number" && selected.value >= filter.value;
    case "in": return filter.value.some((value) => equal(selected.value, value));
    case "contains":
      return typeof selected.value === "string" && typeof filter.value === "string"
        ? selected.value.includes(filter.value)
        : Array.isArray(selected.value) && selected.value.some((value) => equal(value, filter.value));
    default: return false;
  }
}

function matchesFilter(record, filter) {
  if (filter === null) return true;
  if (filter.all) return filter.all.every((child) => matchesFilter(record, child));
  if (filter.any) return filter.any.some((child) => matchesFilter(record, child));
  if (filter.not) return !matchesFilter(record, filter.not);
  return matchesLeaf(record, filter);
}

function projectRecord(record, projection) {
  if (projection === null) return record;
  return Object.fromEntries(projection.map((path) => {
    const selected = ownPath(record, path);
    return [path, selected.exists ? selected.value : null];
  }));
}

function queryId(query) {
  return sha256(stringifyCanonical(query));
}

function encodePageToken(payload) {
  const token = { ...payload, tokenSha256: sha256(stringifyCanonical(payload)) };
  return Buffer.from(stringifyCanonical(token), "utf8").toString("base64url");
}

function decodePageToken(value, expected) {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 ||
      !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("snapshot query pageToken is malformed");
  }
  let token;
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.toString("base64url") !== value) throw new Error("non-canonical token");
    token = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new TypeError("snapshot query pageToken is malformed");
  }
  const { tokenSha256, ...payload } = token ?? {};
  if (tokenSha256 !== sha256(stringifyCanonical(payload)) || payload.schemaVersion !== 1 ||
      payload.snapshotId !== expected.snapshotId || payload.queryId !== expected.queryId ||
      !Number.isSafeInteger(payload.nextRecordOffset) || payload.nextRecordOffset < 0) {
    throw new Error("snapshot query pageToken does not match the immutable query");
  }
  return payload.nextRecordOffset;
}

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const timedOut = signal.reason === "timeout";
  const error = new Error(timedOut ? "snapshot query deadline exceeded" : "snapshot query cancelled");
  error.name = "AbortError";
  error.code = timedOut ? "SNAPSHOT_QUERY_TIMEOUT" : "SNAPSHOT_QUERY_CANCELLED";
  error.statusCode = timedOut ? 504 : 499;
  throw error;
}

export async function querySnapshot(
  rootDirectory,
  snapshotId,
  {
    collection,
    filter = null,
    projection = null,
    limit = 100,
    pageToken = null,
  },
  { signal = null, useIndex = true } = {},
) {
  throwIfCancelled(signal);
  if (typeof useIndex !== "boolean") throw new TypeError("snapshot query useIndex must be boolean");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SNAPSHOT_QUERY_LIMIT) {
    throw new RangeError(`snapshot query limit must be between 1 and ${MAX_SNAPSHOT_QUERY_LIMIT}`);
  }
  const query = normalizeSnapshotQuery({ collection, filter, projection });
  const id = queryId(query);
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const sourceTotal = manifest.collections[collection].count;
  const startOffset = pageToken === null
    ? 0
    : decodePageToken(pageToken, { snapshotId, queryId: id });
  if (startOffset > sourceTotal) {
    throw new RangeError("snapshot query pageToken offset exceeds the collection");
  }
  let queryIndex = null;
  let indexFallback = false;
  if (useIndex && snapshotQueryCanUseIndex(collection, query.filter)) {
    try {
      queryIndex = await readSnapshotQueryIndex(rootDirectory, snapshotId, collection, { signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      indexFallback = true;
    }
  }
  const sourceChunks = manifest.collections[collection].chunks;
  const indexedChunks = queryIndex?.chunks ?? null;
  const records = [];
  let scannedCount = 0;
  const scannedChunks = new Set();
  let skippedChunks = 0;
  let skippedRecords = 0;
  let offset = startOffset;
  let chunkPosition = 0;
  let nextRecordOffset = null;
  while (offset < sourceTotal && nextRecordOffset === null) {
    throwIfCancelled(signal);
    while (chunkPosition < sourceChunks.length
        && sourceChunks[chunkPosition].start + sourceChunks[chunkPosition].count <= offset) {
      chunkPosition += 1;
    }
    const sourceChunk = sourceChunks[chunkPosition];
    if (!sourceChunk || offset < sourceChunk.start) {
      throw new Error("snapshot query manifest topology has a source gap");
    }
    const chunkEnd = sourceChunk.start + sourceChunk.count;
    if (indexedChunks !== null
        && !snapshotQueryChunkMayMatch(indexedChunks[chunkPosition], query.filter)) {
      skippedChunks += 1;
      skippedRecords += chunkEnd - offset;
      offset = chunkEnd;
      continue;
    }
    const page = await readSnapshotPage(rootDirectory, snapshotId, collection, {
      offset,
      limit: Math.min(QUERY_SCAN_PAGE_SIZE, chunkEnd - offset),
    });
    if (page.records.length === 0) {
      throw new Error("snapshot query scan made no progress");
    }
    scannedChunks.add(sourceChunk.file);
    for (let index = 0; index < page.records.length; index += 1) {
      if ((index & 255) === 0) throwIfCancelled(signal);
      const sourceOffset = offset + index;
      scannedCount += 1;
      if (!matchesFilter(page.records[index], query.filter)) continue;
      if (records.length === limit) {
        nextRecordOffset = sourceOffset;
        break;
      }
      records.push({
        sourceOffset,
        record: projectRecord(page.records[index], query.projection),
      });
    }
    offset += page.records.length;
  }
  throwIfCancelled(signal);
  return {
    schemaVersion: SNAPSHOT_QUERY_SCHEMA_VERSION,
    kind: SNAPSHOT_QUERY_KIND,
    snapshotId,
    collection,
    queryId: id,
    filter: query.filter,
    projection: query.projection,
    limit,
    sourceTotal,
    scannedCount,
    execution: {
      strategy: queryIndex === null ? "full-scan" : "sidecar-index-v1",
      indexId: queryIndex?.indexId ?? null,
      indexStatus: queryIndex?.cacheStatus ?? null,
      indexBuildScannedRecords: queryIndex?.cacheStatus === "rebuilt" ? sourceTotal : 0,
      indexFallback,
      scannedChunks: scannedChunks.size,
      skippedChunks,
      skippedRecords,
    },
    matchedCount: records.length,
    records,
    nextPageToken: nextRecordOffset === null ? null : encodePageToken({
      schemaVersion: 1,
      snapshotId,
      queryId: id,
      nextRecordOffset,
    }),
  };
}
