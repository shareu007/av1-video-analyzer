import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultFfmpegBundleManifestCandidates,
  defaultNativeWorkerCandidates,
  discoverFfmpegBundle,
  discoverNativeWorker,
  resolveGuiNativeWorkers,
} from "../src/native-worker-discovery.js";

async function executable(target) {
  await writeFile(target, "#!/bin/sh\nexit 0\n");
  await chmod(target, 0o700);
  return target;
}

test("inspection discovery prefers pinned producers to the legacy development worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-inspection-priority-"));
  try {
    const candidates = defaultNativeWorkerCandidates("inspection", { projectDirectory: root });
    const pinned = candidates[0];
    const legacy = path.join(root, "build", "native", path.basename(pinned));
    assert.match(pinned, /native-v3\.12\.1-golden/);
    for (const target of [pinned, legacy]) {
      await mkdir(path.dirname(target), { recursive: true });
      await executable(target);
    }
    const found = await discoverNativeWorker("inspection", { environment: {}, candidatePaths: candidates });
    assert.equal(found.path, pinned);
    const explicit = await discoverNativeWorker("inspection", { explicitPath: legacy, environment: {}, candidatePaths: candidates });
    assert.equal(explicit.path, legacy);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native worker discovery uses argument, environment, then bundled priority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-worker-discovery-"));
  try {
    const argument = await executable(path.join(root, "argument"));
    const environment = await executable(path.join(root, "environment"));
    const bundled = await executable(path.join(root, "bundled"));
    const explicitResult = await discoverNativeWorker("demux", {
      explicitPath: argument,
      environment: { AV1SCOPE_NATIVE_DEMUX_WORKER: environment },
      candidatePaths: [bundled],
    });
    assert.equal(explicitResult.path, argument);
    assert.equal(explicitResult.source, "argument");

    const environmentResult = await discoverNativeWorker("demux", {
      environment: { AV1SCOPE_NATIVE_DEMUX_WORKER: environment },
      candidatePaths: [bundled],
    });
    assert.equal(environmentResult.path, environment);
    assert.equal(environmentResult.source, "environment");

    const bundledResult = await discoverNativeWorker("demux", {
      environment: {}, candidatePaths: [path.join(root, "missing"), bundled],
    });
    assert.equal(bundledResult.path, bundled);
    assert.equal(bundledResult.source, "bundled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native worker discovery preserves invalid explicit configuration for preflight", async () => {
  const missing = path.resolve("missing-explicit-worker");
  const result = await discoverNativeWorker("inspection", { explicitPath: missing });
  assert.equal(result.path, missing);
  assert.equal(result.source, "argument");
  assert.equal(result.available, false);
});

test("native worker discovery can be disabled and does not search PATH", async () => {
  const result = await discoverNativeWorker("demux", {
    disabled: true,
    environment: { PATH: "/untrusted", AV1SCOPE_NATIVE_DEMUX_WORKER: "/also-ignored" },
    candidatePaths: ["/ignored"],
  });
  assert.deepEqual(result, {
    kind: "demux", path: null, source: "disabled", configured: false,
    available: false, searched: [],
  });
});

test("GUI resolver discovers both workers independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-worker-resolver-"));
  try {
    const demux = await executable(path.join(root, "demux"));
    const inspection = await executable(path.join(root, "inspection"));
    const resolved = await resolveGuiNativeWorkers({}, {
      environment: {}, demuxCandidatePaths: [demux], inspectionCandidatePaths: [inspection],
      ffmpegBundleCandidatePaths: [],
    });
    assert.equal(resolved.nativeDemuxWorkerExecutable, demux);
    assert.equal(resolved.nativeInspectionWorkerExecutable, inspection);
    assert.equal(resolved.nativeWorkerDiscovery.demux.source, "bundled");
    assert.equal(resolved.nativeWorkerDiscovery.inspection.source, "bundled");
    assert.equal(resolved.nativeWorkersResolved, true);
    assert.equal(await resolveGuiNativeWorkers(resolved), resolved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FFmpeg bundle discovery verifies configured manifests before exposing artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-ffmpeg-discovery-"));
  try {
    const manifest = path.join(root, "ffmpeg-build-manifest.json");
    await writeFile(manifest, "{}\n");
    const artifacts = {
      ffmpeg: path.join(root, "bin", "ffmpeg"),
      ffprobe: path.join(root, "bin", "ffprobe"),
      demuxWorker: path.join(root, "bin", "worker"),
    };
    const found = await discoverFfmpegBundle({
      environment: { AV1SCOPE_FFMPEG_BUILD_MANIFEST: manifest },
      candidatePaths: [],
      verifyBundle: async ({ manifestPath }) => ({
        buildId: "1".repeat(40),
        sourceVersion: "7.1.5",
        legalReviewRequired: true,
        artifacts,
        manifestPath,
      }),
    });
    assert.equal(found.available, true);
    assert.equal(found.source, "environment");
    assert.deepEqual(found.artifacts, artifacts);

    const rejected = await discoverFfmpegBundle({
      explicitManifest: manifest,
      candidatePaths: [],
      verifyBundle: async () => { throw new Error("digest mismatch"); },
    });
    assert.equal(rejected.available, false);
    assert.match(rejected.error, /digest mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default candidates cover single- and multi-config CMake layouts", () => {
  const candidates = defaultNativeWorkerCandidates("demux", {
    projectDirectory: "/project", platform: "win32",
  });
  assert.deepEqual(candidates.slice(0, 2), [
    path.join("/project", "build", "native", "av1scope_ffmpeg_demux_worker.exe"),
    path.join("/project", "build", "native", "Release", "av1scope_ffmpeg_demux_worker.exe"),
  ]);
  assert.equal(
    defaultFfmpegBundleManifestCandidates({ projectDirectory: "/project" })[0],
    path.join(
      "/project", "build", "ffmpeg-v7.1.5-release", "ffmpeg-build-manifest.json",
    ),
  );
});
