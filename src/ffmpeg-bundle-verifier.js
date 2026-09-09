import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import path from "node:path";

import {
  computeFfmpegSbomSerialNumber,
  FORBIDDEN_FFMPEG_CONFIGURE_FLAGS,
  validateFfmpegBuildManifest,
} from "./ffmpeg-provenance.js";
import { stringifyCanonical } from "./json.js";
import { demuxBufferInNativeWorker } from "./native-demux-worker.js";

const MAXIMUM_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/u;
const INVENTORY_EXCLUSIONS = Object.freeze([
  "compliance/bundle-inventory.json",
  "ffmpeg-build-manifest.json",
]);
const SYSTEM_ELF_LIBRARIES = new Set(["libc.so.6", "libm.so.6"]);
const FEATURE_OPTIONS = Object.freeze({
  bsfs: "-bsfs",
  decoders: "-decoders",
  demuxers: "-demuxers",
  encoders: "-encoders",
  filters: "-filters",
  muxers: "-muxers",
  protocols: "-protocols",
});

async function sha256File(target) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  return digest.digest("hex");
}

function assertSafeRelativePath(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, SAFE_RELATIVE_PATH, `${label} must be a safe relative path`);
  return value;
}

function pathInside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function resolveRegularBundleFile(bundleRoot, relative, label) {
  assertSafeRelativePath(relative, label);
  const target = path.resolve(bundleRoot, ...relative.split("/"));
  assert.ok(pathInside(bundleRoot, target), `${label} escapes the bundle root`);
  const metadata = await lstat(target);
  assert.ok(metadata.isFile(), `${label} must reference a regular file`);
  const resolved = await realpath(target);
  assert.ok(pathInside(bundleRoot, resolved), `${label} resolves outside the bundle root`);
  return { target, metadata };
}

async function verifyFileReference(bundleRoot, reference, label) {
  const { target, metadata } = await resolveRegularBundleFile(bundleRoot, reference.path, label);
  assert.equal(await sha256File(target), reference.sha256, `${label} SHA-256 mismatch`);
  return { target, metadata };
}

async function readCanonicalJsonReference(bundleRoot, reference, label) {
  const { target } = await verifyFileReference(bundleRoot, reference, label);
  const contents = await readFile(target, "utf8");
  const value = JSON.parse(contents);
  assert.equal(contents, stringifyCanonical(value), `${label} must use canonical JSON`);
  return { target, value };
}

async function collectBundleEntries(bundleRoot, exclusions) {
  const entries = [];
  const excluded = new Set(exclusions);
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const target = path.join(directory, child.name);
      const relative = path.relative(bundleRoot, target).split(path.sep).join("/");
      assertSafeRelativePath(relative, "bundle inventory path");
      if (excluded.has(relative)) continue;
      if (child.isDirectory()) {
        await visit(target);
      } else if (child.isFile()) {
        const metadata = await lstat(target);
        entries.push({
          path: relative,
          type: "file",
          size: metadata.size,
          sha256: await sha256File(target),
        });
      } else if (child.isSymbolicLink()) {
        const linkTarget = await readlink(target);
        assert.equal(path.isAbsolute(linkTarget), false, `absolute bundle symlink: ${relative}`);
        const resolved = path.resolve(path.dirname(target), linkTarget);
        assert.ok(pathInside(bundleRoot, resolved), `bundle symlink escapes root: ${relative}`);
        await lstat(resolved);
        entries.push({ path: relative, type: "symlink", target: linkTarget });
      } else {
        assert.fail(`unsupported bundle entry type: ${relative}`);
      }
    }
  }
  await visit(bundleRoot);
  return entries;
}

async function verifyBundleInventory(bundleRoot, manifest, inventory) {
  assert.equal(inventory.schemaVersion, 1, "unsupported bundle inventory schemaVersion");
  assert.equal(inventory.kind, "av1scope-ffmpeg-bundle-inventory");
  assert.equal(inventory.buildId, manifest.buildId, "bundle inventory buildId mismatch");
  assert.deepEqual(inventory.excluded, INVENTORY_EXCLUSIONS);
  assert.ok(Array.isArray(inventory.entries), "bundle inventory entries must be an array");
  assert.ok(inventory.entries.length > 0 && inventory.entries.length <= 512);
  const actualEntries = await collectBundleEntries(bundleRoot, INVENTORY_EXCLUSIONS);
  assert.deepEqual(inventory.entries, actualEntries, "bundle tree does not match exact inventory");

  const inventoryPaths = new Set(inventory.entries.map((entry) => entry.path));
  assert.equal(inventoryPaths.size, inventory.entries.length, "duplicate bundle inventory path");
  const declared = [
    manifest.source.archive,
    manifest.artifacts.ffmpeg,
    manifest.artifacts.ffprobe,
    manifest.artifacts.demuxAdapter,
    manifest.artifacts.demuxWorker,
    ...manifest.artifacts.libraries,
    manifest.compliance.licenseInventory,
    manifest.compliance.sbom,
  ];
  for (const reference of declared) {
    assert.ok(inventoryPaths.has(reference.path), `declared file absent from inventory: ${reference.path}`);
  }
  return inventoryPaths;
}

