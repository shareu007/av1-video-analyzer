import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  assertBlockGoldenCoverage,
  validateBlockGoldenManifest,
} from "../src/block-golden.js";
import { validateBlockOverlayDocument } from "../src/block-overlay.js";
import { inspectReportFramesInNativeWorker } from "../src/native-inspection-worker.js";
import { validateLibaomBuildManifest } from "../src/libaom-provenance.js";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseManifestPath = process.env.AV1SCOPE_LIBAOM_BUILD_MANIFEST;
let manifestPath = process.env.AV1SCOPE_LIBAOM_BLOCK_GOLDEN_MANIFEST;
let executable = process.env.AV1SCOPE_NATIVE_INSPECTION_WORKER;
let releaseBuildId = null;
if (releaseManifestPath) {
  const resolvedReleaseManifest = path.resolve(releaseManifestPath);
  const release = validateLibaomBuildManifest(
    JSON.parse(await readFile(resolvedReleaseManifest, "utf8")),
  ).manifest;
  releaseBuildId = release.buildId;
  executable ??= path.resolve(
    path.dirname(resolvedReleaseManifest), release.artifacts.inspectionWorker.path,
  );
  manifestPath ??= path.join(projectDirectory, "test/fixtures/libaom-v3.12.1/manifest.json");
}
if (!manifestPath || !executable) {
  if (process.env.AV1SCOPE_REQUIRE_LIBAOM_PRODUCER === "1") {
    assert.fail(
      "Block Golden release gate requires AV1SCOPE_LIBAOM_BLOCK_GOLDEN_MANIFEST and AV1SCOPE_NATIVE_INSPECTION_WORKER",
    );
  }
  process.stdout.write("libaom Block Golden blocked: manifest/inspection worker not configured\n");
  process.exit(0);
}

const resolvedManifest = path.resolve(manifestPath);
const root = path.dirname(resolvedManifest);
const manifest = validateBlockGoldenManifest(JSON.parse(await readFile(resolvedManifest, "utf8")));
const expectedBuildId = process.env.AV1SCOPE_LIBAOM_EXPECTED_BUILD_ID
  ?? releaseBuildId ?? manifest.buildId;
assert.match(expectedBuildId, /^[0-9a-f]{40}$/u, "expected libaom build ID is invalid");
const insideRoot = (relative) => {
  const target = path.resolve(root, relative);
  assert.ok(target.startsWith(`${root}${path.sep}`), `Golden path escapes suite root: ${relative}`);
  return target;
};
const sha256 = (input) => createHash("sha256").update(input).digest("hex");
const decodeBase64 = (input, label) => {
  const text = input.toString("ascii").replaceAll(/\s/gu, "");
  assert.match(text, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
    `${label} is not canonical base64`);
  const decoded = Buffer.from(text, "base64");
  assert.equal(decoded.toString("base64"), text, `${label} base64 padding mismatch`);
  return decoded;
};
const readGoldenInput = async (relative) => {
  const bytes = await readFile(insideRoot(relative));
  return relative.endsWith(".base64") ? decodeBase64(bytes, relative) : bytes;
};
const readGoldenOverlay = async (relative) => {
  const bytes = await readFile(insideRoot(relative));
  if (!relative.endsWith(".gz.base64")) return bytes;
  const compressed = decodeBase64(bytes, relative);
  return gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 });
};
const overlays = [];
for (const item of manifest.cases) {
  const input = await readGoldenInput(item.inputFile);
  assert.equal(sha256(input), item.inputSha256, `${item.name} input digest mismatch`);
  for (const frame of item.frames) {
    assert.ok(
      frame.payloadRange.start + frame.payloadRange.length <= input.length,
      `${item.name} frame payload exceeds input`,
    );
  }
  const report = {
    container: { width: item.width, height: item.height },
    frames: item.frames,
  };
  const expectedBytes = await readGoldenOverlay(item.expectedOverlayFile);
  assert.equal(
    sha256(expectedBytes), item.expectedOverlaySha256,
    `${item.name} expected overlay digest mismatch`,
  );
  const expected = validateBlockOverlayDocument(JSON.parse(expectedBytes), report);
  const actual = await inspectReportFramesInNativeWorker(input, report, {
    executable: path.resolve(executable),
  });
  assert.equal(actual.provenance.producer, "libaom-inspect-v1", `${item.name} producer mismatch`);
  assert.equal(actual.provenance.build, expectedBuildId, `${item.name} build mismatch`);
  assert.equal(actual.provenance.featureFlags, 127, `${item.name} feature flags mismatch`);
  assert.deepEqual(actual.frames, expected.frames, `${item.name} BlockRecord Golden mismatch`);
  overlays.push(actual);
}
const coverage = assertBlockGoldenCoverage(overlays);
process.stdout.write(
  `libaom Block Golden passed (${coverage.caseCount} cases; ${coverage.blockCount} blocks; ${expectedBuildId})\n`,
);
