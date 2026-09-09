import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeBuffer } from "../src/analyzer.js";
import { stringifyCanonical } from "../src/json.js";
import {
  computeLibaomBuildId,
  LIBAOM_BUILD_MANIFEST_KIND,
  LIBAOM_BUILD_MANIFEST_SCHEMA_VERSION,
  REQUIRED_LIBAOM_INSPECTION_FEATURES,
  validateLibaomBuildManifest,
} from "../src/libaom-provenance.js";
import { inspectReportFramesInNativeWorker } from "../src/native-inspection-worker.js";
import { discoverNativeWorker } from "../src/native-worker-discovery.js";
import { DEMO_SAMPLE_NAME, demoSampleBytes } from "../public/demo-sample.js";

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIBAOM_REPOSITORY = "https://aomedia.googlesource.com/aom";
const AOM_PATENT_LICENSE = "LicenseRef-AOM-Patent-License-1.0";

function parseArguments(args) {
  const options = {
    sourceDirectory: process.env.AV1SCOPE_LIBAOM_SOURCE_DIR
      ? path.resolve(process.env.AV1SCOPE_LIBAOM_SOURCE_DIR)
      : path.resolve(projectDirectory, "../aom"),
    patchedSourceDirectory: null,
    libaomBuildDirectory: path.resolve(projectDirectory, "build/libaom-inspection"),
    nativeBuildDirectory: path.resolve(projectDirectory, "build/native"),
    expectedVersion: "3.12.1",
    expectedRevision: null,
    targetCpu: "generic",
    allowDirty: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const next = () => {
      const item = args[++index];
      if (!item || item.startsWith("--")) throw new Error(`${value} requires a value`);
      return item;
    };
    if (value === "--source") options.sourceDirectory = path.resolve(next());
    else if (value === "--patched-source-dir") {
      options.patchedSourceDirectory = path.resolve(next());
    }
    else if (value === "--libaom-build-dir") {
      options.libaomBuildDirectory = path.resolve(next());
    } else if (value === "--native-build-dir") {
      options.nativeBuildDirectory = path.resolve(next());
    } else if (value === "--expected-version") options.expectedVersion = next();
    else if (value === "--expected-revision") options.expectedRevision = next();
    else if (value === "--target-cpu") options.targetCpu = next();
    else if (value === "--allow-dirty") options.allowDirty = true;
    else throw new Error(`unknown option: ${value}`);
  }
  if (!/^\d+\.\d+\.\d+$/u.test(options.expectedVersion)) {
    throw new Error("--expected-version must be a semantic version");
  }
  if (options.expectedRevision !== null
      && !/^[0-9a-f]{40,64}$/u.test(options.expectedRevision)) {
    throw new Error("--expected-revision must be a lowercase 40..64 hex revision");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(options.targetCpu)) {
    throw new Error("--target-cpu contains unsupported characters");
  }
  return options;
}

function run(command, args, {
  capture = false,
  maximumBytes = 16 * 1024 * 1024,
  environment = process.env,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: environment,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maximumBytes) {
        child.kill("SIGKILL");
        reject(new Error(`${command} output exceeded ${maximumBytes} bytes`));
        return;
      }
      target.push(chunk);
    };
    if (capture) {
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
    }
    child.once("error", reject);
    child.once("close", (status, signal) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (status === 0) resolve({ stdout: output, stderr: errorOutput });
      else reject(new Error(
        `${command} ${args.join(" ")} failed (${signal ?? `status ${status}`})`
        + (errorOutput ? `: ${errorOutput}` : ""),
      ));
    });
  });
}

const sha256 = (input) => createHash("sha256").update(input).digest("hex");

function hashCommandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    const stderr = [];
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => hash.update(chunk));
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0) resolve(hash.digest("hex"));
      else reject(new Error(
        `${command} ${args.join(" ")} failed (${signal ?? `status ${status}`})`
        + (stderr.length > 0 ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : ""),
      ));
    });
  });
}