async function verifyLicenseInventory(bundleRoot, manifest, inventory, bundleInventoryPaths) {
  assert.equal(inventory.schemaVersion, 1, "unsupported license inventory schemaVersion");
  assert.equal(inventory.kind, "av1scope-ffmpeg-license-inventory");
  assert.equal(inventory.buildId, manifest.buildId, "license inventory buildId mismatch");
  assert.equal(inventory.legalReviewRequired, true);
  assert.deepEqual(inventory.platformRuntime, ["glibc", "libm"]);
  assert.ok(Array.isArray(inventory.entries) && inventory.entries.length >= 5);
  const sortedPaths = inventory.entries.map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(inventory.entries.map((entry) => entry.path), sortedPaths);
  assert.equal(new Set(sortedPaths).size, sortedPaths.length, "duplicate license path");
  const licenses = new Set();
  for (const [index, entry] of inventory.entries.entries()) {
    assert.equal(typeof entry.component, "string", `license entry ${index} component missing`);
    assert.equal(typeof entry.license, "string", `license entry ${index} license missing`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/u, `license entry ${index} digest invalid`);
    const { target } = await resolveRegularBundleFile(
      bundleRoot, entry.path, `license inventory entry ${index}`,
    );
    assert.equal(await sha256File(target), entry.sha256, `license entry ${index} digest mismatch`);
    assert.ok(bundleInventoryPaths.has(entry.path), `license entry ${index} absent from inventory`);
    licenses.add(entry.license);
  }
  for (const required of manifest.compliance.licenses) {
    assert.ok(licenses.has(required), `license inventory missing ${required}`);
  }
  assert.ok(
    licenses.has("LicenseRef-AV1Scope-Project-License-Pending"),
    "project license review state must remain explicit",
  );
}

function componentHash(component) {
  const entry = component?.hashes?.find((hash) => hash.alg === "SHA-256");
  assert.match(entry?.content ?? "", /^[0-9a-f]{64}$/u, `SBOM hash missing for ${component?.name}`);
  return entry.content;
}

function verifySbom(manifest, sbom) {
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.version, 1);
  assert.equal(sbom.serialNumber, computeFfmpegSbomSerialNumber(manifest.buildId));
  assert.equal(sbom.metadata?.component?.name, "av1scope-ffmpeg-bundle");
  assert.equal(sbom.metadata?.component?.version, manifest.buildId);
  assert.equal(
    sbom.metadata?.timestamp,
    new Date(manifest.build.sourceDateEpoch * 1_000).toISOString(),
  );
  assert.ok(Array.isArray(sbom.components));
  const components = new Map(sbom.components.map((component) => [component.name, component]));
  assert.equal(components.size, sbom.components.length, "duplicate SBOM component name");
  assert.equal(componentHash(components.get("FFmpeg")), manifest.source.archive.sha256);
  assert.equal(componentHash(components.get("libaom")), manifest.dependencies.libaom.librarySha256);
  assert.equal(componentHash(components.get("zlib")), manifest.dependencies.zlib.librarySha256);
  assert.equal(
    componentHash(components.get("av1scope-native-demux")),
    manifest.artifacts.demuxWorker.sha256,
  );
}

function waitForProcess(child, label, stdout, stderr, byteCount) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (byteCount.value > MAXIMUM_PROCESS_OUTPUT_BYTES) {
        reject(new Error(`${label} exceeded its output budget`));
      } else if (code === 0 && signal === null) {
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      } else {
        reject(new Error(
          `${label} failed with code=${code} signal=${signal}\n${Buffer.concat(stderr).toString("utf8")}`,
        ));
      }
    });
  });
}

