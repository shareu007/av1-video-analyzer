import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { querySnapshot } from "../src/snapshot-query.js";
import { readSnapshotQueryIndex } from "../src/snapshot-query-index.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { makeObu } from "./fixtures.js";

async function fixture(root) {
  const report = analyzeBuffer(Buffer.concat([
    makeObu({ type: 2 }),
    makeObu({ type: 15, payload: Buffer.from([0xaa]) }),
    makeObu({ type: 5, payload: Buffer.from([0x01, 0x01, 0x01]) }),
    makeObu({ type: 15, payload: Buffer.from([0xbb, 0xcc]) }),
  ]), { sourceName: "query.obu" });
  return writeReportSnapshot(report, root, { chunkSize: 2 });
}

async function indexedFixture(root) {
  const records = [];
  for (let index = 0; index < 80; index += 1) {
    records.push([5, 45, 75].includes(index)
      ? makeObu({ type: 5, payload: Buffer.from([0x01, 0x01, 0x01]) })
      : makeObu({ type: 15, payload: Buffer.from([index & 255]) }));
  }
  const report = analyzeBuffer(Buffer.concat(records), { sourceName: "indexed-query.obu" });
  return writeReportSnapshot(report, root, { chunkSize: 10 });
}

test("snapshot query filters nested fields, projects paths and resumes with a stable token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-query-"));
  try {
    const snapshot = await fixture(root);
    const request = {
      collection: "obus",
      filter: {
        all: [
          { path: "type.code", op: "eq", value: 15 },
          { path: "payloadRange.length", op: "gte", value: 1 },
        ],
      },
      projection: ["obuId", "type.name", "payloadRange.length"],
      limit: 1,
    };
    const first = await querySnapshot(root, snapshot.snapshotId, request);
    assert.equal(first.kind, "av1scope-snapshot-query-page");
    assert.equal(first.sourceTotal, 4);
    assert.equal(first.matchedCount, 1);
    assert.deepEqual(first.records, [{
      sourceOffset: 1,
      record: {
        obuId: 1,
        "type.name": "padding",
        "payloadRange.length": 1,
      },
    }]);
    assert.match(first.nextPageToken, /^[A-Za-z0-9_-]+$/);

    const second = await querySnapshot(root, snapshot.snapshotId, {
      ...request,
      pageToken: first.nextPageToken,
    });
    assert.equal(second.queryId, first.queryId);
    assert.equal(second.records[0].sourceOffset, 3);
    assert.equal(second.records[0].record["payloadRange.length"], 2);
    assert.equal(second.nextPageToken, null);

    await assert.rejects(querySnapshot(root, snapshot.snapshotId, {
      ...request,
      filter: { path: "type.code", op: "eq", value: 5 },
      pageToken: first.nextPageToken,
    }), /does not match the immutable query/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot query supports boolean, membership, substring and existence operators", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-query-"));
  try {
    const snapshot = await fixture(root);
    const result = await querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: {
        any: [
          { path: "type.name", op: "contains", value: "metadata" },
          {
            all: [
              { path: "type.code", op: "in", value: [15] },
              { not: { path: "frameId", op: "exists", value: false } },
            ],
          },
        ],
      },
      limit: 10,
    });
    assert.deepEqual(result.records.map(({ record }) => record.type.code), [15, 5, 15]);

    const missing = await querySnapshot(root, snapshot.snapshotId, {
      collection: "frames",
      filter: { path: "headerSummary", op: "exists", value: false },
      limit: 10,
    });
    assert.equal(missing.sourceTotal, 0);
    assert.equal(missing.matchedCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot query rejects unsafe expressions, mismatched tokens and damaged chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-query-"));
  try {
    const snapshot = await fixture(root);
    await assert.rejects(querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: { path: "__proto__.polluted", op: "eq", value: 1 },
    }), /safe dotted record path/);
    await assert.rejects(querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: { path: "obuId", op: "gte", value: "1" },
    }), /requires a numeric value/);
    await assert.rejects(querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      projection: [],
    }), /projection must contain/);
    await assert.rejects(querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      pageToken: "not_a_valid_token",
    }), /malformed|does not match/);

    const manifest = JSON.parse(await readFile(
      path.join(snapshot.directory, "manifest.json"), "utf8",
    ));
    await writeFile(
      path.join(snapshot.directory, manifest.collections.obus.chunks[0].file),
      "[]\n",
    );
    await assert.rejects(querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: null,
    }), /checksum mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot query observes cancellation before scanning", async () => {
  const controller = new AbortController();
  controller.abort("cancelled");
  await assert.rejects(
    querySnapshot(process.cwd(), "0".repeat(64), {
      collection: "obus",
    }, { signal: controller.signal }),
    (error) => error.code === "SNAPSHOT_QUERY_CANCELLED" && error.statusCode === 499,
  );
});

