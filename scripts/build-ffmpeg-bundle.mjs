import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir as systemTemporaryDirectory } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  computeFfmpegBuildId,
  computeFfmpegSbomSerialNumber,
  validateFfmpegBuildManifest,
} from "../src/ffmpeg-provenance.js";
import { stringifyCanonical } from "../src/json.js";
import { validateLibaomBuildManifest } from "../src/libaom-provenance.js";
import { demuxBufferInNativeWorker } from "../src/native-demux-worker.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG_VERSION = "7.1.5";
const FFMPEG_TAG = "n7.1.5";
const FFMPEG_REVISION = "3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587";
const FFMPEG_ARCHIVE_SHA256 = "fc35344b0123807409a8cedaed5b1d74df43bd1732e2e4af4b3639b5acdf959e";
const FFMPEG_REPOSITORY = "https://github.com/FFmpeg/FFmpeg.git";
const VIRTUAL_PREFIX = "/av1scope-ffmpeg";
const REQUIRED_FEATURES = Object.freeze({
  bsfs: Object.freeze(["trace_headers"]),
  decoders: Object.freeze(["libaom_av1"]),
  demuxers: Object.freeze(["av1", "ivf", "matroska", "mov"]),
  encoders: Object.freeze(["png", "rawvideo"]),
  filters: Object.freeze(["format", "scale", "select"]),
  muxers: Object.freeze(["image2", "image2pipe", "null", "rawvideo"]),
  parsers: Object.freeze(["av1"]),
  protocols: Object.freeze(["file", "pipe"]),
});

function parseArguments(argv) {
  const defaults = {
    repository: process.env.AV1SCOPE_FFMPEG_REPOSITORY ?? null,
    output: path.join(PROJECT_ROOT, "build", "ffmpeg-v7.1.5-release"),
    jobs: 4,
    libaomManifest: path.join(
      PROJECT_ROOT, "build", "native-v3.12.1-golden", "libaom-build-manifest.json",
    ),
    libaomReceipt: path.join(
      PROJECT_ROOT, "build", "native-v3.12.1-golden", "libaom-development-receipt.json",
    ),
    libaomLibrary: path.join(PROJECT_ROOT, "build", "libaom-v3.12.1-golden", "libaom.a"),
    libaomSource: path.join(
      PROJECT_ROOT, "build", "libaom-patched-10aece4157eb-6520bcabf22a",
    ),
    zlibLicense: "/usr/share/doc/zlib1g/copyright",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name.startsWith("--") || value === undefined) {
      throw new TypeError(`invalid FFmpeg bundle argument: ${name}`);
    }
    index += 1;
    if (name === "--repository") defaults.repository = value;
    else if (name === "--output") defaults.output = value;
    else if (name === "--jobs") defaults.jobs = Number(value);
    else if (name === "--libaom-manifest") defaults.libaomManifest = value;
    else if (name === "--libaom-receipt") defaults.libaomReceipt = value;
    else if (name === "--libaom-library") defaults.libaomLibrary = value;
    else if (name === "--libaom-source") defaults.libaomSource = value;
    else if (name === "--zlib-license") defaults.zlibLicense = value;
    else throw new TypeError(`unknown FFmpeg bundle argument: ${name}`);
  }
  if (typeof defaults.repository !== "string" || defaults.repository.length === 0) {
    throw new TypeError("--repository or AV1SCOPE_FFMPEG_REPOSITORY is required");
  }
  if (!Number.isSafeInteger(defaults.jobs) || defaults.jobs < 1 || defaults.jobs > 64) {
    throw new RangeError("--jobs must be between 1 and 64");
  }
  const output = path.resolve(defaults.output);
  const buildRoot = path.join(PROJECT_ROOT, "build");
  if (!output.startsWith(`${buildRoot}${path.sep}`) || output === buildRoot) {
    throw new Error("FFmpeg bundle output must be a child of the project build directory");
  }
  return {
    ...defaults,
    repository: path.resolve(defaults.repository),
    output,
    libaomManifest: path.resolve(defaults.libaomManifest),
    libaomReceipt: path.resolve(defaults.libaomReceipt),
    libaomLibrary: path.resolve(defaults.libaomLibrary),
    libaomSource: path.resolve(defaults.libaomSource),
    zlibLicense: path.resolve(defaults.zlibLicense),
  };
}

