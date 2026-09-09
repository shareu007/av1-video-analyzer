import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { readDerivedSyntaxSnapshot } from "./derived-syntax-store.js";
import { stringifyCanonical } from "./json.js";
import { readSnapshotManifest } from "./snapshot-store.js";

export const SYNTAX_OVERLAY_SCHEMA_VERSION = 1;
export const SYNTAX_OVERLAY_KIND = "av1scope-syntax-overlay-snapshot";
export const DEFAULT_SYNTAX_OVERLAY_CHUNK_SIZE = 1_000;
const OVERLAY_DIRECTORY_NAME = "syntax-overlays";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_DIRECTORY_PATTERN = /^\.pending\.\d+\.[0-9a-f-]{36}\.tmp$/;
const CHUNK_FILE_PATTERN = /^(syntaxNodes|diagnostics)-\d{6}\.json$/;
const COLLECTION_NAMES = Object.freeze(["syntaxNodes", "diagnostics"]);
const MAX_PAGE_SIZE = 10_000;
const MAX_DERIVED_SNAPSHOTS = 10_000;
const MAX_OVERLAY_NODES = 500_000;
const MAX_OVERLAY_DIAGNOSTICS = 100_000;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validateDigest(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
}

function overlayRoot(rootDirectory) {
  return path.join(path.resolve(rootDirectory), OVERLAY_DIRECTORY_NAME);
}

function overlayDirectory(rootDirectory, overlaySnapshotId) {
  validateDigest(overlaySnapshotId, "overlaySnapshotId");
  return path.join(overlayRoot(rootDirectory), overlaySnapshotId);
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

function semanticPayload(document) {
  return {
    schemaVersion: document.schemaVersion,
    kind: document.kind,
    parentSnapshotId: document.parentSnapshotId,
    derivedSnapshotIds: document.derivedSnapshotIds,
    syntaxNodes: document.syntaxNodes,
    diagnostics: document.diagnostics,
    summary: document.summary,
    provenance: document.provenance,
  };
}

function storagePayload(manifest) {
  return {
    reportSchemaVersion: manifest.reportSchemaVersion,
    storageLayout: manifest.storageLayout,
    chunkSize: manifest.chunkSize,
    parentSnapshotId: manifest.parentSnapshotId,
    derivedSnapshotIds: manifest.derivedSnapshotIds,
    summary: manifest.summary,
    provenance: manifest.provenance,
    collections: manifest.collections,
  };
}

async function prepareOverlay(rootDirectory, parentSnapshotId, derivedSnapshotIds) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  if (!Array.isArray(derivedSnapshotIds) || derivedSnapshotIds.length < 1 ||
      derivedSnapshotIds.length > MAX_DERIVED_SNAPSHOTS) {
    throw new RangeError(`syntax overlay requires 1..${MAX_DERIVED_SNAPSHOTS} derived snapshots`);
  }
  if (new Set(derivedSnapshotIds).size !== derivedSnapshotIds.length) {
    throw new Error("syntax overlay derived snapshot IDs must be unique");
  }
  for (const id of derivedSnapshotIds) validateDigest(id, "derivedSnapshotId");
  const parent = await readSnapshotManifest(rootDirectory, parentSnapshotId);
  const derived = [];
  for (const id of derivedSnapshotIds) {
    const manifest = await readDerivedSyntaxSnapshot(rootDirectory, id);
    if (manifest.parentSnapshotId !== parentSnapshotId) {
      throw new Error(`derived syntax snapshot ${id} belongs to a different parent`);
    }
    derived.push({
      derivedSnapshotId: manifest.derivedSnapshotId,
      obuId: manifest.request.obuId,
      status: manifest.inspection.status,
      nodeCount: manifest.inspection.nodes.length,
      diagnosticCount: manifest.inspection.diagnostics.length,
      hasErrors: manifest.inspection.diagnostics.some(({ severity }) =>
        severity === "error" || severity === "fatal"),
      contributor: {
        derivedSnapshotId: manifest.derivedSnapshotId,
        obuId: manifest.request.obuId,
        parser: manifest.provenance.parser,
        parserVersion: manifest.provenance.parserVersion,
        payloadSha256: manifest.request.payloadSha256,
      },
    });
  }
  derived.sort((left, right) => left.obuId - right.obuId ||
    left.derivedSnapshotId.localeCompare(right.derivedSnapshotId));
  const covered = new Set();
  let nodeCount = 0;
  let diagnosticCount = 0;
  for (const entry of derived) {
    if (covered.has(entry.obuId)) {
      throw new Error(`syntax overlay has multiple results for OBU ${entry.obuId}`);
    }
    covered.add(entry.obuId);
    nodeCount += entry.nodeCount;
    diagnosticCount += entry.diagnosticCount;
  }
  if (nodeCount > MAX_OVERLAY_NODES) {
    throw new RangeError(`syntax overlay exceeds the ${MAX_OVERLAY_NODES}-node budget`);
  }
  if (diagnosticCount > MAX_OVERLAY_DIAGNOSTICS) {
    throw new RangeError(`syntax overlay exceeds the ${MAX_OVERLAY_DIAGNOSTICS}-diagnostic budget`);
  }
  const header = {
    schemaVersion: SYNTAX_OVERLAY_SCHEMA_VERSION,
    kind: SYNTAX_OVERLAY_KIND,
    parentSnapshotId,
    derivedSnapshotIds: derived.map(({ derivedSnapshotId: id }) => id),
    summary: {
      coveredObuCount: covered.size,
      syntaxNodeCount: nodeCount,
      diagnosticCount,
      complete: derived.every(({ status, hasErrors }) => status === "complete" && !hasErrors),
    },
    provenance: {
      operation: "merge-derived-syntax",
      parentReportSchemaVersion: parent.reportSchemaVersion,
      contributors: derived.map(({ contributor }) => contributor),
    },
  };
  return { header, derived };
}

