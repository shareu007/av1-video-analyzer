import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateBlockGoldenManifest } from "../src/block-golden.js";
import { validateLibaomBuildManifest } from "../src/libaom-provenance.js";
import {
  encodeNativeInspectionRequest,
  inspectReportFramesInNativeWorker,
} from "../src/native-inspection-worker.js";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseManifestPath = process.env.AV1SCOPE_LIBAOM_BUILD_MANIFEST;
if (!releaseManifestPath) {
  if (process.env.AV1SCOPE_REQUIRE_LIBAOM_PRODUCER === "1") {
    assert.fail("libaom crash replay gate requires AV1SCOPE_LIBAOM_BUILD_MANIFEST");
  }
  process.stdout.write("libaom crash replay blocked: release manifest not configured\n");
  process.exit(0);
}

const resolvedReleaseManifest = path.resolve(releaseManifestPath);
const release = validateLibaomBuildManifest(
  JSON.parse(await readFile(resolvedReleaseManifest, "utf8")),
).manifest;
const releaseRoot = path.dirname(resolvedReleaseManifest);
const executable = path.resolve(releaseRoot, release.artifacts.inspectionWorker.path);
assert.ok(
  executable.startsWith(`${releaseRoot}${path.sep}`),
  "inspection worker escapes the release bundle",
);
const crashHelper = path.resolve(
  process.env.AV1SCOPE_CRASH_INTAKE_HELPER
    ?? path.join(releaseRoot, process.platform === "win32"
      ? "av1scope_crash_after_stdin.exe" : "av1scope_crash_after_stdin"),
);
assert.ok(
  crashHelper.startsWith(`${releaseRoot}${path.sep}`),
  "crash intake helper escapes the release bundle",
);
const goldenManifestPath = path.resolve(
  process.env.AV1SCOPE_LIBAOM_BLOCK_GOLDEN_MANIFEST
    ?? path.join(projectDirectory, "test/fixtures/libaom-v3.12.1/manifest.json"),
);
const goldenRoot = path.dirname(goldenManifestPath);
const golden = validateBlockGoldenManifest(
  JSON.parse(await readFile(goldenManifestPath, "utf8")),
);
const item = golden.cases[0];
assert.ok(item, "libaom crash replay requires at least one Golden case");
const inputPath = path.resolve(goldenRoot, item.inputFile);
assert.ok(inputPath.startsWith(`${goldenRoot}${path.sep}`), "Golden input escapes its suite root");
const encoded = (await readFile(inputPath, "ascii")).replaceAll(/\s/gu, "");
assert.match(
  encoded,
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
  "Golden input is not canonical base64",
);
const input = Buffer.from(encoded, "base64");
assert.equal(input.toString("base64"), encoded, "Golden input base64 padding mismatch");
assert.equal(createHash("sha256").update(input).digest("hex"), item.inputSha256);
const report = {
  container: { width: item.width, height: item.height },
  frames: item.frames,
};
const request = Buffer.concat(encodeNativeInspectionRequest(input, report.frames));
const expectedRequest = {
  bytes: request.length,
  sha256: createHash("sha256").update(request).digest("hex"),
};
const baseline = await inspectReportFramesInNativeWorker(input, report, { executable });
assert.equal(baseline.provenance.build, release.buildId, "baseline build mismatch");
assert.equal(baseline.provenance.workerRecovery, undefined);

const temporary = await mkdtemp(path.join(os.tmpdir(), "av1scope-libaom-crash-replay-"));
try {
  const marker = path.join(temporary, "first-request.bin");
  let attempts = 0;
  const replayed = await inspectReportFramesInNativeWorker(input, report, {
    executable,
    maximumCrashRetries: 1,
    spawnImpl: (name, args, options) => {
      attempts += 1;
      return attempts === 1
        ? spawn(crashHelper, [marker], options)
        : spawn(name, args, options);
    },
  });
  assert.equal(attempts, 2, "crash replay must use exactly one fresh process");
  const firstRequest = await readFile(marker);
  assert.deepEqual({
    bytes: firstRequest.length,
    sha256: createHash("sha256").update(firstRequest).digest("hex"),
  }, expectedRequest);
  assert.deepEqual(replayed.frames, baseline.frames, "replayed BlockRecords changed");
  assert.equal(replayed.provenance.producer, baseline.provenance.producer);
  assert.equal(replayed.provenance.build, baseline.provenance.build);
  assert.equal(replayed.provenance.featureFlags, 127);
  assert.equal(replayed.provenance.workerRecovery?.recovered, true);
  assert.equal(replayed.provenance.workerRecovery?.attempts, 2);
  assert.equal(
    replayed.provenance.workerRecovery?.firstCrash?.code,
    "NATIVE_INSPECTION_CRASHED",
  );
  assert.ok(
    replayed.provenance.workerRecovery.firstCrash.exitCode !== 0
      || replayed.provenance.workerRecovery.firstCrash.exitSignal !== null,
    "crash helper did not terminate abnormally",
  );
  assert.equal(replayed.provenance.workerRecovery.firstCrash.stderr, null);
  process.stdout.write(
    `libaom crash replay passed (${expectedRequest.bytes} request bytes; ${item.frames.length} frames; ${release.buildId})\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