function waitForChild(child, label) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`${label} failed with code=${code} signal=${signal}`));
    });
  });
}

async function run(command, args, { cwd = PROJECT_ROOT, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  await waitForChild(child, `${command} ${args.join(" ")}`);
}

async function capture(command, args, { cwd = PROJECT_ROOT, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= 16 * 1024 * 1024) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 16 * 1024 * 1024) stderr.push(chunk);
  });
  try {
    await waitForChild(child, `${command} ${args.join(" ")}`);
  } catch (error) {
    error.message += `\n${Buffer.concat(stderr).toString("utf8")}`;
    throw error;
  }
  if (stdoutBytes > 16 * 1024 * 1024 || stderrBytes > 16 * 1024 * 1024) {
    throw new Error(`${command} output exceeded its capture budget`);
  }
  return Buffer.concat(stdout).toString("utf8").trim();
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

async function sha256File(target) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  return digest.digest("hex");
}

async function writeCanonical(target, value) {
  const contents = stringifyCanonical(value);
  await writeFile(target, contents, { encoding: "utf8", flag: "wx" });
  return createHash("sha256").update(contents).digest("hex");
}

function relativeBundlePath(bundleRoot, target) {
  const relative = path.relative(bundleRoot, target).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`bundle artifact escapes root: ${target}`);
  }
  return relative;
}

async function fileReference(bundleRoot, target) {
  return { path: relativeBundlePath(bundleRoot, target), sha256: await sha256File(target) };
}

async function archiveSource(repository, archivePath) {
  const child = spawn(
    "git",
    ["-C", repository, "archive", "--format=tar", FFMPEG_REVISION],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const digest = createHash("sha256");
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await Promise.all([
    pipeline(child.stdout, hashingStream, createWriteStream(archivePath, { flags: "wx" })),
    waitForChild(child, "git archive"),
  ]);
  return digest.digest("hex");
}

function pkgConfigFile(libraryDirectory, sourceDirectory) {
  return [
    `prefix=${libraryDirectory}`,
    "libdir=${prefix}",
    `includedir=${sourceDirectory}`,
    "",
    "Name: aom",
    "Description: Alliance for Open Media AV1 codec",
    "Version: 3.12.1",
    "Libs: -L${libdir} -laom",
    "Libs.private: -lm -lpthread",
    "Cflags: -I${includedir}",
    "",
  ].join("\n");
}

async function versionedLibrary(bundleRoot, name) {
  const directory = path.join(bundleRoot, "lib");
  const prefix = `${name}.so.`;
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    if (!/^\d+(?:\.\d+)+$/u.test(suffix)) continue;
    entries.push({ target: path.join(directory, entry.name), version: suffix });
  }
  if (entries.length !== 1) throw new Error(`expected one versioned ${name} library`);
  const major = entries[0].version.split(".")[0];
  return {
    name,
    version: entries[0].version,
    soname: `${name}.so.${major}`,
    ...(await fileReference(bundleRoot, entries[0].target)),
  };
}

async function createBundleInventory(bundleRoot, buildId, excludedPaths) {
  const excluded = new Set(excludedPaths);
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = relativeBundlePath(bundleRoot, absolute);
      if (excluded.has(relative)) continue;
      if (child.isDirectory()) {
        await visit(absolute);
      } else if (child.isFile()) {
        const metadata = await lstat(absolute);
        entries.push({
          path: relative,
          type: "file",
          size: metadata.size,
          sha256: await sha256File(absolute),
        });
      } else if (child.isSymbolicLink()) {
        const target = await readlink(absolute);
        const resolvedTarget = path.resolve(path.dirname(absolute), target);
        if (!resolvedTarget.startsWith(`${bundleRoot}${path.sep}`)) {
          throw new Error(`bundle symlink escapes root: ${relative} -> ${target}`);
        }
        entries.push({ path: relative, type: "symlink", target });
      } else {
        throw new Error(`unsupported bundle entry type: ${relative}`);
      }
    }
  }
  await visit(bundleRoot);
  return {
    schemaVersion: 1,
    kind: "av1scope-ffmpeg-bundle-inventory",
    buildId,
    excluded: [...excluded].sort((left, right) => left.localeCompare(right)),
    entries,
  };
}

async function copyComplianceFile(source, destination) {
  await copyFile(source, destination);
  return sha256File(destination);
}

