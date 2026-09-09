import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { stringifyCanonical } from "./json.js";
import { PARSER_NAME, PARSER_VERSION } from "./model.js";
import { readSnapshotManifest, readSnapshotPage } from "./snapshot-store.js";

export const DERIVED_SYNTAX_SCHEMA_VERSION = 1;
export const DERIVED_SYNTAX_KIND = "av1scope-derived-syntax-snapshot";
const DERIVED_DIRECTORY_NAME = "derived-syntax";
const DERIVED_INDEX_DIRECTORY_NAME = "indexes/derived-syntax";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STAGING_DIRECTORY_PATTERN = /^\.pending\.\d+\.[0-9a-f-]{36}\.tmp$/;

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function validateDigest(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
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

function storeDirectory(rootDirectory) {
  return path.join(path.resolve(rootDirectory), DERIVED_DIRECTORY_NAME);
}

function snapshotDirectory(rootDirectory, derivedSnapshotId) {
  validateDigest(derivedSnapshotId, "derivedSnapshotId");
  return path.join(storeDirectory(rootDirectory), derivedSnapshotId);
}

function indexParentDirectory(rootDirectory, parentSnapshotId) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  return path.join(path.resolve(rootDirectory), DERIVED_INDEX_DIRECTORY_NAME, parentSnapshotId);
}

async function derivedDirectoryIds(rootDirectory) {
  let entries;
  try {
    entries = await readdir(storeDirectory(rootDirectory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory() && SHA256_PATTERN.test(entry.name))
    .map(({ name }) => name)
    .sort();
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

function validateDerivedSyntaxIndex(index, parentSnapshotId, storeRevision, indexId) {
  if (!index || index.schemaVersion !== 1 ||
      index.kind !== "av1scope-derived-syntax-index" ||
      index.parentSnapshotId !== parentSnapshotId ||
      index.storeRevision !== storeRevision || index.indexId !== indexId ||
      sha256(stringifyCanonical(indexPayload(index))) !== indexId ||
      !Array.isArray(index.entries)) {
    throw new Error("derived syntax index is invalid or stale");
  }
  let previousObuId = -1;
  let previousId = "";
  for (const entry of index.entries) {
    validateDigest(entry?.derivedSnapshotId, "index derivedSnapshotId");
    if (!Number.isSafeInteger(entry.obuId) || entry.obuId < 0 ||
        entry.obuId < previousObuId ||
        (entry.obuId === previousObuId && entry.derivedSnapshotId <= previousId)) {
      throw new Error("derived syntax index entry ordering is invalid");
    }
    previousObuId = entry.obuId;
    previousId = entry.derivedSnapshotId;
  }
  return index;
}

function indexEntry(manifest) {
  return {
    derivedSnapshotId: manifest.derivedSnapshotId,
    obuId: manifest.request.obuId,
    type: manifest.inspection.type,
    status: manifest.inspection.status,
    nodeCount: manifest.inspection.nodes.length,
    diagnosticCount: manifest.inspection.diagnostics.length,
    parserVersion: manifest.provenance.parserVersion,
    payloadSha256: manifest.request.payloadSha256,
  };
}

export async function rebuildDerivedSyntaxIndex(rootDirectory, parentSnapshotId) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  await readSnapshotManifest(rootDirectory, parentSnapshotId);
  const ids = await derivedDirectoryIds(rootDirectory);
  const storeRevision = sha256(stringifyCanonical(ids));
  const entries = [];
  for (const id of ids) {
    const candidatePath = path.join(storeDirectory(rootDirectory), id, "manifest.json");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    if (candidate.parentSnapshotId !== parentSnapshotId) continue;
    entries.push(indexEntry(await readDerivedSyntaxSnapshot(rootDirectory, id)));
  }
  entries.sort((left, right) => left.obuId - right.obuId ||
    left.derivedSnapshotId.localeCompare(right.derivedSnapshotId));
  const payload = {
    schemaVersion: 1,
    kind: "av1scope-derived-syntax-index",
    parentSnapshotId,
    storeRevision,
    entries,
  };
  const indexId = sha256(stringifyCanonical(payload));
  const index = { indexId, ...payload };
  const directory = indexParentDirectory(rootDirectory, parentSnapshotId);
  const destination = path.join(directory, `${indexId}.json`);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.pending.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, stringifyCanonical(index, { pretty: true }), {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code)) throw error;
      await rm(destination, { force: true });
      await rename(temporary, destination);
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return index;
}

export async function readDerivedSyntaxIndex(rootDirectory, parentSnapshotId) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  await readSnapshotManifest(rootDirectory, parentSnapshotId);
  const ids = await derivedDirectoryIds(rootDirectory);
  const storeRevision = sha256(stringifyCanonical(ids));
  const directory = indexParentDirectory(rootDirectory, parentSnapshotId);
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
    const match = entry.isFile() && entry.name.match(/^([0-9a-f]{64})\.json$/);
    if (!match) continue;
    try {
      const index = JSON.parse(await readFile(path.join(directory, entry.name), "utf8"));
      return validateDerivedSyntaxIndex(index, parentSnapshotId, storeRevision, match[1]);
    } catch {
      // Index files are recoverable caches. Continue to a valid revision or rebuild.
    }
  }
  return rebuildDerivedSyntaxIndex(rootDirectory, parentSnapshotId);
}

