import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseGuiArguments, runGuiCli } from "../src/gui-cli.js";
import { inspectGuiPreflight, preflightFailureMessage } from "../src/gui-preflight.js";

const availableTools = async (command) => ({
  available: true,
  version: `${command} test-version`,
});

test("GUI preflight reports a ready reference runtime", async () => {
  const report = await inspectGuiPreflight({ toolProbe: availableTools });
  assert.equal(report.schemaVersion, "gui-preflight-v1");
  assert.equal(report.ok, true);
  assert.equal(report.status, "ready");
  assert.equal(report.capabilities.structuralAnalysis, true);
  assert.equal(report.capabilities.containerAnalysis, true);
  assert.equal(report.capabilities.framePreview, true);
  assert.equal(report.capabilities.snapshotStore, false);
});

test("GUI preflight keeps structural analysis usable without optional FFmpeg tools", async () => {
  const report = await inspectGuiPreflight({
    toolProbe: async () => ({ available: false, errorCode: "ENOENT" }),
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, "degraded");
  assert.equal(report.capabilities.structuralAnalysis, true);
  assert.equal(report.capabilities.containerAnalysis, false);
  assert.equal(report.capabilities.framePreview, false);
  assert.equal(report.checks.find(({ id }) => id === "ffmpeg").status, "warning");
});

test("GUI preflight rejects missing required assets and configured paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-preflight-"));
  try {
    const invalidSnapshot = path.join(root, "snapshot-file");
    await writeFile(invalidSnapshot, "not a directory");
    const report = await inspectGuiPreflight({
      publicDirectory: path.join(root, "missing-public"),
      snapshotDirectory: invalidSnapshot,
      nativeDemuxWorkerExecutable: path.join(root, "missing-worker"),
      nativeInspectionWorkerExecutable: path.join(root, "missing-inspection-worker"),
      nodeVersion: "18.0.0",
      toolProbe: availableTools,
    });
    assert.equal(report.ok, false);
    assert.equal(report.status, "error");
    assert.match(preflightFailureMessage(report), /node-runtime/);
    assert.match(preflightFailureMessage(report), /public-assets/);
    assert.match(preflightFailureMessage(report), /snapshot-store/);
    assert.match(preflightFailureMessage(report), /native-demux-worker/);
    assert.match(preflightFailureMessage(report), /native-inspection-worker/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI preflight validates explicitly configured snapshot and native worker paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-preflight-config-"));
  try {
    const snapshotDirectory = path.join(root, "snapshots");
    const worker = path.join(root, "worker");
    await writeFile(worker, "#!/bin/sh\nexit 0\n");
    await chmod(worker, 0o700);
    const report = await inspectGuiPreflight({
      snapshotDirectory,
      nativeDemuxWorkerExecutable: worker,
      nativeInspectionWorkerExecutable: worker,
      toolProbe: async () => ({ available: false, errorCode: "ENOENT" }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.capabilities.snapshotStore, true);
    assert.equal(report.capabilities.nativeDemux, true);
    assert.equal(report.capabilities.deepBlockInspection, true);
    assert.equal(report.capabilities.containerAnalysis, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI preflight exposes a verified FFmpeg release bundle and rejects a broken one", async () => {
  const verified = await inspectGuiPreflight({
    ffmpegPath: "/bundle/bin/ffmpeg",
    ffprobePath: "/bundle/bin/ffprobe",
    ffmpegBundleDiscovery: {
      configured: true,
      available: true,
      source: "bundled",
      path: "/bundle/ffmpeg-build-manifest.json",
      verification: {
        sourceVersion: "7.1.5",
        buildId: "1".repeat(40),
        legalReviewRequired: true,
      },
    },
    toolProbe: availableTools,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.dependencies.ffmpeg.path, "/bundle/bin/ffmpeg");
  assert.equal(verified.dependencies.ffmpegReleaseBundle.available, true);
  assert.equal(verified.dependencies.ffmpegReleaseBundle.buildId, "1".repeat(40));

  const broken = await inspectGuiPreflight({
    ffmpegBundleDiscovery: {
      configured: true,
      available: false,
      source: "argument",
      path: "/bundle/ffmpeg-build-manifest.json",
      error: "bundle digest mismatch",
    },
    toolProbe: availableTools,
  });
  assert.equal(broken.ok, false);
  assert.match(preflightFailureMessage(broken), /ffmpeg-release-bundle/);
});

test("av1scope-gui --check emits JSON without opening a listener", async () => {
  let output = "";
  let startCalls = 0;
  const expected = { service: "av1scope-gui", ok: true, status: "degraded" };
  const result = await runGuiCli(["--check"], {
    stdout: { write: (chunk) => { output += chunk; } },
    inspectPreflight: async () => expected,
    startServer: async () => {
      startCalls += 1;
      throw new Error("listener must not start");
    },
  });
  assert.equal(result.status, 0);
  assert.equal(startCalls, 0);
  assert.deepEqual(JSON.parse(output), expected);
});

test("av1scope-gui parses safe startup options and rejects invalid ports", () => {
  assert.deepEqual(parseGuiArguments([
    "--host", "localhost", "--port", "0", "--snapshot-dir", "snapshots", "--check",
  ]), {
    host: "localhost",
    port: 0,
    snapshotDirectory: "snapshots",
    nativeDemuxWorkerExecutable: null,
    nativeInspectionWorkerExecutable: null,
    nativeWorkerAutodiscovery: true,
    ffmpegBuildManifest: null,
    ffmpegBundleAutodiscovery: true,
    checkOnly: true,
    help: false,
  });
  assert.throws(() => parseGuiArguments(["--port", "65536"]), /invalid port/);
  assert.throws(() => parseGuiArguments(["--unknown"]), /unknown option/);
  assert.equal(parseGuiArguments([]).snapshotDirectory, ".av1scope-cache");
  assert.equal(parseGuiArguments(["--no-snapshot"]).snapshotDirectory, null);
  assert.equal(parseGuiArguments(["--no-native-workers"]).nativeWorkerAutodiscovery, false);
  assert.equal(parseGuiArguments(["--no-ffmpeg-bundle"]).ffmpegBundleAutodiscovery, false);
  assert.equal(
    parseGuiArguments(["--ffmpeg-bundle-manifest", "/bundle/manifest.json"])
      .ffmpegBuildManifest,
    "/bundle/manifest.json",
  );
  assert.throws(
    () => parseGuiArguments([
      "--no-native-workers", "--native-demux-worker", "/worker",
    ]),
    /conflicts/,
  );
  assert.throws(
    () => parseGuiArguments([
      "--no-ffmpeg-bundle", "--ffmpeg-bundle-manifest", "/bundle/manifest.json",
    ]),
    /conflicts/,
  );
});

test("av1scope-gui resolves native workers before preflight", async () => {
  let inspected = null;
  const result = await runGuiCli(["--check"], {
    stdout: { write() {} },
    resolveNativeWorkers: async (options) => ({
      ...options,
      nativeDemuxWorkerExecutable: "/trusted/demux",
      nativeInspectionWorkerExecutable: "/trusted/inspection",
      nativeWorkersResolved: true,
    }),
    inspectPreflight: async (options) => {
      inspected = options;
      return { ok: true };
    },
  });
  assert.equal(result.status, 0);
  assert.equal(inspected.nativeDemuxWorkerExecutable, "/trusted/demux");
  assert.equal(inspected.nativeInspectionWorkerExecutable, "/trusted/inspection");
});