async function spawnWithInput(command, args, input) {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  child.stdout.on("data", (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= 16 * 1024 * 1024) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(input);
  try {
    await waitForChild(child, command);
  } catch (error) {
    error.message += `\n${Buffer.concat(stderr).toString("utf8")}`;
    throw error;
  }
  if (outputBytes > 16 * 1024 * 1024) throw new Error(`${command} smoke output exceeded budget`);
  return Buffer.concat(stdout);
}

async function smokeBundle(bundleRoot) {
  const encoded = (await readFile(
    path.join(PROJECT_ROOT, "test", "fixtures", "libaom-v3.12.1", "motion-compound.ivf.base64"),
    "ascii",
  )).replaceAll(/\s/gu, "");
  const input = Buffer.from(encoded, "base64");
  assert.equal(input.toString("base64"), encoded, "FFmpeg smoke fixture must be canonical base64");
  const ffmpeg = path.join(bundleRoot, "bin", "ffmpeg");
  const preview = await spawnWithInput(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
    "-vf", "select=eq(n\\,0),scale=64:-1", "-frames:v", "1",
    "-f", "image2pipe", "-vcodec", "png", "pipe:1",
  ], input);
  assert.deepEqual([...preview.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const demux = await demuxBufferInNativeWorker(input, {
    executable: path.join(bundleRoot, "bin", "av1scope_ffmpeg_demux_worker"),
  });
  assert.equal(demux.stream.width, 128);
  assert.equal(demux.stream.height, 96);
  assert.equal(demux.samples.length, 24);
  return { previewBytes: preview.length, sampleCount: demux.samples.length };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (await exists(options.output)) {
    throw new Error(`FFmpeg bundle output already exists: ${options.output}`);
  }
  const repositoryRevision = await capture(
    "git", ["-C", options.repository, "rev-parse", `${FFMPEG_TAG}^{}`],
  );
  assert.equal(repositoryRevision, FFMPEG_REVISION, "FFmpeg tag does not resolve to pinned commit");
  const repositoryRemote = await capture(
    "git", ["-C", options.repository, "remote", "get-url", "origin"],
  );
  assert.ok(
    [FFMPEG_REPOSITORY, "https://github.com/FFmpeg/FFmpeg"].includes(repositoryRemote),
    "FFmpeg source repository origin is not the pinned upstream",
  );

  const libaomRelease = validateLibaomBuildManifest(
    JSON.parse(await readFile(options.libaomManifest, "utf8")),
  ).manifest;
  const libaomReceipt = JSON.parse(await readFile(options.libaomReceipt, "utf8"));
  assert.equal(libaomReceipt.kind, "av1scope-libaom-development-build-receipt");
  assert.equal(libaomReceipt.buildId, libaomRelease.buildId);
  assert.equal(await sha256File(options.libaomLibrary), libaomReceipt.artifacts.libaomSha256);
  await access(path.join(options.libaomSource, "aom", "aom_codec.h"));

  const temporaryRoot = path.join(
    systemTemporaryDirectory(),
    `.ffmpeg-bundle.${process.pid}.${randomUUID()}.tmp`,
  );
  const publicationRoot = path.join(
    path.dirname(options.output),
    `.ffmpeg-bundle.publish.${process.pid}.${randomUUID()}.tmp`,
  );
  const sourceDirectory = path.join(temporaryRoot, "source");
  const workDirectory = path.join(temporaryRoot, "work");
  const nativeBuildDirectory = path.join(temporaryRoot, "native-build");
  const stagingRoot = path.join(temporaryRoot, "stage");
  const bundleRoot = path.join(stagingRoot, VIRTUAL_PREFIX.slice(1));
  const sourceArchive = path.join(bundleRoot, "sources", `ffmpeg-${FFMPEG_TAG}.tar`);
  try {
    await mkdir(path.dirname(sourceArchive), { recursive: true });
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(workDirectory, { recursive: true });
    const archiveSha256 = await archiveSource(options.repository, sourceArchive);
    assert.equal(archiveSha256, FFMPEG_ARCHIVE_SHA256, "FFmpeg source archive digest mismatch");
    await run("tar", ["-xf", sourceArchive, "-C", sourceDirectory]);

    const pkgConfigDirectory = path.join(temporaryRoot, "pkgconfig");
    await mkdir(pkgConfigDirectory);
    await writeFile(
      path.join(pkgConfigDirectory, "aom.pc"),
      pkgConfigFile(path.dirname(options.libaomLibrary), options.libaomSource),
      { encoding: "utf8", flag: "wx" },
    );
    const configureFlags = [
      `--prefix=${VIRTUAL_PREFIX}`,
      "--disable-static", "--enable-shared", "--disable-autodetect", "--disable-doc",
      "--disable-debug", "--disable-network", "--disable-x86asm", "--disable-avdevice",
      "--disable-swresample", "--disable-postproc", "--disable-everything",
      "--enable-avformat", "--enable-avcodec", "--enable-avutil", "--enable-avfilter",
      "--enable-swscale", "--enable-ffmpeg", "--enable-ffprobe",
      `--enable-demuxer=${REQUIRED_FEATURES.demuxers.join(",")}`,
      "--enable-libaom", `--enable-decoder=${REQUIRED_FEATURES.decoders.join(",")}`,
      `--enable-encoder=${REQUIRED_FEATURES.encoders.join(",")}`,
      `--enable-muxer=${REQUIRED_FEATURES.muxers.join(",")}`,
      `--enable-parser=${REQUIRED_FEATURES.parsers.join(",")}`,
      `--enable-protocol=${REQUIRED_FEATURES.protocols.join(",")}`,
      `--enable-filter=${REQUIRED_FEATURES.filters.join(",")}`,
      `--enable-bsf=${REQUIRED_FEATURES.bsfs.join(",")}`,
      "--enable-zlib", "--enable-pthreads", "--enable-pic",
    ];
    const configureArgv = [
      ...configureFlags,
      String.raw`--extra-ldexeflags=-Wl,-rpath,\\\$\$ORIGIN/../lib`,
      String.raw`--extra-ldsoflags=-Wl,-rpath,\\\$\$\$\$ORIGIN`,
    ];
    const sourceDateEpoch = Number(await capture(
      "git", ["-C", options.repository, "show", "-s", "--format=%ct", FFMPEG_REVISION],
    ));
    const buildEnvironment = {
      ...process.env,
      PKG_CONFIG_PATH: pkgConfigDirectory,
      SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    };
    await run(path.join(sourceDirectory, "configure"), configureArgv, {
      cwd: workDirectory,
      env: buildEnvironment,
    });
    await run("make", [`-j${options.jobs}`], { cwd: workDirectory, env: buildEnvironment });
    await run("make", ["install", `DESTDIR=${stagingRoot}`], {
      cwd: workDirectory,
      env: buildEnvironment,
    });

    const zlibVersion = await capture("pkg-config", ["--modversion", "zlib"]);
    const zlibDirectory = await capture("pkg-config", ["--variable=libdir", "zlib"]);
    const zlibSource = await realpath(path.join(zlibDirectory, "libz.so.1"));
    const zlibDestination = path.join(bundleRoot, "lib", path.basename(zlibSource));
    await copyFile(zlibSource, zlibDestination);
    await symlink(path.basename(zlibSource), path.join(bundleRoot, "lib", "libz.so.1"));

    const nativeEnvironment = {
      ...buildEnvironment,
      PKG_CONFIG_PATH: path.join(bundleRoot, "lib", "pkgconfig"),
      PKG_CONFIG_SYSROOT_DIR: stagingRoot,
    };
    await run("cmake", [
      "-S", path.join(PROJECT_ROOT, "native"),
      "-B", nativeBuildDirectory,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_INSTALL_PREFIX=${VIRTUAL_PREFIX}`,
    ], { env: nativeEnvironment });
    await run("cmake", [
      "--build", nativeBuildDirectory, "--config", "Release",
      "--target", "av1scope_ffmpeg_demux_worker", "--parallel", String(options.jobs),
    ], { env: nativeEnvironment });
    await run("cmake", ["--install", nativeBuildDirectory, "--config", "Release"], {
      env: { ...nativeEnvironment, DESTDIR: stagingRoot },
    });

    await rm(path.join(bundleRoot, "include"), { recursive: true, force: true });
    await rm(path.join(bundleRoot, "share"), { recursive: true, force: true });
    await rm(path.join(bundleRoot, "lib", "pkgconfig"), { recursive: true, force: true });

    const compilerVersion = (await capture("cc", ["--version"])).split(/\r?\n/u)[0];
    const toolchain = {
      compiler: "cc",
      compilerVersion,
      target: await capture("cc", ["-dumpmachine"]),
    };
    const source = {
      repository: FFMPEG_REPOSITORY,
      version: FFMPEG_VERSION,
      tag: FFMPEG_TAG,
      revision: FFMPEG_REVISION,
      archive: { path: relativeBundlePath(bundleRoot, sourceArchive), sha256: archiveSha256 },
    };
    const build = {
      sourceDateEpoch,
      license: "LGPL-2.1-or-later",
      configureFlags: [
        ...configureFlags,
        "--extra-ldexeflags=-Wl,-rpath,$ORIGIN/../lib",
        "--extra-ldsoflags=-Wl,-rpath,$ORIGIN",
      ],
      commands: [
        ["git", "archive", "${FFMPEG_REVISION}"],
        ["configure", "${CONFIGURE_FLAGS}"],
        ["make", "-j${JOBS}"],
        ["make", "install", "DESTDIR=${STAGE}"],
        ["cmake", "--build", "${NATIVE_BUILD}", "--target", "av1scope_ffmpeg_demux_worker"],
        ["cmake", "--install", "${NATIVE_BUILD}", "DESTDIR=${STAGE}"],
      ],
    };
    const dependencies = {
      libaom: {
        version: libaomRelease.source.version,
        revision: libaomRelease.source.revision,
        buildId: libaomRelease.buildId,
        librarySha256: libaomReceipt.artifacts.libaomSha256,
      },
      zlib: {
        version: zlibVersion,
        soname: "libz.so.1",
        librarySha256: await sha256File(zlibDestination),
      },
    };
    const features = Object.fromEntries(
      Object.entries(REQUIRED_FEATURES).map(([name, values]) => [name, [...values]]),
    );
    const buildId = computeFfmpegBuildId({ source, toolchain, build, dependencies, features });

    const complianceDirectory = path.join(bundleRoot, "compliance");
    const licenseDirectory = path.join(complianceDirectory, "licenses");
    await mkdir(licenseDirectory, { recursive: true });
    const licenseInputs = [
      ["FFmpeg", "LGPL-2.1-or-later", path.join(sourceDirectory, "COPYING.LGPLv2.1"),
        "ffmpeg-COPYING.LGPLv2.1.txt"],
      ["FFmpeg", "LicenseRef-FFmpeg-License-Overview", path.join(sourceDirectory, "LICENSE.md"),
        "ffmpeg-LICENSE.md"],
      ["libaom", "BSD-2-Clause", path.join(
        path.dirname(options.libaomManifest), "compliance", "licenses", "libaom-LICENSE.txt",
      ), "libaom-LICENSE.txt"],
      ["libaom", "LicenseRef-AOM-Patent-License-1.0", path.join(
        path.dirname(options.libaomManifest), "compliance", "licenses", "libaom-PATENTS.txt",
      ), "libaom-PATENTS.txt"],
      ["zlib", "Zlib", options.zlibLicense, "zlib-LICENSE.txt"],
    ];
    const licenseEntries = [];
    for (const [component, license, input, name] of licenseInputs) {
      const destination = path.join(licenseDirectory, name);
      licenseEntries.push({
        component,
        license,
        path: relativeBundlePath(bundleRoot, destination),
        sha256: await copyComplianceFile(input, destination),
      });
    }
    const noticePath = path.join(licenseDirectory, "av1scope-native-NOTICE.txt");
    await writeFile(noticePath, [
      "AV1Scope native demux adapter and worker",
      "",
      "Project-owned integration code; outbound project license approval is tracked separately.",
      "This dependency bundle manifest is an engineering supply-chain gate, not legal advice.",
      "",
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    licenseEntries.push({
      component: "AV1Scope native demux",
      license: "LicenseRef-AV1Scope-Project-License-Pending",
      ...(await fileReference(bundleRoot, noticePath)),
    });

    const licenseInventory = {
      schemaVersion: 1,
      kind: "av1scope-ffmpeg-license-inventory",
      buildId,
      entries: licenseEntries.sort((left, right) => left.path.localeCompare(right.path)),
      platformRuntime: ["glibc", "libm"],
      legalReviewRequired: true,
    };
    const licenseInventoryPath = path.join(complianceDirectory, "license-inventory.json");
    const licenseInventorySha256 = await writeCanonical(
      licenseInventoryPath,
      licenseInventory,
    );

    const libraryArtifacts = await Promise.all([
      versionedLibrary(bundleRoot, "libavcodec"),
      versionedLibrary(bundleRoot, "libavfilter"),
      versionedLibrary(bundleRoot, "libavformat"),
      versionedLibrary(bundleRoot, "libavutil"),
      versionedLibrary(bundleRoot, "libswscale"),
      Promise.resolve({
        name: "zlib",
        version: zlibVersion,
        soname: "libz.so.1",
        ...(await fileReference(bundleRoot, zlibDestination)),
      }),
    ]);
    const artifacts = {
      ffmpeg: await fileReference(bundleRoot, path.join(bundleRoot, "bin", "ffmpeg")),
      ffprobe: await fileReference(bundleRoot, path.join(bundleRoot, "bin", "ffprobe")),
      demuxAdapter: await fileReference(
        bundleRoot, path.join(bundleRoot, "lib", "libav1scope_ffmpeg_demux.so"),
      ),
      demuxWorker: await fileReference(
        bundleRoot, path.join(bundleRoot, "bin", "av1scope_ffmpeg_demux_worker"),
      ),
      libraries: libraryArtifacts.sort((left, right) => left.name.localeCompare(right.name)),
    };
    const component = (name, version, license, hash) => ({
      type: "library",
      name,
      version,
      licenses: [{ license: { id: license } }],
      hashes: [{ alg: "SHA-256", content: hash }],
    });
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: computeFfmpegSbomSerialNumber(buildId),
      version: 1,
      metadata: {
        timestamp: new Date(sourceDateEpoch * 1_000).toISOString(),
        component: { type: "application", name: "av1scope-ffmpeg-bundle", version: buildId },
      },
      components: [
        component("FFmpeg", FFMPEG_VERSION, "LGPL-2.1-or-later", archiveSha256),
        component(
          "libaom", libaomRelease.source.version, "BSD-2-Clause",
          libaomReceipt.artifacts.libaomSha256,
        ),
        component("zlib", zlibVersion, "Zlib", dependencies.zlib.librarySha256),
        component(
          "av1scope-native-demux", "0.1.0",
          "LicenseRef-AV1Scope-Project-License-Pending", artifacts.demuxWorker.sha256,
        ),
      ],
    };
    const sbomPath = path.join(complianceDirectory, "sbom.cdx.json");
    const sbomSha256 = await writeCanonical(sbomPath, sbom);
    const bundleInventoryPath = path.join(complianceDirectory, "bundle-inventory.json");
    const bundleInventory = await createBundleInventory(bundleRoot, buildId, [
      "compliance/bundle-inventory.json",
      "ffmpeg-build-manifest.json",
    ]);
    const bundleInventorySha256 = await writeCanonical(bundleInventoryPath, bundleInventory);
    const manifest = {
      schemaVersion: 1,
      kind: "av1scope-ffmpeg-build-manifest",
      buildId,
      source,
      toolchain,
      build,
      dependencies,
      features,
      artifacts,
      compliance: {
        licenses: [
          "BSD-2-Clause",
          "LGPL-2.1-or-later",
          "LicenseRef-AOM-Patent-License-1.0",
          "LicenseRef-AV1Scope-Project-License-Pending",
          "Zlib",
        ],
        bundleInventory: {
          path: relativeBundlePath(bundleRoot, bundleInventoryPath),
          sha256: bundleInventorySha256,
        },
        licenseInventory: {
          path: relativeBundlePath(bundleRoot, licenseInventoryPath),
          sha256: licenseInventorySha256,
        },
        sbom: { path: relativeBundlePath(bundleRoot, sbomPath), sha256: sbomSha256 },
      },
    };
    const validatedManifest = validateFfmpegBuildManifest(manifest).manifest;
    const manifestPath = path.join(bundleRoot, "ffmpeg-build-manifest.json");
    const manifestSha256 = await writeCanonical(manifestPath, validatedManifest);
    const smoke = await smokeBundle(bundleRoot);
    await cp(bundleRoot, publicationRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    await rename(publicationRoot, options.output);
    process.stdout.write(`${stringifyCanonical({
      schemaVersion: 1,
      kind: "av1scope-ffmpeg-bundle-build-receipt",
      buildId,
      manifestSha256,
      output: options.output,
      smoke,
    })}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(publicationRoot, { recursive: true, force: true });
  }
}

await main();