export async function cleanupDerivedSyntaxStaging(
  rootDirectory,
  { minimumAgeMs = 60 * 60 * 1_000, now = Date.now() } = {},
) {
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new RangeError("derived syntax staging minimumAgeMs must be non-negative");
  }
  const root = storeDirectory(rootDirectory);
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

function contentPayload(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    parentSnapshotId: manifest.parentSnapshotId,
    sourceBinding: manifest.sourceBinding,
    request: manifest.request,
    provenance: manifest.provenance,
    inspection: manifest.inspection,
  };
}

function validateInspection(inspection, request) {
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
    throw new TypeError("derived syntax inspection must be an object");
  }
  if (inspection.schemaVersion !== 1 ||
      inspection.kind !== "av1scope-snapshot-syntax-inspection" ||
      inspection.obuId !== request.obuId || !Array.isArray(inspection.nodes) ||
      !Array.isArray(inspection.diagnostics)) {
    throw new Error("derived syntax inspection shape is invalid");
  }
}

async function validateParentBinding(rootDirectory, manifest) {
  const parent = await readSnapshotManifest(rootDirectory, manifest.parentSnapshotId);
  const page = await readSnapshotPage(rootDirectory, manifest.parentSnapshotId, "obus", {
    offset: manifest.request.obuId,
    limit: 1,
  });
  const record = page.records[0];
  if (!record || record.obuId !== manifest.request.obuId) {
    throw new Error("derived syntax parent OBU no longer exists");
  }
  if (record.type?.code !== manifest.inspection.type?.code ||
      record.payloadRange?.start !== manifest.inspection.payloadRange?.start ||
      record.payloadRange?.length !== manifest.inspection.payloadRange?.length) {
    throw new Error("derived syntax parent OBU binding mismatch");
  }
  if (manifest.inspection.inspectedPayloadBytes !== manifest.request.payloadBytes ||
      manifest.request.payloadBytes > record.payloadRange.length ||
      ([1, 4, 5].includes(record.type.code) &&
        manifest.request.payloadBytes !== record.payloadRange.length)) {
    throw new Error("derived syntax target payload length binding mismatch");
  }
  const context = manifest.request.sequenceContext;
  if (context !== null) {
    if (context.obuId >= manifest.request.obuId) {
      throw new Error("derived syntax sequence context must precede the target OBU");
    }
    const contextPage = await readSnapshotPage(
      rootDirectory, manifest.parentSnapshotId, "obus", {
        offset: context.obuId,
        limit: 1,
      },
    );
    const sequence = contextPage.records[0];
    if (!sequence || sequence.obuId !== context.obuId || sequence.type?.code !== 1 ||
        context.payloadBytes !== sequence.payloadRange?.length) {
      throw new Error("derived syntax sequence context parent binding mismatch");
    }
  }
  const frameContext = manifest.request.frameHeaderContext ?? null;
  if (frameContext !== null) {
    if (record.type.code !== 4 || frameContext.obuId >= manifest.request.obuId) {
      throw new Error("derived syntax frame context must precede a Tile Group target");
    }
    const framePage = await readSnapshotPage(
      rootDirectory, manifest.parentSnapshotId, "obus", {
        offset: frameContext.obuId,
        limit: 1,
      },
    );
    const frameHeader = framePage.records[0];
    if (!frameHeader || frameHeader.obuId !== frameContext.obuId ||
        ![3, 7].includes(frameHeader.type?.code) ||
        frameContext.payloadBytes !== frameHeader.payloadRange?.length) {
      throw new Error("derived syntax frame context parent binding mismatch");
    }
    if (frameHeader.header?.extensionFlag !== record.header?.extensionFlag ||
        frameHeader.header?.temporalId !== record.header?.temporalId ||
        frameHeader.header?.spatialId !== record.header?.spatialId ||
        (frameHeader.frameId !== null && record.frameId !== null &&
          frameHeader.frameId !== record.frameId)) {
      throw new Error("derived syntax Frame Header and Tile Group layer binding mismatch");
    }
    if (context === null || context.obuId >= frameContext.obuId) {
      throw new Error("derived syntax Tile Group requires an earlier sequence context");
    }
  } else if (record.type.code === 4) {
    throw new Error("derived syntax Tile Group frame context is missing");
  }
  const expectedFingerprint = parent.header?.source?.fingerprint ?? null;
  if (stringifyCanonical(expectedFingerprint) !== stringifyCanonical(
    manifest.sourceBinding.expectedFingerprint,
  )) {
    throw new Error("derived syntax source fingerprint binding mismatch");
  }
  if (parent.header?.source?.size !== manifest.sourceBinding.expectedSize) {
    throw new Error("derived syntax source size binding mismatch");
  }
  if (!Number.isSafeInteger(manifest.sourceBinding.expectedSize) ||
      typeof manifest.sourceBinding.verificationBoundary !== "string" ||
      typeof manifest.provenance?.parser !== "string" ||
      typeof manifest.provenance?.parserVersion !== "string" ||
      manifest.provenance.operation !== "snapshot-obu-syntax-inspection") {
    throw new Error("derived syntax provenance metadata is invalid");
  }
  return parent;
}