async function runProcess(executable, args, input = null) {
  const environment = {
    ...process.env,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    LD_AUDIT: "",
    LD_LIBRARY_PATH: "",
    LD_PRELOAD: "",
  };
  const child = spawn(executable, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  const byteCount = { value: 0 };
  child.stdout.on("data", (chunk) => {
    byteCount.value += chunk.length;
    if (byteCount.value <= MAXIMUM_PROCESS_OUTPUT_BYTES) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    byteCount.value += chunk.length;
    if (byteCount.value <= MAXIMUM_PROCESS_OUTPUT_BYTES) stderr.push(chunk);
  });
  if (input === null) child.stdin.end();
  else child.stdin.end(input);
  return waitForProcess(child, executable, stdout, stderr, byteCount);
}

function normalizeBuildConfigurationFlag(flag) {
  const equals = flag.indexOf("=");
  if (equals === -1) return flag;
  const name = flag.slice(0, equals);
  let value = flag.slice(equals + 1);
  if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
  if (name === "--extra-ldexeflags" || name === "--extra-ldsoflags") {
    value = value.replaceAll("\\$", "$").replace(/\$+/gu, "$");
  }
  return `${name}=${value}`;
}

function extractBuildConfiguration(output) {
  const start = output.indexOf("configuration:");
  assert.notEqual(start, -1, "bundled FFmpeg build configuration missing");
  return output.slice(start + "configuration:".length)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--"))
    .map(normalizeBuildConfigurationFlag)
    .sort((left, right) => left.localeCompare(right));
}

function featureCandidates(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length === 0) continue;
    const candidate = fields.length >= 2 && /^[A-Z.]{1,6}$/u.test(fields[0])
      ? fields[1]
      : fields[0];
    for (const name of candidate.split(",")) names.add(name);
  }
  return names;
}

async function verifyRuntimeCapabilities(ffmpeg, manifest) {
  const version = await runProcess(ffmpeg, ["-hide_banner", "-version"]);
  const versionText = version.stdout.toString("utf8");
  assert.match(
    versionText,
    new RegExp(`^ffmpeg version ${manifest.source.version.replaceAll(".", "\\.")}\\b`, "u"),
  );
  assert.match(versionText, /built with /u);

  const buildConfiguration = await runProcess(ffmpeg, ["-hide_banner", "-buildconf"]);
  const actualFlags = extractBuildConfiguration(buildConfiguration.stdout.toString("utf8"));
  const expectedFlags = [...manifest.build.configureFlags]
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(actualFlags, expectedFlags, "runtime configure flags differ from manifest");
  for (const forbidden of FORBIDDEN_FFMPEG_CONFIGURE_FLAGS) {
    assert.equal(actualFlags.includes(forbidden), false, `runtime enables forbidden ${forbidden}`);
  }

  for (const [group, option] of Object.entries(FEATURE_OPTIONS)) {
    const result = await runProcess(ffmpeg, ["-hide_banner", option]);
    const candidates = featureCandidates(result.stdout.toString("utf8"));
    for (const feature of manifest.features[group]) {
      const runtimeName = group === "decoders" ? feature.replaceAll("_", "-") : feature;
      assert.ok(candidates.has(runtimeName), `runtime ${group} missing ${feature}`);
    }
  }
}

async function readElfDynamic(target) {
  const result = await runProcess("readelf", ["-d", target]);
  const output = result.stdout.toString("utf8");
  return {
    needed: [...output.matchAll(/Shared library: \[([^\]]+)\]/gu)].map((match) => match[1]),
    runpath: output.match(/Library r(?:un)?path: \[([^\]]+)\]/iu)?.[1] ?? null,
    soname: output.match(/Library soname: \[([^\]]+)\]/iu)?.[1] ?? null,
  };
}

async function verifyElfLayout(bundleRoot, manifest, inventory) {
  assert.equal(process.platform, "linux", "this FFmpeg release bundle gate requires Linux ELF");
  const localLibraries = new Set(inventory.entries
    .filter((entry) => entry.path.startsWith("lib/"))
    .map((entry) => path.posix.basename(entry.path)));
  const binaries = [
    manifest.artifacts.ffmpeg,
    manifest.artifacts.ffprobe,
    manifest.artifacts.demuxWorker,
    manifest.artifacts.demuxAdapter,
    ...manifest.artifacts.libraries,
  ];
  for (const reference of binaries) {
    const { target } = await resolveRegularBundleFile(bundleRoot, reference.path, reference.path);
    const dynamic = await readElfDynamic(target);
    if (reference.name === "zlib") {
      assert.equal(dynamic.soname, reference.soname);
    } else if (reference.name) {
      assert.equal(dynamic.soname, reference.soname, `${reference.name} ELF SONAME mismatch`);
    }
    const expectedRunpath = reference.path.startsWith("bin/")
      ? "$ORIGIN/../lib"
      : reference.name === "zlib" ? null : "$ORIGIN";
    if (expectedRunpath !== null) {
      assert.equal(dynamic.runpath, expectedRunpath, `${reference.path} RUNPATH mismatch`);
    }
    for (const needed of dynamic.needed) {
      if (localLibraries.has(needed)) continue;
      assert.ok(SYSTEM_ELF_LIBRARIES.has(needed), `${reference.path} has undeclared dependency ${needed}`);
    }
  }
  for (const library of manifest.artifacts.libraries) {
    const sonamePath = path.join(bundleRoot, "lib", library.soname);
    assert.equal(await realpath(sonamePath), await realpath(path.join(bundleRoot, library.path)));
  }
}

