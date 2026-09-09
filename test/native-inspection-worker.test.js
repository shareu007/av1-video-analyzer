import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { analyzeGuiJsonInWorker } from "../src/gui-server.js";
import {
  createNativeInspectionResponseDecoder,
  decodeNativeInspectionResponse,
  describeNativeInspectionFeatures,
  encodeNativeInspectionRequest,
  inspectReportFramesInNativeWorker,
  NativeInspectionWorkerError,
} from "../src/native-inspection-worker.js";

const DEMO_IVF = Buffer.from(
  "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
  "base64",
);

function command(name, args, options = {}) {
  return spawnSync(name, args, { encoding: "utf8", ...options });
}

function compiler() {
  for (const name of [process.env.CC, "cc", "gcc", "clang"].filter(Boolean)) {
    if (command(name, ["--version"]).status === 0) return name;
  }
  return null;
}

function buildMockWorker(cc, directory) {
  const executable = path.join(directory, "inspection-worker");
  const build = command(cc, [
    "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
    "-I", "native/include",
    "native/inspection_worker.c", "native/test/mock_adapters.c",
    "native/worker_limits.c", "native/worker_sandbox.c",
    "-o", executable,
  ]);
  assert.equal(build.status, 0, build.stderr);
  return executable;
}

function buildLibaomBridgeWorker(cc, directory) {
  const executable = path.join(directory, "libaom-bridge-worker");
  const build = command(cc, [
    "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
    "-DAV1SCOPE_ADAPTER_BUILD=1",
    "-DAV1SCOPE_LIBAOM_BUILD_ID=\"test-patched-fork-build-0000000000000001\"",
    "-I", "native/include",
    "native/inspection_worker.c", "native/libaom_inspection_adapter.c",
    "native/test/libaom-patch-stub.c",
    "native/worker_limits.c", "native/worker_sandbox.c",
    "-o", executable,
  ]);
  assert.equal(build.status, 0, build.stderr);
  return executable;
}

function buildBuiltinLibaomInspectionWorker(cc, directory) {
  const executable = path.join(directory, "libaom-builtin-inspection-worker");
  const build = command(cc, [
    "-std=c11", "-pedantic", "-Wall", "-Wextra", "-Werror",
    "-DAV1SCOPE_ADAPTER_BUILD=1",
    "-DAV1SCOPE_LIBAOM_BUILD_ID=\"fixture-inspection-build-00000000001\"",
    "-I", "native/test/libaom-fixture",
    "-I", "native/include",
    "native/inspection_worker.c", "native/libaom_inspection_adapter.c",
    "native/libaom_builtin_inspection_patch.c",
    "native/test/libaom-fixture/libaom-fixture.c",
    "native/worker_limits.c", "native/worker_sandbox.c",
    "-o", executable,
  ]);
  assert.equal(build.status, 0, build.stderr);
  return executable;
}

function runRawWorker(executable, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
    child.stdin.end(request);
  });
}

test("native inspection feature flags expose complete and degraded producer capabilities", () => {
  assert.deepEqual(describeNativeInspectionFeatures(127), {
    featureFlags: 127,
    features: [
      "partition", "mode", "motion-vector", "transform", "coefficient", "qindex", "filter",
    ],
    missingFeatures: [],
    featureComplete: true,
  });
  assert.deepEqual(describeNativeInspectionFeatures(110), {
    featureFlags: 110,
    features: ["mode", "motion-vector", "transform", "qindex", "filter"],
    missingFeatures: ["partition", "coefficient"],
    featureComplete: false,
  });
  assert.throws(() => describeNativeInspectionFeatures(128), /featureFlags/u);
});

test("native inspection request codec validates frame payload ranges", () => {
  const report = analyzeBuffer(DEMO_IVF, { sourceName: "demo.ivf" });
  const request = encodeNativeInspectionRequest(DEMO_IVF, report.frames, {
    maximumBlocks: 10,
  });
  assert.equal(request[0].length, 56);
  assert.equal(request[0].subarray(0, 8).toString("latin1"), "A1INX02\0");
  assert.equal(request[0].readUInt32LE(8), 2);
  assert.equal(request[1].length, 24);
  assert.equal(request[2], DEMO_IVF);
  assert.equal(request[0].readBigUInt64LE(24), 1n);
  assert.equal(request[1].readBigUInt64LE(0), 0n);
  assert.equal(request[1].readBigUInt64LE(8), BigInt(report.frames[0].payloadRange.start));

  assert.throws(() => encodeNativeInspectionRequest(DEMO_IVF, []), /requires 1/u);
  assert.throws(() => encodeNativeInspectionRequest(DEMO_IVF, [{
    frameId: 1,
    payloadRange: { start: 0, length: 1 },
  }]), /contiguous/u);
  assert.throws(() => encodeNativeInspectionRequest(DEMO_IVF, [{
    frameId: 0,
    payloadRange: { start: DEMO_IVF.length, length: 1 },
  }]), /outside the input/u);
});