export async function readDerivedSyntaxSnapshot(rootDirectory, derivedSnapshotId) {
  const directory = snapshotDirectory(rootDirectory, derivedSnapshotId);
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== DERIVED_SYNTAX_SCHEMA_VERSION ||
      manifest.kind !== DERIVED_SYNTAX_KIND) {
    throw new Error("unsupported derived syntax snapshot schema");
  }
  if (manifest.derivedSnapshotId !== derivedSnapshotId) {
    throw new Error("derived syntax snapshot ID mismatch");
  }
  validateDigest(manifest.parentSnapshotId, "parentSnapshotId");
  validateDigest(manifest.request?.payloadSha256, "request.payloadSha256");
  if (!Number.isSafeInteger(manifest.request?.obuId) || manifest.request.obuId < 0 ||
      !Number.isSafeInteger(manifest.request?.payloadBytes) || manifest.request.payloadBytes < 1 ||
      manifest.request.transport !== "client-submitted-payload") {
    throw new Error("derived syntax request metadata is invalid");
  }
  if (manifest.request.sequenceContext !== null) {
    validateDigest(manifest.request.sequenceContext?.payloadSha256,
      "request.sequenceContext.payloadSha256");
    if (!Number.isSafeInteger(manifest.request.sequenceContext?.obuId) ||
        manifest.request.sequenceContext.obuId < 0 ||
        !Number.isSafeInteger(manifest.request.sequenceContext?.payloadBytes) ||
        manifest.request.sequenceContext.payloadBytes < 1) {
      throw new Error("derived syntax sequence context metadata is invalid");
    }
  }
  const frameContext = manifest.request.frameHeaderContext ?? null;
  if (frameContext !== null) {
    validateDigest(frameContext?.payloadSha256,
      "request.frameHeaderContext.payloadSha256");
    if (!Number.isSafeInteger(frameContext?.obuId) || frameContext.obuId < 0 ||
        !Number.isSafeInteger(frameContext?.payloadBytes) || frameContext.payloadBytes < 1) {
      throw new Error("derived syntax frame context metadata is invalid");
    }
  }
  validateInspection(manifest.inspection, manifest.request);
  const actualId = sha256(stringifyCanonical(contentPayload(manifest)));
  if (actualId !== derivedSnapshotId) {
    throw new Error("derived syntax snapshot content digest mismatch");
  }
  await validateParentBinding(rootDirectory, manifest);
  return manifest;
}

