import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { analyzeBuffer } from "../src/analyzer.js";
import { writeDerivedSyntaxSnapshot } from "../src/derived-syntax-store.js";
import { inspectSnapshotObuPayload } from "../src/snapshot-inspector.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";
import { makeObu } from "./fixtures.js";

const SINGLE_FRAME_IVF = Buffer.from(
  "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
  "base64",
);

function sink() {
  let value = "";
  return {
    stream: { write: (chunk) => (value += chunk) },
    value: () => value,
  };
}

test("CLI writes a report and refuses an implicit overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-"));
  try {
    const inputPath = path.join(directory, "input.obu");
    const outputPath = path.join(directory, "report.json");
    await writeFile(inputPath, makeObu({ type: 2 }));

    assert.equal(
      await runCli(["analyze", inputPath, "--output", outputPath]),
      0,
    );
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.summary.obuCount, 1);

    await assert.rejects(
      runCli(["analyze", inputPath, "--output", outputPath]),
      /already exists/,
    );
    assert.equal(
      await runCli([
        "analyze",
        inputPath,
        "--output",
        outputPath,
        "--force",
      ]),
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI strict mode returns 2 for structural errors", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-"));
  try {
    const inputPath = path.join(directory, "broken.obu");
    await writeFile(inputPath, Buffer.from([0b00001010, 0x80]));
    const stdout = sink();
    const stderr = sink();
    const status = await runCli(["analyze", inputPath, "--strict"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(status, 2);
    assert.match(stdout.value(), /LEB128_TRUNCATED/);
    assert.match(stderr.value(), /1 error\/fatal/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI exposes the OBU record budget and strict mode treats exhaustion as incomplete", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-"));
  try {
    const inputPath = path.join(directory, "dense.obu");
    await writeFile(inputPath, Buffer.concat(Array(5).fill(makeObu({ type: 2 }))));
    const stdout = sink();
    const stderr = sink();
    const status = await runCli(["analyze", inputPath, "--max-obus", "3", "--strict"], {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    const report = JSON.parse(stdout.value());

    assert.equal(status, 2);
    assert.equal(report.summary.obuCount, 3);
    assert.equal(report.summary.complete, false);
    assert.equal(report.diagnostics[0].code, "OBU_RECORD_LIMIT_REACHED");
    assert.match(stderr.value(), /1 error\/fatal/);
    await assert.rejects(runCli(["analyze", inputPath, "--max-obus", "0"]), /positive safe integer/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI help and version do not require an input", async () => {
  const help = sink();
  const version = sink();
  assert.equal(await runCli(["--help"], { stdout: help.stream }), 0);
  assert.equal(await runCli(["--version"], { stdout: version.stream }), 0);
  assert.match(help.value(), /Usage:/);
  assert.match(help.value(), /--max-obus/);
  assert.match(help.value(), /--max-syntax-nodes/);
  assert.match(help.value(), /--max-frames/);
  assert.match(help.value(), /--snapshot-dir/);
  assert.match(help.value(), /gc-cache/);
  assert.match(help.value(), /query <snapshot-id>/);
  assert.match(help.value(), /batch <directory>/);
  assert.match(help.value(), /rehearse-recovery/);
  assert.match(help.value(), /--max-files/);
  assert.match(help.value(), /--projection/);
  assert.match(help.value(), /--apply/);
  assert.match(version.value(), /^0\.1\.0\n$/);
});

test("CLI runs a cache recovery rehearsal without mutating the source store", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-recovery-"));
  try {
    const snapshotRoot = path.join(directory, "snapshots");
    const report = analyzeBuffer(makeObu({ type: 2 }), { sourceName: "recovery.obu" });
    const parent = await writeReportSnapshot(report, snapshotRoot);
    const stdout = sink();
    const stderr = sink();
    assert.equal(await runCli([
      "rehearse-recovery", parent.snapshotId, "--snapshot-dir", snapshotRoot,
    ], { stdout: stdout.stream, stderr: stderr.stream }), 0);
    const result = JSON.parse(stdout.value());
    assert.equal(result.parentSnapshotId, parent.snapshotId);
    assert.ok(Object.values(result.phases).every(Boolean));
    assert.match(stderr.value(), /isolated clone; source store unchanged/);
    await access(path.join(snapshotRoot, parent.snapshotId, "manifest.json"));
    await assert.rejects(runCli([
      "rehearse-recovery", "bad", "--snapshot-dir", snapshotRoot,
    ]), /64-character parent snapshot ID/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI batch emits deterministic JSON/CSV and strict status without stopping at diagnostics", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-batch-"));
  try {
    const nested = path.join(directory, "nested");
    await mkdir(nested);
    await writeFile(path.join(directory, "good.obu"), makeObu({ type: 2 }));
    await writeFile(path.join(nested, "bad.obu"), Buffer.from([0x0a, 0x80]));
    await writeFile(path.join(directory, "ignored.txt"), "not media");

    const stdout = sink();
    const stderr = sink();
    const status = await runCli([
      "batch", directory, "--recursive", "--extensions", "obu", "--jobs", "2", "--strict",
    ], { stdout: stdout.stream, stderr: stderr.stream });
    const report = JSON.parse(stdout.value());
    assert.equal(status, 2);
    assert.deepEqual(report.files.map(({ relativePath }) => relativePath), ["good.obu", "nested/bad.obu"]);
    assert.equal(report.summary.totalErrors, 1);
    assert.match(stderr.value(), /2 files: 1 ok, 1 with diagnostics, 0 failed/);

    const csv = sink();
    assert.equal(await runCli([
      "batch", directory, "--recursive", "--extensions", ".obu", "--csv",
    ], { stdout: csv.stream, stderr: sink().stream }), 0);
    assert.match(csv.value(), /^relative_path,sha256,byte_length,status,format,/);
    assert.match(csv.value(), /nested\/bad\.obu/);
    const limitedError = sink();
    assert.equal(await runCli([
      "batch", directory, "--extensions", "obu", "--max-file-bytes", "1",
    ], { stdout: sink().stream, stderr: limitedError.stream }), 1);
    assert.match(limitedError.value(), /good\.obu: BATCH_FILE_SIZE_LIMIT/);
    assert.doesNotMatch(limitedError.value(), new RegExp(directory.replaceAll("/", "\\/")));
    await assert.rejects(runCli(["batch", directory, "--jobs", "0"]), /between 1 and/);
    await assert.rejects(runCli(["analyze", path.join(directory, "good.obu"), "--recursive"]), /only by batch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI queries immutable snapshot pages and exports projected CSV", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-query-"));
  try {
    const snapshotRoot = path.join(directory, "snapshots");
    const report = analyzeBuffer(Buffer.concat([
      makeObu({ type: 15, payload: Buffer.from([0xaa]) }),
      makeObu({ type: 5, payload: Buffer.from([0x01, 0x01, 0x01]) }),
      makeObu({ type: 15, payload: Buffer.from([0xbb]) }),
    ]));
    const snapshot = await writeReportSnapshot(report, snapshotRoot, { chunkSize: 1 });
    const stdout = sink();
    const stderr = sink();
    assert.equal(await runCli([
      "query", snapshot.snapshotId,
      "--snapshot-dir", snapshotRoot,
      "--collection", "obus",
      "--filter", JSON.stringify({ path: "type.code", op: "eq", value: 15 }),
      "--projection", "obuId,type.name",
      "--limit", "1",
    ], { stdout: stdout.stream, stderr: stderr.stream }), 0);
    const first = JSON.parse(stdout.value());
    assert.equal(first.records[0].record["type.name"], "padding");
    assert.match(first.nextPageToken, /^[A-Za-z0-9_-]+$/);
    assert.match(stderr.value(), /more pages available/);

    const csv = sink();
    assert.equal(await runCli([
      "query", snapshot.snapshotId,
      "--snapshot-dir", snapshotRoot,
      "--collection", "obus",
      "--filter", JSON.stringify({ path: "type.code", op: "eq", value: 15 }),
      "--projection", "obuId,type.name",
      "--page-token", first.nextPageToken,
      "--csv",
    ], { stdout: csv.stream, stderr: sink().stream }), 0);
    assert.equal(csv.value(), "source_offset,obuId,type.name\n2,2,padding\n");
    await assert.rejects(runCli([
      "query", snapshot.snapshotId, "--snapshot-dir", snapshotRoot,
      "--collection", "obus", "--csv",
    ]), /requires --projection/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI cache GC previews by default and requires explicit apply", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-gc-"));
  try {
    const snapshotRoot = path.join(directory, "snapshots");
    const pending = path.join(
      snapshotRoot, ".pending.1.44444444-4444-4444-8444-444444444444.tmp",
    );
    await mkdir(pending, { recursive: true });
    const preview = sink();
    assert.equal(await runCli([
      "gc-cache", "--snapshot-dir", snapshotRoot, "--minimum-age-ms", "0",
    ], { stdout: preview.stream, stderr: sink().stream }), 0);
    const plan = JSON.parse(preview.value());
    assert.equal(plan.mode, "dry-run");
    assert.equal(plan.summary.candidateCount, 1);
    assert.doesNotReject(() => access(pending));

    const appliedOutput = sink();
    const appliedError = sink();
    assert.equal(await runCli([
      "gc-cache", "--snapshot-dir", snapshotRoot, "--minimum-age-ms", "0", "--apply",
    ], { stdout: appliedOutput.stream, stderr: appliedError.stream }), 0);
    assert.equal(JSON.parse(appliedOutput.value()).removedCount, 1);
    await assert.rejects(access(pending), /ENOENT/);
    assert.match(appliedError.value(), /content snapshots retained/);
    await assert.rejects(
      runCli(["analyze", path.join(directory, "missing.obu"), "--apply"]),
      /supported only by gc-cache/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI commits a content-addressed analysis snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-"));
  try {
    const inputPath = path.join(directory, "input.obu");
    const snapshotRoot = path.join(directory, "snapshots");
    await writeFile(inputPath, makeObu({ type: 2 }));
    const stdout = sink();
    const stderr = sink();

    assert.equal(await runCli([
      "analyze", inputPath, "--snapshot-dir", snapshotRoot,
    ], { stdout: stdout.stream, stderr: stderr.stream }), 0);
    const snapshotIds = (await readdir(snapshotRoot)).filter((name) => /^[0-9a-f]{64}$/.test(name));
    assert.equal(snapshotIds.length, 1);
    const manifest = JSON.parse(await readFile(
      path.join(snapshotRoot, snapshotIds[0], "manifest.json"), "utf8",
    ));
    assert.equal(manifest.snapshotId, snapshotIds[0]);
    assert.equal(manifest.collections.obus.count, 1);
    assert.match(stderr.value(), new RegExp(`snapshot ${snapshotIds[0]} created`));
    assert.equal(JSON.parse(stdout.value()).summary.obuCount, 1);

    const repeated = sink();
    await runCli(["analyze", inputPath, "--snapshot-dir", snapshotRoot], {
      stdout: sink().stream,
      stderr: repeated.stream,
    });
    assert.match(repeated.value(), /reused/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI streams a raw OBU file directly into a snapshot index", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-"));
  try {
    const inputPath = path.join(directory, "dense.obu");
    const snapshotRoot = path.join(directory, "stream-index");
    await writeFile(inputPath, Buffer.concat(Array(2_500).fill(makeObu({ type: 2 }))));
    const stdout = sink();
    const stderr = sink();

    assert.equal(await runCli([
      "index", inputPath, "--snapshot-dir", snapshotRoot, "--max-obus", "3000",
    ], { stdout: stdout.stream, stderr: stderr.stream }), 0);
    const result = JSON.parse(stdout.value());
    assert.equal(result.kind, "av1scope-streaming-index");
    assert.equal(result.summary.obuCount, 2_500);
    assert.equal(result.collections.obus, 2_500);
    assert.equal(result.collections.syntaxNodes, 0);
    assert.match(stderr.value(), /snapshot [0-9a-f]{64} created/);
    await assert.rejects(runCli(["index", inputPath]), /requires --snapshot-dir/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI replays and exports a verified derived syntax snapshot", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-derived-"));
  try {
    const snapshotRoot = path.join(directory, "snapshots");
    const outputPath = path.join(directory, "derived.json");
    const input = makeObu({ type: 1, payload: Buffer.from("180cffda0080", "hex") });
    const report = analyzeBuffer(input);
    const parent = await writeReportSnapshot(report, snapshotRoot);
    const record = report.obus[0];
    const payload = input.subarray(record.payloadRange.start,
      record.payloadRange.start + record.payloadRange.length);
    const derived = await writeDerivedSyntaxSnapshot(snapshotRoot, {
      parentSnapshotId: parent.snapshotId,
      obuId: 0,
      payload,
      inspection: inspectSnapshotObuPayload(record, payload),
    });
    const stdout = sink();
    const stderr = sink();

    assert.equal(await runCli([
      "replay-derived", derived.derivedSnapshotId,
      "--snapshot-dir", snapshotRoot,
    ], { stdout: stdout.stream, stderr: stderr.stream }), 0);
    const replay = JSON.parse(stdout.value());
    assert.equal(replay.derivedSnapshotId, derived.derivedSnapshotId);
    assert.equal(replay.parentSnapshotId, parent.snapshotId);
    assert.match(stderr.value(), /verified against parent/);
    assert.equal(await runCli([
      "replay-derived", derived.derivedSnapshotId,
      "--snapshot-dir", snapshotRoot,
      "--output", outputPath,
    ]), 0);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).derivedSnapshotId,
      derived.derivedSnapshotId);
    await assert.rejects(
      runCli(["replay-derived", "bad", "--snapshot-dir", snapshotRoot]),
      /64-character lowercase SHA-256/,
    );

    const overlayOut = sink();
    assert.equal(await runCli([
      "merge-derived", parent.snapshotId, derived.derivedSnapshotId,
      "--snapshot-dir", snapshotRoot,
    ], { stdout: overlayOut.stream, stderr: sink().stream }), 0);
    const overlay = JSON.parse(overlayOut.value());
    assert.equal(overlay.parentSnapshotId, parent.snapshotId);
    assert.deepEqual(overlay.derivedSnapshotIds, [derived.derivedSnapshotId]);
    const replayOverlayOut = sink();
    assert.equal(await runCli([
      "replay-overlay", overlay.overlaySnapshotId,
      "--snapshot-dir", snapshotRoot,
    ], { stdout: replayOverlayOut.stream, stderr: sink().stream }), 0);
    assert.deepEqual(JSON.parse(replayOverlayOut.value()).syntaxNodes, overlay.syntaxNodes);
    await assert.rejects(
      runCli(["merge-derived", parent.snapshotId, "bad", "--snapshot-dir", snapshotRoot]),
      /one or more 64-character derived syntax IDs/,
    );
    const indexOut = sink();
    assert.equal(await runCli([
      "rebuild-derived-index", parent.snapshotId,
      "--snapshot-dir", snapshotRoot,
    ], { stdout: indexOut.stream, stderr: sink().stream }), 0);
    const index = JSON.parse(indexOut.value());
    assert.equal(index.parentSnapshotId, parent.snapshotId);
    assert.equal(index.entries.length, 1);
    assert.equal(index.entries[0].derivedSnapshotId, derived.derivedSnapshotId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI compares aligned AV1 streams as JSON and CSV", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "av1scope-cli-"));
  try {
    const reference = path.join(directory, "reference.ivf");
    const candidate = path.join(directory, "candidate.ivf");
    await writeFile(reference, SINGLE_FRAME_IVF);
    await writeFile(candidate, SINGLE_FRAME_IVF);
    const json = sink();
    assert.equal(await runCli(["compare", reference, candidate], { stdout: json.stream }), 0);
    const report = JSON.parse(json.value());
    assert.equal(report.kind, "av1scope-frame-comparison");
    assert.equal(report.summary.frameCount, 1);
    assert.equal(report.frames[0].identical, true);

    const csv = sink();
    assert.equal(await runCli(["compare", reference, candidate, "--csv"], { stdout: csv.stream }), 0);
    assert.match(csv.value(), /^frame_index,pixel_count/);
    assert.match(csv.value(), /0,256,true/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
