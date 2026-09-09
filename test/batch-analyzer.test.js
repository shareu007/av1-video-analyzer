import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeBatchDirectory,
  enumerateBatchInputs,
  normalizeBatchExtensions,
} from "../src/batch-analyzer.js";
import { stringifyCanonical } from "../src/json.js";
import { makeObu } from "./fixtures.js";

test("batch enumeration is lexical, extension-bounded, and optionally recursive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-batch-enum-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "z.OBU"), makeObu({ type: 2 }));
    await writeFile(path.join(root, "a.ivf"), makeObu({ type: 2 }));
    await writeFile(path.join(root, "notes.txt"), "ignored");
    await writeFile(path.join(root, "nested", "b.obu"), makeObu({ type: 2 }));

    const flat = await enumerateBatchInputs(root, { extensions: ["obu", ".ivf"] });
    assert.deepEqual(flat.files.map(({ relativePath }) => relativePath), ["a.ivf", "z.OBU"]);
    assert.equal(flat.ignoredEntryCount, 2);

    const recursive = await enumerateBatchInputs(root, {
      recursive: true,
      extensions: [".IVF", "obu", "obu"],
    });
    assert.deepEqual(recursive.extensions, [".ivf", ".obu"]);
    assert.deepEqual(recursive.files.map(({ relativePath }) => relativePath), [
      "a.ivf", "nested/b.obu", "z.OBU",
    ]);
    assert.equal(recursive.ignoredEntryCount, 1);
    await assert.rejects(
      enumerateBatchInputs(root, { recursive: true, extensions: ["obu"], maxFiles: 1 }),
      /file budget/,
    );
    assert.deepEqual(normalizeBatchExtensions(["OBU", ".ivf", "obu"]), [".ivf", ".obu"]);
    assert.throws(() => normalizeBatchExtensions(["../obu"]), /invalid batch extension/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch analysis is byte-deterministic across concurrency levels", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-batch-run-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "clean.obu"), makeObu({ type: 2 }));
    await writeFile(path.join(root, "nested", "broken.obu"), Buffer.from([0x0a, 0x80]));
    const options = { recursive: true, extensions: ["obu"] };
    const serial = await analyzeBatchDirectory(root, { ...options, jobs: 1 });
    const concurrent = await analyzeBatchDirectory(root, { ...options, jobs: 3 });

    assert.equal(stringifyCanonical(serial), stringifyCanonical(concurrent));
    assert.deepEqual(serial.files.map(({ relativePath, status }) => [relativePath, status]), [
      ["clean.obu", "ok"],
      ["nested/broken.obu", "diagnostics"],
    ]);
    assert.equal(serial.files[0].sha256.length, 64);
    assert.equal(serial.summary.matchedFileCount, 2);
    assert.equal(serial.summary.okFileCount, 1);
    assert.equal(serial.summary.diagnosticFileCount, 1);
    assert.equal(serial.summary.failedFileCount, 0);
    assert.equal(serial.summary.totalErrors, 1);
    assert.deepEqual(serial.summary.diagnosticCodes, { LEB128_TRUNCATED: 1 });
    assert.deepEqual(serial.summary.formatCounts, { low_overhead_obu: 2 });
    assert.equal(serial.configuration.snapshotStore, false);
    assert.equal("jobs" in serial.configuration, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch analysis can atomically persist per-file content snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-batch-snapshot-"));
  try {
    const snapshotDirectory = path.join(root, "snapshots");
    await writeFile(path.join(root, "one.obu"), makeObu({ type: 2 }));
    const first = await analyzeBatchDirectory(root, {
      extensions: ["obu"],
      snapshotDirectory,
    });
    const second = await analyzeBatchDirectory(root, {
      extensions: ["obu"],
      snapshotDirectory,
    });
    assert.match(first.files[0].snapshotId, /^[0-9a-f]{64}$/);
    assert.equal(second.files[0].snapshotId, first.files[0].snapshotId);
    assert.equal(first.configuration.snapshotStore, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch per-file byte budget records a stable failure and continues", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-batch-limit-"));
  try {
    await writeFile(path.join(root, "small.obu"), makeObu({ type: 2 }));
    const report = await analyzeBatchDirectory(root, {
      extensions: ["obu"],
      maxFileBytes: 1,
    });
    assert.equal(report.files[0].status, "failed");
    assert.equal(report.files[0].byteLength, 2);
    assert.equal(report.files[0].sha256, null);
    assert.deepEqual(report.files[0].failure, {
      code: "BATCH_FILE_SIZE_LIMIT",
      message: "Input could not be read or analyzed",
    });
    assert.equal(report.summary.failedFileCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