async function* syntaxNodeRecords(rootDirectory, prepared) {
  let nodeId = 0;
  for (const entry of prepared.derived) {
    const manifest = await readDerivedSyntaxSnapshot(rootDirectory, entry.derivedSnapshotId);
    for (const node of manifest.inspection.nodes) {
      yield {
        ...node,
        nodeId,
        sourceNodeId: node.nodeId,
        derivedSnapshotId: manifest.derivedSnapshotId,
      };
      nodeId += 1;
    }
  }
}

async function* diagnosticRecords(rootDirectory, prepared) {
  for (const entry of prepared.derived) {
    const manifest = await readDerivedSyntaxSnapshot(rootDirectory, entry.derivedSnapshotId);
    for (const item of manifest.inspection.diagnostics) {
      yield { ...item, derivedSnapshotId: manifest.derivedSnapshotId };
    }
  }
}

async function buildOverlayPayload(rootDirectory, parentSnapshotId, derivedSnapshotIds) {
  const prepared = await prepareOverlay(rootDirectory, parentSnapshotId, derivedSnapshotIds);
  const syntaxNodes = [];
  for await (const node of syntaxNodeRecords(rootDirectory, prepared)) syntaxNodes.push(node);
  const diagnostics = [];
  for await (const item of diagnosticRecords(rootDirectory, prepared)) diagnostics.push(item);
  return {
    ...prepared.header,
    syntaxNodes,
    diagnostics,
    summary: prepared.header.summary,
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
    chunks.push({ file, start: count - values.length, count: values.length, sha256: sha256(contents) });
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

async function computeStoredSemanticId(staging, header, collections) {
  const hash = createHash("sha256");
  const collectionSet = new Set(COLLECTION_NAMES);
  const keys = [...Object.keys(header), ...COLLECTION_NAMES].sort();
  hash.update("{");
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) hash.update(",");
    const key = keys[index];
    hash.update(JSON.stringify(key));
    hash.update(":");
    if (!collectionSet.has(key)) {
      hash.update(stringifyCanonical(header[key]).slice(0, -1));
      continue;
    }
    hash.update("[");
    let hasRecords = false;
    for (const chunk of collections[key].chunks) {
      const contents = await readFile(path.join(staging, chunk.file), "utf8");
      if (sha256(contents) !== chunk.sha256) {
        throw new Error(`syntax overlay staging checksum mismatch: ${chunk.file}`);
      }
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

function validateCollectionDescriptor(collection, descriptor) {
  if (!descriptor || !Number.isSafeInteger(descriptor.count) || descriptor.count < 0 ||
      !Array.isArray(descriptor.chunks)) {
    throw new Error(`syntax overlay manifest is missing collection: ${collection}`);
  }
  let expectedStart = 0;
  for (const chunk of descriptor.chunks) {
    if (!chunk || chunk.start !== expectedStart || !Number.isSafeInteger(chunk.count) ||
        chunk.count < 1 || typeof chunk.file !== "string" ||
        !CHUNK_FILE_PATTERN.test(chunk.file) || !chunk.file.startsWith(`${collection}-`) ||
        typeof chunk.sha256 !== "string" || !SHA256_PATTERN.test(chunk.sha256)) {
      throw new Error(`syntax overlay manifest has invalid ${collection} chunk metadata`);
    }
    expectedStart += chunk.count;
  }
  if (expectedStart !== descriptor.count) {
    throw new Error(`syntax overlay manifest ${collection} count mismatch`);
  }
}

export async function readSyntaxOverlayManifest(rootDirectory, overlaySnapshotId) {
  const directory = overlayDirectory(rootDirectory, overlaySnapshotId);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== SYNTAX_OVERLAY_SCHEMA_VERSION ||
      manifest.kind !== SYNTAX_OVERLAY_KIND || manifest.overlaySnapshotId !== overlaySnapshotId) {
    throw new Error("unsupported or mismatched syntax overlay snapshot");
  }
  // Compatibility with the initial inline v1 representation.
  if (Array.isArray(manifest.syntaxNodes) && Array.isArray(manifest.diagnostics) &&
      manifest.collections === undefined) {
    const actualId = sha256(stringifyCanonical(semanticPayload(manifest)));
    if (actualId !== overlaySnapshotId) {
      throw new Error("syntax overlay snapshot content digest mismatch");
    }
    return {
      overlaySnapshotId,
      schemaVersion: manifest.schemaVersion,
      kind: manifest.kind,
      reportSchemaVersion: manifest.schemaVersion,
      storageLayout: "legacy-inline-v1",
      chunkSize: null,
      parentSnapshotId: manifest.parentSnapshotId,
      derivedSnapshotIds: manifest.derivedSnapshotIds,
      summary: manifest.summary,
      provenance: manifest.provenance,
      collections: {
        syntaxNodes: { count: manifest.syntaxNodes.length, chunks: [] },
        diagnostics: { count: manifest.diagnostics.length, chunks: [] },
      },
    };
  }
  if (manifest.storageLayout !== "chunked-v1" ||
      !Number.isSafeInteger(manifest.chunkSize) || manifest.chunkSize < 1) {
    throw new Error("unsupported syntax overlay storage layout");
  }
  for (const collection of COLLECTION_NAMES) {
    validateCollectionDescriptor(collection, manifest.collections?.[collection]);
  }
  if (typeof manifest.payloadSha256 !== "string" ||
      sha256(stringifyCanonical(storagePayload(manifest))) !== manifest.payloadSha256) {
    throw new Error("syntax overlay manifest payload checksum mismatch");
  }
  return manifest;
}

async function readVerifiedChunk(directory, descriptor) {
  const contents = await readFile(path.join(directory, descriptor.file), "utf8");
  if (sha256(contents) !== descriptor.sha256) {
    throw new Error(`syntax overlay chunk checksum mismatch: ${descriptor.file}`);
  }
  const records = JSON.parse(contents);
  if (!Array.isArray(records) || records.length !== descriptor.count) {
    throw new Error(`syntax overlay chunk record count mismatch: ${descriptor.file}`);
  }
  return records;
}

function semanticHeaderFromManifest(manifest) {
  return {
    schemaVersion: manifest.reportSchemaVersion,
    kind: manifest.kind,
    parentSnapshotId: manifest.parentSnapshotId,
    derivedSnapshotIds: manifest.derivedSnapshotIds,
    summary: manifest.summary,
    provenance: manifest.provenance,
  };
}

async function* storedCollectionRecords(directory, manifest, collection) {
  for (const chunk of manifest.collections[collection].chunks) {
    yield* await readVerifiedChunk(directory, chunk);
  }
}

async function compareRecordStreams(storedRecords, rebuiltRecords) {
  const stored = storedRecords[Symbol.asyncIterator]();
  const rebuilt = rebuiltRecords[Symbol.asyncIterator]();
  while (true) {
    const [left, right] = await Promise.all([stored.next(), rebuilt.next()]);
    if (left.done || right.done) return left.done === right.done;
    if (stringifyCanonical(left.value) !== stringifyCanonical(right.value)) return false;
  }
}

export async function verifySyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId) {
  const manifest = await readSyntaxOverlayManifest(rootDirectory, overlaySnapshotId);
  if (manifest.storageLayout === "legacy-inline-v1") {
    await readSyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId);
    return manifest;
  }
  const directory = overlayDirectory(rootDirectory, overlaySnapshotId);
  const header = semanticHeaderFromManifest(manifest);
  if (await computeStoredSemanticId(directory, header, manifest.collections) !== overlaySnapshotId) {
    throw new Error("syntax overlay snapshot content digest mismatch");
  }
  const prepared = await prepareOverlay(
    rootDirectory, manifest.parentSnapshotId, manifest.derivedSnapshotIds,
  );
  if (stringifyCanonical(prepared.header) !== stringifyCanonical(header) ||
      !await compareRecordStreams(
        storedCollectionRecords(directory, manifest, "syntaxNodes"),
        syntaxNodeRecords(rootDirectory, prepared),
      ) ||
      !await compareRecordStreams(
        storedCollectionRecords(directory, manifest, "diagnostics"),
        diagnosticRecords(rootDirectory, prepared),
      )) {
    throw new Error("syntax overlay snapshot does not match its derived inputs");
  }
  return manifest;
}

