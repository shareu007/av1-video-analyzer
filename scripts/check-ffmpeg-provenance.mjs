import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyFfmpegBundle } from "../src/ffmpeg-bundle-verifier.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function command(name, args) {
  return spawnSync(name, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

function words(value) {
  return value.trim().split(/\s+/u).filter(Boolean);
}

function extractConfigureFlags(buildConfiguration) {
  const start = buildConfiguration.indexOf("configuration:");
  assert.notEqual(start, -1, "ffmpeg did not expose build configuration");
  return words(buildConfiguration.slice(start + "configuration:".length))
    .filter((value) => value.startsWith("--"));
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function resolveLibraryFile(fileStem, libdir) {
  const candidate = path.join(libdir, `${fileStem}.so`);
  try {
    return await realpath(candidate);
  } catch {
    return null;
  }
}

const releaseRequired = process.env.AV1SCOPE_REQUIRE_DISTRIBUTION_ELIGIBLE === "1";
const defaultManifest = path.join(
  PROJECT_ROOT, "build", "ffmpeg-v7.1.5-release", "ffmpeg-build-manifest.json",
);
let releaseManifest = process.env.AV1SCOPE_FFMPEG_BUILD_MANIFEST ?? null;
if (releaseManifest === null && releaseRequired && await exists(defaultManifest)) {
  releaseManifest = defaultManifest;
}
if (releaseManifest !== null) {
  const verification = await verifyFfmpegBundle({
    manifestPath: path.resolve(releaseManifest),
    fixturePath: path.join(
      PROJECT_ROOT,
      "test", "fixtures", "libaom-v3.12.1", "motion-compound.ivf.base64",
    ),
  });
  process.stdout.write(
    `FFmpeg release bundle engineering eligible (${verification.sourceVersion}; ${verification.buildId}; ${verification.inventoryEntries} inventory entries; ${verification.libraries} libraries); legal review required\n`,
  );
  process.exit(0);
}
if (releaseRequired) {
  assert.fail(
    "FFmpeg release policy blocked: set AV1SCOPE_FFMPEG_BUILD_MANIFEST or build the default release bundle",
  );
}

const policy = JSON.parse(await readFile(
  path.join(PROJECT_ROOT, "native", "ffmpeg-distribution-policy-v1.json"), "utf8",
));
assert.equal(policy.schemaVersion, "av1scope.ffmpeg-distribution-policy.v1");
assert.deepEqual(policy.requiredLibraries, [
  "libavcodec", "libavfilter", "libavformat", "libavutil", "libswscale", "zlib",
]);
assert.ok(policy.requiredReleaseEvidence.includes("licenseInventory"));
assert.ok(policy.requiredReleaseEvidence.includes("sbom"));

const ffmpeg = command("ffmpeg", ["-hide_banner", "-version"]);
const developmentLibraries = ["libavformat", "libavcodec", "libavutil"];
assert.ok(developmentLibraries.every((library) => policy.requiredLibraries.includes(library)));
const pkgVersions = new Map();
const pkgDirectories = new Map();
for (const library of developmentLibraries) {
  const versionResult = command("pkg-config", ["--modversion", library]);
  const directoryResult = command("pkg-config", ["--variable=libdir", library]);
  if (ffmpeg.status !== 0 || versionResult.status !== 0 || directoryResult.status !== 0) {
    process.stdout.write("FFmpeg provenance check skipped: runtime or development metadata unavailable\n");
    process.exit(0);
  }
  pkgVersions.set(library, versionResult.stdout.trim());
  pkgDirectories.set(library, directoryResult.stdout.trim());
}

const buildConfiguration = command("ffmpeg", ["-hide_banner", "-buildconf"]);
assert.equal(buildConfiguration.status, 0, buildConfiguration.stderr);
const configureFlags = extractConfigureFlags(buildConfiguration.stdout);
assert.ok(configureFlags.length > 0, "empty FFmpeg configure flags");
const forbiddenFlags = policy.forbiddenConfigureFlags
  .filter((flag) => configureFlags.includes(flag));

const libraries = [];
for (const library of developmentLibraries) {
  const libdir = pkgDirectories.get(library);
  assert.ok(path.isAbsolute(libdir), `${library} pkg-config libdir must be absolute`);
  const file = await resolveLibraryFile(library, libdir);
  assert.notEqual(file, null, `${library} shared object is not resolvable`);
  libraries.push({
    name: library,
    version: pkgVersions.get(library),
    file: path.basename(file),
    sha256: await sha256(file),
  });
}

const runtimeVersion = ffmpeg.stdout.match(/^ffmpeg version ([^\s]+)/mu)?.[1];
const compilerIdentity = ffmpeg.stdout.match(/^built with (.+)$/mu)?.[1];
assert.ok(runtimeVersion, "FFmpeg runtime version missing");
assert.ok(compilerIdentity, "FFmpeg compiler identity missing");

const report = {
  schemaVersion: "av1scope.ffmpeg-development-provenance.v1",
  runtimeVersion,
  compilerIdentity,
  configureFlags,
  libraries,
  forbiddenFlags,
  releaseEvidencePresent: {
    sourceRevision: false,
    sourceArchiveSha256: false,
    configureFlags: true,
    compilerIdentity: true,
    binarySha256: true,
    bundleInventory: false,
    licenseInventory: false,
    sbom: false,
    relocatableRpath: false,
    runtimeSmoke: false,
  },
};
const missingReleaseEvidence = policy.requiredReleaseEvidence
  .filter((name) => report.releaseEvidencePresent[name] !== true);
const distributionEligible = forbiddenFlags.length === 0 && missingReleaseEvidence.length === 0;

const decision = distributionEligible
  ? "distribution evidence eligible"
  : `distribution blocked: ${[
      ...forbiddenFlags,
      ...missingReleaseEvidence.map((name) => `missing:${name}`),
    ].join(", ")}`;
process.stdout.write(
  `FFmpeg development provenance captured (${runtimeVersion}; ${libraries.length} libraries); ${decision}\n`,
);