async function verifySmoke(bundleRoot, manifest, fixturePath) {
  const encoded = (await readFile(fixturePath, "ascii")).replaceAll(/\s/gu, "");
  const input = Buffer.from(encoded, "base64");
  assert.equal(input.toString("base64"), encoded, "FFmpeg smoke fixture is not canonical base64");
  const ffmpeg = path.join(bundleRoot, manifest.artifacts.ffmpeg.path);
  const preview = await runProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-vf", "select=eq(n\\,0),scale=64:-1", "-frames:v", "1",
    "-f", "image2pipe", "-vcodec", "png", "pipe:1",
  ], input);
  assert.deepEqual([...preview.stdout.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const trace = await runProcess(ffmpeg, [
    "-hide_banner", "-loglevel", "verbose", "-i", "pipe:0",
    "-map", "0:v:0", "-c:v", "copy", "-bsf:v", "trace_headers", "-f", "null", "-",
  ], input);
  const traceText = trace.stderr.toString("utf8");
  for (const marker of ["Sequence Header", "Frame Header", "Tile Group"]) {
    assert.ok(traceText.includes(marker), `trace_headers smoke missing ${marker}`);
  }
  const demux = await demuxBufferInNativeWorker(input, {
    executable: path.join(bundleRoot, manifest.artifacts.demuxWorker.path),
  });
  assert.equal(demux.stream.width, 128);
  assert.equal(demux.stream.height, 96);
  assert.equal(demux.samples.length, 24);
  return {
    previewBytes: preview.stdout.length,
    sampleCount: demux.samples.length,
    traceMarkers: ["Sequence Header", "Frame Header", "Tile Group"],
  };
}

export async function verifyFfmpegBundle({ manifestPath, fixturePath }) {
  assert.equal(typeof manifestPath, "string", "manifestPath is required");
  assert.equal(typeof fixturePath, "string", "fixturePath is required");
  const absoluteManifest = path.resolve(manifestPath);
  const bundleRoot = await realpath(path.dirname(absoluteManifest));
  const manifestContents = await readFile(absoluteManifest, "utf8");
  const validated = validateFfmpegBuildManifest(JSON.parse(manifestContents));
  assert.equal(
    manifestContents,
    stringifyCanonical(validated.manifest),
    "FFmpeg build manifest must be canonical and contain no unbound fields",
  );
  assert.equal(await sha256File(absoluteManifest), validated.manifestSha256);
  const manifest = validated.manifest;

  const references = [
    [manifest.source.archive, "source archive"],
    [manifest.artifacts.ffmpeg, "ffmpeg artifact"],
    [manifest.artifacts.ffprobe, "ffprobe artifact"],
    [manifest.artifacts.demuxAdapter, "demux adapter artifact"],
    [manifest.artifacts.demuxWorker, "demux worker artifact"],
    ...manifest.artifacts.libraries.map((library) => [library, `${library.name} artifact`]),
  ];
  for (const [reference, label] of references) {
    await verifyFileReference(bundleRoot, reference, label);
  }
  const { value: inventory } = await readCanonicalJsonReference(
    bundleRoot, manifest.compliance.bundleInventory, "bundle inventory",
  );
  const inventoryPaths = await verifyBundleInventory(bundleRoot, manifest, inventory);
  const { value: licenseInventory } = await readCanonicalJsonReference(
    bundleRoot, manifest.compliance.licenseInventory, "license inventory",
  );
  await verifyLicenseInventory(bundleRoot, manifest, licenseInventory, inventoryPaths);
  const { value: sbom } = await readCanonicalJsonReference(
    bundleRoot, manifest.compliance.sbom, "CycloneDX SBOM",
  );
  verifySbom(manifest, sbom);
  await verifyElfLayout(bundleRoot, manifest, inventory);
  await verifyRuntimeCapabilities(
    path.join(bundleRoot, manifest.artifacts.ffmpeg.path), manifest,
  );
  const smoke = await verifySmoke(bundleRoot, manifest, path.resolve(fixturePath));
  return {
    schemaVersion: 1,
    kind: "av1scope-ffmpeg-bundle-verification",
    buildId: manifest.buildId,
    manifestSha256: validated.manifestSha256,
    sourceVersion: manifest.source.version,
    sourceRevision: manifest.source.revision,
    inventoryEntries: inventory.entries.length,
    libraries: manifest.artifacts.libraries.length,
    legalReviewRequired: licenseInventory.legalReviewRequired,
    bundleRoot,
    artifacts: {
      ffmpeg: path.join(bundleRoot, manifest.artifacts.ffmpeg.path),
      ffprobe: path.join(bundleRoot, manifest.artifacts.ffprobe.path),
      demuxWorker: path.join(bundleRoot, manifest.artifacts.demuxWorker.path),
    },
    smoke,
  };
}