export async function readSyntaxOverlayPage(
  rootDirectory,
  overlaySnapshotId,
  collection,
  { offset = 0, limit = 200 } = {},
) {
  if (!COLLECTION_NAMES.includes(collection)) {
    throw new RangeError(`unknown syntax overlay collection: ${collection}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new RangeError(`syntax overlay page requires offset >= 0 and limit 1..${MAX_PAGE_SIZE}`);
  }
  const manifest = await readSyntaxOverlayManifest(rootDirectory, overlaySnapshotId);
  if (manifest.storageLayout === "legacy-inline-v1") {
    const full = await readSyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId);
    return {
      schemaVersion: 1,
      kind: "av1scope-syntax-overlay-page",
      overlaySnapshotId,
      collection,
      offset,
      limit,
      total: full[collection].length,
      records: full[collection].slice(offset, offset + limit),
    };
  }
  const descriptor = manifest.collections[collection];
  const end = Math.min(descriptor.count, offset + limit);
  const records = [];
  const directory = overlayDirectory(rootDirectory, overlaySnapshotId);
  for (const chunk of descriptor.chunks) {
    const chunkEnd = chunk.start + chunk.count;
    if (chunkEnd <= offset || chunk.start >= end) continue;
    const values = await readVerifiedChunk(directory, chunk);
    const from = Math.max(offset, chunk.start) - chunk.start;
    const to = Math.min(end, chunkEnd) - chunk.start;
    records.push(...values.slice(from, to));
  }
  return {
    schemaVersion: 1,
    kind: "av1scope-syntax-overlay-page",
    overlaySnapshotId,
    collection,
    offset,
    limit,
    total: descriptor.count,
    records,
  };
}

export async function readSyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId) {
  const directory = overlayDirectory(rootDirectory, overlaySnapshotId);
  const raw = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (Array.isArray(raw.syntaxNodes) && Array.isArray(raw.diagnostics) && raw.collections === undefined) {
    if (raw.overlaySnapshotId !== overlaySnapshotId ||
        sha256(stringifyCanonical(semanticPayload(raw))) !== overlaySnapshotId) {
      throw new Error("syntax overlay snapshot content digest mismatch");
    }
    const rebuilt = await buildOverlayPayload(
      rootDirectory, raw.parentSnapshotId, raw.derivedSnapshotIds,
    );
    if (stringifyCanonical(rebuilt) !== stringifyCanonical(semanticPayload(raw))) {
      throw new Error("syntax overlay snapshot does not match its derived inputs");
    }
    return raw;
  }
  const manifest = await readSyntaxOverlayManifest(rootDirectory, overlaySnapshotId);
  const document = {
    overlaySnapshotId,
    schemaVersion: manifest.reportSchemaVersion,
    kind: manifest.kind,
    parentSnapshotId: manifest.parentSnapshotId,
    derivedSnapshotIds: manifest.derivedSnapshotIds,
    syntaxNodes: [],
    diagnostics: [],
    summary: manifest.summary,
    provenance: manifest.provenance,
  };
  for (const collection of COLLECTION_NAMES) {
    for (const chunk of manifest.collections[collection].chunks) {
      document[collection].push(...await readVerifiedChunk(directory, chunk));
    }
  }
  if (sha256(stringifyCanonical(semanticPayload(document))) !== overlaySnapshotId) {
    throw new Error("syntax overlay snapshot content digest mismatch");
  }
  const rebuilt = await buildOverlayPayload(
    rootDirectory, document.parentSnapshotId, document.derivedSnapshotIds,
  );
  if (stringifyCanonical(rebuilt) !== stringifyCanonical(semanticPayload(document))) {
    throw new Error("syntax overlay snapshot does not match its derived inputs");
  }
  return document;
}

export async function writeSyntaxOverlaySnapshot(
  rootDirectory,
  { parentSnapshotId, derivedSnapshotIds },
  {
    chunkSize = DEFAULT_SYNTAX_OVERLAY_CHUNK_SIZE,
    returnDocument = false,
  } = {},
) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError("syntax overlay chunkSize must be a positive safe integer");
  }
  const prepared = await prepareOverlay(rootDirectory, parentSnapshotId, derivedSnapshotIds);
  const root = overlayRoot(rootDirectory);
  await mkdir(root, { recursive: true });
  const staging = path.join(root, `.pending.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    const collections = {
      syntaxNodes: await writeCollection(
        staging, "syntaxNodes", syntaxNodeRecords(rootDirectory, prepared), chunkSize,
      ),
      diagnostics: await writeCollection(
        staging, "diagnostics", diagnosticRecords(rootDirectory, prepared), chunkSize,
      ),
    };
    if (collections.syntaxNodes.count !== prepared.header.summary.syntaxNodeCount ||
        collections.diagnostics.count !== prepared.header.summary.diagnosticCount) {
      throw new Error("derived syntax inputs changed while streaming an overlay");
    }
    const overlaySnapshotId = await computeStoredSemanticId(
      staging, prepared.header, collections,
    );
    const destination = overlayDirectory(rootDirectory, overlaySnapshotId);
    if (await exists(destination)) {
      const storageManifest = await verifySyntaxOverlaySnapshot(
        rootDirectory, overlaySnapshotId,
      );
      const existing = returnDocument
        ? await readSyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId)
        : null;
      await rm(staging, { recursive: true, force: true });
      return {
        overlaySnapshotId,
        directory: destination,
        manifest: existing,
        storageManifest,
        created: false,
      };
    }
    const storage = {
      reportSchemaVersion: prepared.header.schemaVersion,
      storageLayout: "chunked-v1",
      chunkSize,
      parentSnapshotId: prepared.header.parentSnapshotId,
      derivedSnapshotIds: prepared.header.derivedSnapshotIds,
      summary: prepared.header.summary,
      provenance: prepared.header.provenance,
      collections,
    };
    const storageManifest = {
      overlaySnapshotId,
      schemaVersion: SYNTAX_OVERLAY_SCHEMA_VERSION,
      kind: SYNTAX_OVERLAY_KIND,
      payloadSha256: sha256(stringifyCanonical(storage)),
      ...storage,
    };
    await writeFile(path.join(staging, "manifest.json"), stringifyCanonical(storageManifest, {
      pretty: true,
    }), { encoding: "utf8", flag: "wx" });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !(await exists(destination))) throw error;
      await rm(staging, { recursive: true, force: true });
      const storageManifest = await verifySyntaxOverlaySnapshot(
        rootDirectory, overlaySnapshotId,
      );
      const existing = returnDocument
        ? await readSyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId)
        : null;
      return {
        overlaySnapshotId,
        directory: destination,
        manifest: existing,
        storageManifest,
        created: false,
      };
    }
    return {
      overlaySnapshotId,
      directory: destination,
      manifest: returnDocument
        ? await readSyntaxOverlaySnapshot(rootDirectory, overlaySnapshotId)
        : null,
      storageManifest,
      created: true,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function cleanupSyntaxOverlayStaging(
  rootDirectory,
  { minimumAgeMs = 60 * 60 * 1_000, now = Date.now() } = {},
) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RangeError("syntax overlay staging minimumAgeMs must be non-negative");
  }
  const root = overlayRoot(rootDirectory);
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true });
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !STAGING_DIRECTORY_PATTERN.test(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (now - (await stat(target)).mtimeMs < minimumAgeMs) continue;
    await rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