async function hashFiles(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(projectDirectory, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function sourceMetadata(options) {
  const required = [
    "CMakeLists.txt", "LICENSE", "PATENTS", "aom/aom_decoder.h",
    "av1/common/common_data.h", "av1/decoder/inspection.h",
  ];
  for (const relative of required) await access(path.join(options.sourceDirectory, relative));
  const cmake = await readFile(path.join(options.sourceDirectory, "CMakeLists.txt"), "utf8");
  const revision = (await run(
    "git", ["-C", options.sourceDirectory, "rev-parse", "HEAD"], { capture: true },
  )).stdout;
  if (!/^[0-9a-f]{40,64}$/u.test(revision)) throw new Error("invalid libaom Git revision");
  if (options.expectedRevision !== null && revision !== options.expectedRevision) {
    throw new Error(`libaom revision ${revision}; expected ${options.expectedRevision}`);
  }
  let version = /project\(AOM[^)]*VERSION\s+(\d+\.\d+\.\d+)\)/su.exec(cmake)?.[1];
  if (version === undefined) {
    const tag = (await run(
      "git", ["-C", options.sourceDirectory, "describe", "--tags", "--exact-match", "HEAD"],
      { capture: true },
    )).stdout;
    version = /^v?(\d+\.\d+\.\d+)$/u.exec(tag)?.[1];
  }
  if (version !== options.expectedVersion) {
    throw new Error(`libaom version ${version ?? "unknown"}; expected ${options.expectedVersion}`);
  }
  const difference = (await run(
    "git", ["-C", options.sourceDirectory, "diff", "--binary", "--no-ext-diff", "HEAD"],
    { capture: true },
  )).stdout;
  const untracked = (await run(
    "git", ["-C", options.sourceDirectory, "ls-files", "--others", "--exclude-standard"],
    { capture: true },
  )).stdout;
  if (untracked.length > 0) {
    throw new Error("libaom source contains untracked files; provenance requires a clean export");
  }
  const dirty = difference.length > 0;
  if (dirty && !options.allowDirty) {
    throw new Error("libaom source has tracked changes; use --allow-dirty only for development smoke");
  }
  const sourceDateEpochText = (await run(
    "git", ["-C", options.sourceDirectory, "show", "-s", "--format=%ct", "HEAD"],
    { capture: true },
  )).stdout;
  const sourceDateEpoch = Number(sourceDateEpochText);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new Error("invalid libaom commit timestamp");
  }
  const archiveSha256 = await hashCommandOutput(
    "git", ["-C", options.sourceDirectory, "archive", "--format=tar", revision],
  );
  return {
    version,
    revision,
    repository: LIBAOM_REPOSITORY,
    archiveSha256,
    sourceDateEpoch,
    dirty,
    trackedDiffSha256: sha256(difference.length === 0 ? difference : `${difference}\n`),
  };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function preparePatchedSource(options, source, patchFile, patchSha256) {
  if (source.dirty) {
    if (source.trackedDiffSha256 !== patchSha256) {
      throw new Error("dirty libaom source must contain exactly the pinned inspection patch");
    }
    return options.sourceDirectory;
  }
  const target = options.patchedSourceDirectory ?? path.resolve(
    projectDirectory,
    `build/libaom-patched-${source.revision.slice(0, 12)}-${patchSha256.slice(0, 12)}`,
  );
  if (target === options.sourceDirectory) {
    throw new Error("--patched-source-dir must differ from the clean source directory");
  }
  if (!await exists(path.join(target, ".git"))) {
    if (await exists(target)) {
      throw new Error("patched libaom source target exists but is not a Git repository");
    }
    await run("git", [
      "clone", "--local", "--no-checkout", options.sourceDirectory, target,
    ]);
    await run("git", ["-C", target, "checkout", "--detach", source.revision]);
  }
  const revision = (await run(
    "git", ["-C", target, "rev-parse", "HEAD"], { capture: true },
  )).stdout;
  if (revision !== source.revision) {
    throw new Error("patched libaom source target has a different revision");
  }
  const untracked = (await run(
    "git", ["-C", target, "ls-files", "--others", "--exclude-standard"], { capture: true },
  )).stdout;
  if (untracked.length > 0) {
    throw new Error("patched libaom source contains untracked files");
  }
  let difference = (await run(
    "git", ["-C", target, "diff", "--binary", "--no-ext-diff", "HEAD"], { capture: true },
  )).stdout;
  if (difference.length === 0) {
    await run("git", ["-C", target, "apply", "--check", patchFile]);
    await run("git", ["-C", target, "apply", patchFile]);
    difference = (await run(
      "git", ["-C", target, "diff", "--binary", "--no-ext-diff", "HEAD"],
      { capture: true },
    )).stdout;
  }
  if (sha256(`${difference}\n`) !== patchSha256) {
    throw new Error("patched libaom source differs from the pinned inspection patch");
  }
  await run("git", ["-C", target, "diff", "--check"]);
  return target;
}

async function readCmakeCache(buildDirectory) {
  const text = await readFile(path.join(buildDirectory, "CMakeCache.txt"), "utf8");
  const values = new Map();
  for (const line of text.split(/\r?\n/gu)) {
    const match = /^([^#/:=]+)(?::[^=]+)?=(.*)$/u.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

async function toolchainMetadata(buildDirectory) {
  const cache = await readCmakeCache(buildDirectory);
  const compilerPath = cache.get("CMAKE_C_COMPILER");
  if (!compilerPath) throw new Error("CMake did not record CMAKE_C_COMPILER");
  const version = (await run(compilerPath, ["--version"], { capture: true })).stdout
    .split(/\r?\n/gu)[0];
  const target = (await run(compilerPath, ["-dumpmachine"], { capture: true })).stdout;
  const cflags = [cache.get("CMAKE_C_FLAGS"), cache.get("CMAKE_C_FLAGS_RELEASE")]
    .filter((value) => typeof value === "string" && value.length > 0);
  return {
    toolchain: {
      compiler: path.basename(compilerPath),
      compilerVersion: version,
      target,
    },
    cflags,
  };
}

async function firstExisting(candidates, label) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`${label} was not produced by the native build`);
}

function bundlePath(root, target) {
  const relative = path.relative(root, target).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`release bundle path escapes its root: ${target}`);
  }
  return relative;
}

async function writeCanonical(target, value) {
  const bytes = Buffer.from(stringifyCanonical(value));
  await writeFile(target, bytes);
  return sha256(bytes);
}

const options = parseArguments(process.argv.slice(2));
const source = await sourceMetadata(options);
const patchFile = path.join(projectDirectory, "patches/libaom-v3.12.1-inspection.patch");
const patchSha256 = sha256(await readFile(patchFile));
const patchedSourceDirectory = await preparePatchedSource(
  options, source, patchFile, patchSha256,
);
const producerFiles = [
  path.join(projectDirectory, "native/libaom_builtin_inspection_patch.c"),
  path.join(projectDirectory, "native/libaom_inspection_adapter.c"),
  path.join(projectDirectory, "native/include/av1scope_libaom_patch.h"),
  path.join(projectDirectory, "native/include/av1scope_inspection.h"),
];
const producerSha256 = await hashFiles(producerFiles);
const libaomConfigureArguments = [
  "-S", patchedSourceDirectory,
  "-B", options.libaomBuildDirectory,
  "-DCONFIG_INSPECTION=1",
  "-DCONFIG_AV1_DECODER=1",
  "-DCONFIG_AV1_ENCODER=0",
  "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
  "-DBUILD_SHARED_LIBS=OFF",
  "-DENABLE_TESTS=0",
  "-DENABLE_EXAMPLES=0",
  "-DENABLE_TOOLS=0",
  "-DENABLE_DOCS=0",
  "-DCMAKE_BUILD_TYPE=Release",
  `-DAOM_TARGET_CPU=${options.targetCpu}`,
];
const libaomBuildArguments = [
  "--build", options.libaomBuildDirectory, "--config", "Release",
  "--target", "aom", "--parallel", "4",
];
const buildEnvironment = {
  ...process.env,
  SOURCE_DATE_EPOCH: String(source.sourceDateEpoch),
};
await run("cmake", libaomConfigureArguments, { environment: buildEnvironment });
const { toolchain, cflags } = await toolchainMetadata(options.libaomBuildDirectory);
const buildInputs = {
  source: {
    repository: source.repository,
    version: source.version,
    revision: source.revision,
    archiveSha256: source.archiveSha256,
  },
  patch: {
    revision: "av1scope-libaom-inspection-v1",
    patchSetSha256: patchSha256,
    producerSha256,
    file: { path: "compliance/libaom-v3.12.1-inspection.patch", sha256: patchSha256 },
  },
  toolchain,
  build: {
    sourceDateEpoch: source.sourceDateEpoch,
    commands: [
      ["cmake", "-S", "${LIBAOM_PATCHED_SOURCE}", "-B", "${LIBAOM_BUILD}",
        ...libaomConfigureArguments.slice(4)],
      ["cmake", "--build", "${LIBAOM_BUILD}", "--config", "Release",
        "--target", "aom", "--parallel", "4"],
      ["cmake", "--build", "${NATIVE_BUILD}", "--config", "Release",
        "--target", "av1scope_inspection_worker", "--parallel", "4"],
    ],
    cflags,
    features: [...REQUIRED_LIBAOM_INSPECTION_FEATURES],
  },
};
const buildId = computeLibaomBuildId(buildInputs);
await run("cmake", libaomBuildArguments, { environment: buildEnvironment });
const libaomLibrary = path.join(options.libaomBuildDirectory, "libaom.a");
await access(libaomLibrary);
await run("cmake", [
  "-S", path.join(projectDirectory, "native"),
  "-B", options.nativeBuildDirectory,
  "-DCMAKE_BUILD_TYPE=Release",
  `-DAV1SCOPE_LIBAOM_SOURCE_DIR=${patchedSourceDirectory}`,
  `-DAV1SCOPE_LIBAOM_BUILD_DIR=${options.libaomBuildDirectory}`,
  `-DAV1SCOPE_LIBAOM_LIBRARY=${libaomLibrary}`,
  `-DAV1SCOPE_LIBAOM_BUILD_ID=${buildId}`,
], { environment: buildEnvironment });
await run("cmake", [
  "--build", options.nativeBuildDirectory, "--config", "Release",
  "--target", "av1scope_inspection_worker", "--parallel", "4",
], { environment: buildEnvironment });
await run("cmake", [
  "--build", options.nativeBuildDirectory, "--config", "Release",
  "--target", "av1scope_crash_after_stdin", "--parallel", "4",
], { environment: buildEnvironment });
const workerName = process.platform === "win32"
  ? "av1scope_inspection_worker.exe" : "av1scope_inspection_worker";
const worker = await discoverNativeWorker("inspection", {
  environment: {},
  candidatePaths: [
    path.join(options.nativeBuildDirectory, workerName),
    path.join(options.nativeBuildDirectory, "Release", workerName),
  ],
});
if (!worker.available) throw new Error("inspection worker build completed but was not discovered");
const input = Buffer.from(demoSampleBytes());
const report = analyzeBuffer(input, { sourceName: DEMO_SAMPLE_NAME });
const overlay = await inspectReportFramesInNativeWorker(input, report, {
  executable: worker.path,
});
const blockCount = overlay.frames.reduce((count, frame) => count + frame.blocks.length, 0);
if (overlay.provenance.producer !== "libaom-inspect-v1"
    || overlay.provenance.build !== buildId
    || overlay.provenance.featureFlags !== 127
    || blockCount < 1) {
  throw new Error("real libaom inspection smoke returned unexpected provenance or blocks");
}
const patchLibrary = await firstExisting([
  path.join(options.nativeBuildDirectory, "libav1scope_libaom_builtin_patch.a"),
  path.join(options.nativeBuildDirectory, "Release", "av1scope_libaom_builtin_patch.lib"),
], "built-in libaom patch library");
const inspectionAdapter = await firstExisting([
  path.join(options.nativeBuildDirectory, "libav1scope_libaom_inspection.so"),
  path.join(options.nativeBuildDirectory, "libav1scope_libaom_inspection.dylib"),
  path.join(options.nativeBuildDirectory, "Release", "av1scope_libaom_inspection.dll"),
], "libaom inspection adapter");
const artifactDigests = {
  libaom: sha256(await readFile(libaomLibrary)),
  patchLibrary: sha256(await readFile(patchLibrary)),
  inspectionAdapter: sha256(await readFile(inspectionAdapter)),
  inspectionWorker: sha256(await readFile(worker.path)),
};
const receipt = {
  schemaVersion: 1,
  kind: "av1scope-libaom-development-build-receipt",
  releaseEligible: false,
  reason: source.dirty
    ? "dirty source tree; no release manifest was generated"
    : "development receipt only; use the separately verified release manifest",
  buildId,
  buildInputs,
  artifacts: {
    libaomSha256: artifactDigests.libaom,
    patchLibrarySha256: artifactDigests.patchLibrary,
    inspectionAdapterSha256: artifactDigests.inspectionAdapter,
    inspectionWorkerSha256: artifactDigests.inspectionWorker,
  },
  smoke: { producer: overlay.provenance.producer, featureFlags: 127, blockCount },
};
const receiptPath = path.join(options.nativeBuildDirectory, "libaom-development-receipt.json");
await writeFile(receiptPath, stringifyCanonical(receipt));
let releaseManifestPath = null;
if (!source.dirty) {
  const complianceDirectory = path.join(options.nativeBuildDirectory, "compliance");
  const licenseDirectory = path.join(complianceDirectory, "licenses");
  await mkdir(licenseDirectory, { recursive: true });
  const bundledPatch = path.join(complianceDirectory, "libaom-v3.12.1-inspection.patch");
  const bundledLicense = path.join(licenseDirectory, "libaom-LICENSE.txt");
  const bundledPatents = path.join(licenseDirectory, "libaom-PATENTS.txt");
  const patchNotice = path.join(licenseDirectory, "av1scope-inspection-NOTICE.txt");
  await copyFile(patchFile, bundledPatch);
  await copyFile(path.join(options.sourceDirectory, "LICENSE"), bundledLicense);
  await copyFile(path.join(options.sourceDirectory, "PATENTS"), bundledPatents);
  const noticeBytes = Buffer.from(
    "AV1Scope libaom inspection integration\n"
    + `Source: ${source.repository} @ ${source.revision}\n`
    + "libaom license: BSD-2-Clause\n"
    + "Patent terms: Alliance for Open Media Patent License 1.0 (see libaom-PATENTS.txt)\n"
    + `Inspection patch: av1scope-libaom-inspection-v1 (${patchSha256})\n`,
  );
  await writeFile(patchNotice, noticeBytes);
  const inventoryFiles = [bundledLicense, bundledPatents, patchNotice].map((target) => ({
    path: bundlePath(options.nativeBuildDirectory, target),
  }));
  for (const item of inventoryFiles) {
    item.sha256 = sha256(await readFile(path.join(options.nativeBuildDirectory, item.path)));
  }
  const licenseInventory = {
    schemaVersion: 1,
    kind: "av1scope-license-inventory",
    buildId,
    components: [
      {
        name: "libaom",
        version: source.version,
        revision: source.revision,
        licenses: ["BSD-2-Clause", AOM_PATENT_LICENSE],
        files: inventoryFiles.slice(0, 2),
      },
      {
        name: "av1scope-libaom-inspection-integration",
        version: "1",
        licenses: ["NOASSERTION"],
        files: inventoryFiles.slice(2),
      },
    ],
  };
  const licenseInventoryPath = path.join(complianceDirectory, "license-inventory.json");
  const licenseInventorySha256 = await writeCanonical(licenseInventoryPath, licenseInventory);
  const uuidHex = buildId.slice(0, 32);
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`,
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "av1scope-inspection-worker",
        version: buildId,
        "bom-ref": `av1scope-inspection-worker@${buildId}`,
      },
      properties: [
        { name: "av1scope:source-date-epoch", value: String(source.sourceDateEpoch) },
        { name: "av1scope:libaom-revision", value: source.revision },
        { name: "av1scope:libaom-archive-sha256", value: source.archiveSha256 },
        { name: "av1scope:patch-set-sha256", value: patchSha256 },
      ],
    },
    components: [
      {
        type: "library",
        name: "libaom",
        version: source.version,
        "bom-ref": `libaom@${source.revision}`,
        hashes: [{ alg: "SHA-256", content: artifactDigests.libaom }],
        licenses: [{ expression: `BSD-2-Clause AND ${AOM_PATENT_LICENSE}` }],
        externalReferences: [{
          type: "vcs",
          url: `${source.repository}@${source.revision}`,
        }],
      },
      {
        type: "library",
        name: "av1scope-libaom-builtin-patch",
        version: buildId,
        "bom-ref": `av1scope-libaom-builtin-patch@${buildId}`,
        hashes: [{ alg: "SHA-256", content: artifactDigests.patchLibrary }],
      },
      {
        type: "library",
        name: "av1scope-libaom-inspection-adapter",
        version: buildId,
        "bom-ref": `av1scope-libaom-inspection-adapter@${buildId}`,
        hashes: [{ alg: "SHA-256", content: artifactDigests.inspectionAdapter }],
      },
      {
        type: "application",
        name: "av1scope-inspection-worker",
        version: buildId,
        "bom-ref": `av1scope-inspection-worker@${buildId}`,
        hashes: [{ alg: "SHA-256", content: artifactDigests.inspectionWorker }],
      },
    ],
    dependencies: [
      {
        ref: `av1scope-inspection-worker@${buildId}`,
        dependsOn: [`av1scope-libaom-inspection-adapter@${buildId}`],
      },
      {
        ref: `av1scope-libaom-inspection-adapter@${buildId}`,
        dependsOn: [`av1scope-libaom-builtin-patch@${buildId}`],
      },
      {
        ref: `av1scope-libaom-builtin-patch@${buildId}`,
        dependsOn: [`libaom@${source.revision}`],
      },
    ],
  };
  const sbomPath = path.join(complianceDirectory, "sbom.cdx.json");
  const sbomSha256 = await writeCanonical(sbomPath, bom);
  const manifest = {
    schemaVersion: LIBAOM_BUILD_MANIFEST_SCHEMA_VERSION,
    kind: LIBAOM_BUILD_MANIFEST_KIND,
    buildId,
    ...buildInputs,
    artifacts: {
      patchLibrary: {
        path: bundlePath(options.nativeBuildDirectory, patchLibrary),
        sha256: artifactDigests.patchLibrary,
      },
      inspectionAdapter: {
        path: bundlePath(options.nativeBuildDirectory, inspectionAdapter),
        sha256: artifactDigests.inspectionAdapter,
      },
      inspectionWorker: {
        path: bundlePath(options.nativeBuildDirectory, worker.path),
        sha256: artifactDigests.inspectionWorker,
      },
    },
    compliance: {
      licenses: ["BSD-2-Clause", AOM_PATENT_LICENSE],
      licenseInventory: {
        path: bundlePath(options.nativeBuildDirectory, licenseInventoryPath),
        sha256: licenseInventorySha256,
      },
      sbom: {
        path: bundlePath(options.nativeBuildDirectory, sbomPath),
        sha256: sbomSha256,
      },
    },
  };
  validateLibaomBuildManifest(manifest);
  releaseManifestPath = path.join(options.nativeBuildDirectory, "libaom-build-manifest.json");
  await writeCanonical(releaseManifestPath, manifest);
  await run(process.execPath, [path.join(projectDirectory, "scripts/check-libaom-provenance.mjs")], {
    environment: {
      ...process.env,
      AV1SCOPE_LIBAOM_BUILD_MANIFEST: releaseManifestPath,
      AV1SCOPE_REQUIRE_LIBAOM_PRODUCER: "1",
    },
  });
}
const goldenManifest = path.join(
  projectDirectory, "test/fixtures/libaom-v3.12.1/manifest.json",
);
await access(goldenManifest);
await run(process.execPath, [path.join(projectDirectory, "scripts/check-libaom-block-golden.mjs")], {
  environment: {
    ...process.env,
    AV1SCOPE_LIBAOM_BLOCK_GOLDEN_MANIFEST: goldenManifest,
    AV1SCOPE_NATIVE_INSPECTION_WORKER: worker.path,
    AV1SCOPE_LIBAOM_EXPECTED_BUILD_ID: buildId,
  },
});
if (releaseManifestPath) {
  await run(process.execPath, [path.join(projectDirectory, "scripts/check-libaom-crash-replay.mjs")], {
    environment: {
      ...process.env,
      AV1SCOPE_LIBAOM_BUILD_MANIFEST: releaseManifestPath,
      AV1SCOPE_LIBAOM_BLOCK_GOLDEN_MANIFEST: goldenManifest,
      AV1SCOPE_REQUIRE_LIBAOM_PRODUCER: "1",
    },
  });
}
process.stdout.write(
  `Native Inspection Worker ready: ${worker.path}\nDevelopment receipt: ${receiptPath}\n`
  + (releaseManifestPath ? `Release manifest: ${releaseManifestPath}\n` : ""),
);