export async function listDerivedSyntaxSnapshots(
  rootDirectory,
  parentSnapshotId,
  { offset = 0, limit = 100 } = {},
) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError("derived syntax page requires offset >= 0 and limit 1..10000");
  }
  const index = await readDerivedSyntaxIndex(rootDirectory, parentSnapshotId);
  return {
    schemaVersion: 1,
    kind: "av1scope-derived-syntax-page",
    parentSnapshotId,
    offset,
    limit,
    indexId: index.indexId,
    storeRevision: index.storeRevision,
    total: index.entries.length,
    records: index.entries.slice(offset, offset + limit),
  };
}

export async function writeDerivedSyntaxSnapshot(
  rootDirectory,
  {
    parentSnapshotId,
    obuId,
    payload,
    sequenceObuId = null,
    sequencePayload = null,
    frameHeaderObuId = null,
    frameHeaderPayload = null,
    inspection,
  },
) {
  validateDigest(parentSnapshotId, "parentSnapshotId");
  if (!Number.isSafeInteger(obuId) || obuId < 0 || !Buffer.isBuffer(payload) || payload.length < 1) {
    throw new TypeError("derived syntax request requires an OBU ID and non-empty payload Buffer");
  }
  if ((sequenceObuId === null) !== (sequencePayload === null) ||
      (sequenceObuId !== null && (!Number.isSafeInteger(sequenceObuId) || sequenceObuId < 0 ||
        !Buffer.isBuffer(sequencePayload) || sequencePayload.length < 1))) {
    throw new TypeError("derived syntax sequence context must be supplied as an ID and payload Buffer");
  }
  if ((frameHeaderObuId === null) !== (frameHeaderPayload === null) ||
      (frameHeaderObuId !== null &&
        (!Number.isSafeInteger(frameHeaderObuId) || frameHeaderObuId < 0 ||
          !Buffer.isBuffer(frameHeaderPayload) || frameHeaderPayload.length < 1))) {
    throw new TypeError("derived syntax frame context must be supplied as an ID and payload Buffer");
  }
  const parent = await readSnapshotManifest(rootDirectory, parentSnapshotId);
  const request = {
    obuId,
    payloadBytes: payload.length,
    payloadSha256: sha256(payload),
    sequenceContext: sequenceObuId === null ? null : {
      obuId: sequenceObuId,
      payloadBytes: sequencePayload.length,
      payloadSha256: sha256(sequencePayload),
    },
    frameHeaderContext: frameHeaderObuId === null ? null : {
      obuId: frameHeaderObuId,
      payloadBytes: frameHeaderPayload.length,
      payloadSha256: sha256(frameHeaderPayload),
    },
    transport: "client-submitted-payload",
  };
  validateInspection(inspection, request);
  const payloadDocument = {
    schemaVersion: DERIVED_SYNTAX_SCHEMA_VERSION,
    kind: DERIVED_SYNTAX_KIND,
    parentSnapshotId,
    sourceBinding: {
      expectedSize: parent.header?.source?.size,
      expectedFingerprint: parent.header?.source?.fingerprint ?? null,
      verificationBoundary: "browser-sampled; server binds submitted payload digest only",
    },
    request,
    provenance: {
      parser: PARSER_NAME,
      parserVersion: PARSER_VERSION,
      operation: "snapshot-obu-syntax-inspection",
    },
    inspection,
  };
  const derivedSnapshotId = sha256(stringifyCanonical(payloadDocument));
  const manifest = { derivedSnapshotId, ...payloadDocument };
  await validateParentBinding(rootDirectory, manifest);
  const root = storeDirectory(rootDirectory);
  const destination = snapshotDirectory(rootDirectory, derivedSnapshotId);
  await mkdir(root, { recursive: true });
  if (await exists(destination)) {
    return {
      derivedSnapshotId,
      directory: destination,
      manifest: await readDerivedSyntaxSnapshot(rootDirectory, derivedSnapshotId),
      created: false,
    };
  }
  const staging = path.join(root, `.pending.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(staging);
  try {
    await writeFile(path.join(staging, "manifest.json"), stringifyCanonical(manifest, {
      pretty: true,
    }), { encoding: "utf8", flag: "wx" });
    try {
      await rename(staging, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code) || !(await exists(destination))) throw error;
      await rm(staging, { recursive: true, force: true });
      return {
        derivedSnapshotId,
        directory: destination,
        manifest: await readDerivedSyntaxSnapshot(rootDirectory, derivedSnapshotId),
        created: false,
      };
    }
    return { derivedSnapshotId, directory: destination, manifest, created: true };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