test("snapshot query sidecar skips chunks without changing records or page tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-query-index-"));
  try {
    const snapshot = await indexedFixture(root);
    const request = {
      collection: "obus",
      filter: { path: "type.code", op: "eq", value: 5 },
      projection: ["obuId", "type.code"],
      limit: 1,
    };
    const full = await querySnapshot(root, snapshot.snapshotId, request, { useIndex: false });
    const indexed = await querySnapshot(root, snapshot.snapshotId, request);
    assert.deepEqual(indexed.records, full.records);
    assert.equal(indexed.queryId, full.queryId);
    assert.equal(indexed.nextPageToken, full.nextPageToken);
    assert.equal(full.execution.strategy, "full-scan");
    assert.equal(full.execution.skippedRecords, 0);
    assert.equal(indexed.execution.strategy, "sidecar-index-v1");
    assert.equal(indexed.execution.indexStatus, "rebuilt");
    assert.equal(indexed.execution.indexBuildScannedRecords, 80);
    assert.match(indexed.execution.indexId, /^[0-9a-f]{64}$/u);
    assert.ok(indexed.scannedCount < full.scannedCount);
    assert.ok(indexed.execution.scannedChunks < full.execution.scannedChunks);
    assert.ok(indexed.execution.skippedRecords >= 30);

    const fullNext = await querySnapshot(root, snapshot.snapshotId, {
      ...request,
      pageToken: full.nextPageToken,
    }, { useIndex: false });
    const indexedNext = await querySnapshot(root, snapshot.snapshotId, {
      ...request,
      pageToken: indexed.nextPageToken,
    });
    assert.deepEqual(indexedNext.records, fullNext.records);
    assert.equal(indexedNext.execution.indexStatus, "hit");
    assert.equal(indexedNext.execution.indexBuildScannedRecords, 0);
    assert.equal(indexedNext.nextPageToken, fullNext.nextPageToken);
    assert.ok(indexedNext.scannedCount < fullNext.scannedCount);

    const range = await querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: { path: "obuId", op: "gte", value: 75 },
      limit: 10,
    });
    assert.deepEqual(range.records.map(({ sourceOffset }) => sourceOffset), [75, 76, 77, 78, 79]);
    assert.equal(range.execution.scannedChunks, 1);
    assert.equal(range.execution.skippedRecords, 70);

    const notPadding = await querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: { path: "type.code", op: "ne", value: 15 },
      limit: 10,
    });
    assert.deepEqual(notPadding.records.map(({ sourceOffset }) => sourceOffset), [5, 45, 75]);
    assert.ok(notPadding.execution.skippedChunks >= 5);

    const absentTemporalId = await querySnapshot(root, snapshot.snapshotId, {
      collection: "obus",
      filter: { path: "header.temporalId", op: "exists", value: false },
      limit: 10,
    });
    assert.equal(absentTemporalId.matchedCount, 0);
    assert.equal(absentTemporalId.scannedCount, 0);
    assert.equal(absentTemporalId.execution.skippedRecords, 80);

    const compoundRequest = {
      collection: "obus",
      filter: {
        all: [
          { path: "type.code", op: "eq", value: 15 },
          { path: "type.name", op: "contains", value: "padding" },
        ],
      },
      limit: 100,
    };
    const compoundFull = await querySnapshot(
      root, snapshot.snapshotId, compoundRequest, { useIndex: false },
    );
    const compoundIndexed = await querySnapshot(root, snapshot.snapshotId, compoundRequest);
    assert.deepEqual(compoundIndexed.records, compoundFull.records);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot query rebuilds a damaged sidecar from verified chunks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-query-index-repair-"));
  try {
    const snapshot = await indexedFixture(root);
    const request = {
      collection: "obus",
      filter: { path: "type.code", op: "eq", value: 5 },
      limit: 10,
    };
    const before = await querySnapshot(root, snapshot.snapshotId, request);
    const sidecar = await readSnapshotQueryIndex(root, snapshot.snapshotId, "obus");
    assert.equal(sidecar.indexId, before.execution.indexId);
    const sidecarPath = path.join(
      root, "indexes", "snapshot-query", snapshot.snapshotId, "obus", `${sidecar.indexId}.json`,
    );
    await writeFile(sidecarPath, "{broken");
    const repaired = await querySnapshot(root, snapshot.snapshotId, request);
    assert.deepEqual(repaired.records, before.records);
    assert.equal(repaired.execution.indexId, sidecar.indexId);
    assert.equal(repaired.execution.indexStatus, "rebuilt");
    assert.equal(JSON.parse(await readFile(sidecarPath, "utf8")).indexId, sidecar.indexId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