test("native inspection mock worker completes the isolated BlockRecord pipeline", async (context) => {
  const cc = compiler();
  if (cc === null) {
    context.skip("C11 compiler unavailable");
    return;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-inspection-worker-"));
  try {
    const executable = buildMockWorker(cc, temporary);
    const report = analyzeBuffer(DEMO_IVF, { sourceName: "demo.ivf" });
    const overlay = await inspectReportFramesInNativeWorker(DEMO_IVF, report, {
      executable,
      maximumBlocks: 10,
      spawnImpl: (name, args, options) => spawn(name, args, options),
    });
    assert.equal(overlay.schemaVersion, 1);
    assert.equal(overlay.provenance.producer, "av1scope-test-mock");
    assert.equal(overlay.provenance.build, "not-a-production-adapter");
    assert.match(overlay.provenance.workerExecutable.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(overlay.frames.length, 1);
    assert.deepEqual(overlay.frames[0].blocks[0], {
      blockId: 0,
      plane: 0,
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      partition: "none",
      segmentId: 0,
      skip: false,
      mode: "intra",
      intraMode: null,
      interMode: null,
      refs: [],
      qindex: 92,
      mv: [],
      txSize: null,
      txType: null,
      coeffNonZero: null,
      filter: null,
      miRow: 0,
      miColumn: 0,
      compoundType: null,
      quantDelta: 2,
    });

    const guiResult = await analyzeGuiJsonInWorker(DEMO_IVF, "demo.ivf", {
      nativeInspectionWorkerExecutable: executable,
      snapshotDirectory: path.join(temporary, "snapshots"),
      returnDetails: true,
      timeoutMs: 5_000,
    });
    const guiReport = JSON.parse(guiResult.json);
    assert.equal(guiReport.blockOverlay.provenance.producer, "av1scope-test-mock");
    assert.equal(guiReport.blockOverlay.frames[0].blocks[0].qindex, 92);
    assert.equal(guiReport.blockOverlay.frames[0].blocks[0].miRow, 0);
    assert.equal(guiReport.blockOverlay.frames[0].blocks[0].quantDelta, 2);
    assert.match(guiResult.snapshot.snapshotId, /^[0-9a-f]{64}$/u);
    assert.match(guiResult.snapshot.blockOverlaySnapshotId, /^[0-9a-f]{64}$/u);

    const request = Buffer.concat(encodeNativeInspectionRequest(DEMO_IVF, report.frames, {
      maximumBlocks: 10,
    }));
    const raw = await runRawWorker(executable, request);
    assert.equal(raw.status, 0, raw.stderr?.toString());
    const expected = decodeNativeInspectionResponse(raw.stdout, { frameCount: 1, maximumBlocks: 10 });
    const oldVersion = Buffer.from(raw.stdout);
    oldVersion.writeUInt32LE(1, 8);
    assert.throws(
      () => decodeNativeInspectionResponse(oldVersion, { frameCount: 1, maximumBlocks: 10 }),
      /IPC framing/u,
    );
    const unknownDetail = Buffer.from(raw.stdout);
    const firstBlockRecord = 16 + 112;
    unknownDetail.writeUInt32LE(8, firstBlockRecord + 96);
    assert.throws(
      () => decodeNativeInspectionResponse(unknownDetail, { frameCount: 1, maximumBlocks: 10 }),
      /invalid BlockRecord/u,
    );
    for (let chunkBytes = 1; chunkBytes <= raw.stdout.length + 1; chunkBytes += 1) {
      const decoder = createNativeInspectionResponseDecoder({ frameCount: 1, maximumBlocks: 10 });
      for (let offset = 0; offset < raw.stdout.length; offset += chunkBytes) {
        decoder.push(raw.stdout.subarray(offset, offset + chunkBytes));
      }
      assert.deepEqual(decoder.finish(), expected, `chunk size ${chunkBytes}`);
    }

    const invalid = Buffer.from(request);
    invalid.writeUInt32LE(1, 44);
    const rejected = await runRawWorker(executable, invalid);
    assert.equal(rejected.status, 0, rejected.stderr?.toString());
    assert.throws(
      () => decodeNativeInspectionResponse(rejected.stdout, { frameCount: 1, maximumBlocks: 10 }),
      (error) => error instanceof NativeInspectionWorkerError && error.status === 3,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("native inspection parent classifies pre-cancellation", async () => {
  const report = analyzeBuffer(DEMO_IVF, { sourceName: "demo.ivf" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    inspectReportFramesInNativeWorker(DEMO_IVF, report, {
      executable: process.execPath,
      signal: controller.signal,
    }),
    (error) => error.code === "NATIVE_INSPECTION_CANCELLED",
  );
});

test("instrumented libaom bridge preserves real-producer event semantics through IPC", async (context) => {
  const cc = compiler();
  if (cc === null) {
    context.skip("C11 compiler unavailable");
    return;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-libaom-bridge-worker-"));
  try {
    const executable = buildLibaomBridgeWorker(cc, temporary);
    const report = analyzeBuffer(DEMO_IVF, { sourceName: "demo.ivf" });
    const overlay = await inspectReportFramesInNativeWorker(DEMO_IVF, report, {
      executable,
      maximumBlocks: 10,
      maximumBlocksPerChunk: 2,
    });
    assert.equal(overlay.provenance.producer, "libaom-inspect-v1");
    assert.equal(overlay.provenance.build, "test-patched-fork-build-0000000000000001");
    assert.equal(overlay.provenance.featureFlags, 127);
    assert.equal(overlay.provenance.featureComplete, true);
    assert.deepEqual(overlay.provenance.missingFeatures, []);
    assert.equal(overlay.frames[0].blocks.length, 3);
    assert.deepEqual(overlay.frames[0].blocks.map(({ blockId }) => blockId), [0, 1, 2]);
    assert.equal(overlay.frames[0].blocks[2].mode, "inter");
    assert.equal(overlay.frames[0].blocks[2].qindex, 255);
    assert.deepEqual(overlay.frames[0].blocks[2].refs, [0]);
    assert.deepEqual(overlay.frames[0].blocks[2].mv, [{
      x: 4,
      y: -2,
      precision: "1/8 pel",
    }]);
    assert.equal(overlay.frames[0].blocks[2].miColumn, 2);
    assert.equal(overlay.frames[0].blocks[2].compoundType, "COMPOUND_4");
    assert.equal(overlay.frames[0].blocks[2].quantDelta, 163);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("built-in CONFIG_INSPECTION producer maps upstream MI data through Worker IPC", async (context) => {
  const cc = compiler();
  if (cc === null) {
    context.skip("C11 compiler unavailable");
    return;
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-libaom-builtin-worker-"));
  try {
    const executable = buildBuiltinLibaomInspectionWorker(cc, temporary);
    const report = analyzeBuffer(DEMO_IVF, { sourceName: "demo.ivf" });
    const overlay = await inspectReportFramesInNativeWorker(DEMO_IVF, report, {
      executable,
      maximumBlocks: 10,
      maximumBlocksPerChunk: 2,
    });
    assert.equal(overlay.provenance.producer, "libaom-inspect-v1");
    assert.equal(overlay.provenance.build, "fixture-inspection-build-00000000001");
    assert.equal(overlay.provenance.featureFlags, 127);
    assert.equal(overlay.provenance.featureComplete, true);
    assert.deepEqual(overlay.provenance.missingFeatures, []);
    assert.equal(overlay.frames[0].blocks.length, 3);
    assert.deepEqual(overlay.frames[0].blocks.map(({ blockId }) => blockId), [0, 1, 2]);
    assert.deepEqual(overlay.frames[0].blocks[1], {
      blockId: 1,
      plane: 0,
      x: 8,
      y: 0,
      width: 8,
      height: 4,
      partition: "horz",
      segmentId: 2,
      skip: false,
      mode: "inter",
      intraMode: null,
      interMode: "INTER_14",
      refs: [1, 7],
      qindex: 255,
      mv: [
        { x: 4, y: -2, precision: "1/8 pel" },
        { x: -8, y: 6, precision: "1/8 pel" },
      ],
      txSize: "TX_SIZE_2",
      txType: "TX_TYPE_1",
      coeffNonZero: 2,
      filter: "FILTER_262945",
      miRow: 0,
      miColumn: 2,
      compoundType: "COMPOUND_5",
      quantDelta: 165,
    });

    const temporalUnit = Buffer.from([0x66, 0x67, 0x68]);
    const temporalOverlay = await inspectReportFramesInNativeWorker(temporalUnit, {
      container: { width: 16, height: 8 },
      frames: [{ frameId: 0, payloadRange: { start: 0, length: temporalUnit.length } }],
    }, { executable, maximumBlocks: 10 });
    assert.equal(temporalOverlay.frames.length, 1);
    assert.equal(temporalOverlay.frames[0].blocks.length, 3);
    assert.equal(temporalOverlay.provenance.featureFlags, 127);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
