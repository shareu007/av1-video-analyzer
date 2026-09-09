import { createHash } from "node:crypto";

import { stringifyCanonical } from "./json.js";

export const FFMPEG_BUILD_MANIFEST_KIND = "av1scope-ffmpeg-build-manifest";
export const FFMPEG_BUILD_MANIFEST_SCHEMA_VERSION = 1;
export const REQUIRED_FFMPEG_BUNDLE_LIBRARIES = Object.freeze([
  "libavcodec",
  "libavfilter",
  "libavformat",
  "libavutil",
  "libswscale",
  "zlib",
]);
export const FORBIDDEN_FFMPEG_CONFIGURE_FLAGS = Object.freeze([
  "--enable-gpl",
  "--enable-nonfree",
  "--enable-version3",
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const BUILD_ID = /^[0-9a-f]{40}$/u;
const BUNDLE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/u;
const REQUIRED_CONFIGURE_FLAGS = Object.freeze([
  "--disable-autodetect",
  "--disable-network",
  "--disable-static",
  "--enable-libaom",
  "--enable-shared",
  "--prefix=/av1scope-ffmpeg",
]);
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

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function text(value, name, maximum = 1_024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function stringArray(value, name, { maximumItems = 256, requireNonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems
      || (requireNonEmpty && value.length === 0)
      || value.some((item) => typeof item !== "string" || item.length < 1
        || item.length > 1_024)) {
    throw new TypeError(`${name} must be a bounded string array`);
  }
  return [...value];
}

function sortedUniqueStrings(value, name, options = {}) {
  const normalized = stringArray(value, name, options)
    .sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${name} must not contain duplicates`);
  }
  return normalized;
}

function commandArray(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new TypeError(`${name} must be a bounded non-empty argv array list`);
  }
  return value.map((command, index) => stringArray(
    command,
    `${name}[${index}]`,
    { maximumItems: 128, requireNonEmpty: true },
  ));
}

function fileReference(value, name) {
  const reference = object(value, name);
  const relativePath = text(reference.path, `${name}.path`, 512);
  if (!BUNDLE_PATH.test(relativePath)) {
    throw new TypeError(`${name}.path must be a safe relative bundle path`);
  }
  return { path: relativePath, sha256: digest(reference.sha256, `${name}.sha256`) };
}

function normalizeFeatures(value) {
  const features = object(value, "features");
  return Object.fromEntries(Object.entries(REQUIRED_FEATURES).map(([name, required]) => {
    const actual = sortedUniqueStrings(features[name], `features.${name}`, {
      maximumItems: 64,
      requireNonEmpty: true,
    });
    if (required.some((item) => !actual.includes(item))) {
      throw new TypeError(`features.${name} is missing a required AV1Scope capability`);
    }
    return [name, actual];
  }));
}

function normalizeInputs(value) {
  const manifest = object(value, "FFmpeg build manifest");
  const source = object(manifest.source, "source");
  const toolchain = object(manifest.toolchain, "toolchain");
  const build = object(manifest.build, "build");
  const dependencies = object(manifest.dependencies, "dependencies");
  const libaom = object(dependencies.libaom, "dependencies.libaom");
  const zlib = object(dependencies.zlib, "dependencies.zlib");
  if (typeof source.revision !== "string" || !REVISION.test(source.revision)) {
    throw new TypeError("source.revision must be a lowercase 40-hex commit");
  }
  if (!Number.isSafeInteger(build.sourceDateEpoch) || build.sourceDateEpoch < 0) {
    throw new TypeError("build.sourceDateEpoch must be a non-negative safe integer");
  }
  const configureFlags = sortedUniqueStrings(build.configureFlags, "build.configureFlags", {
    requireNonEmpty: true,
  });
  if (FORBIDDEN_FFMPEG_CONFIGURE_FLAGS.some((flag) => configureFlags.includes(flag))) {
    throw new TypeError("build.configureFlags enables forbidden FFmpeg licensing features");
  }
  if (REQUIRED_CONFIGURE_FLAGS.some((flag) => !configureFlags.includes(flag))) {
    throw new TypeError("build.configureFlags is missing a required release flag");
  }
  if (build.license !== "LGPL-2.1-or-later") {
    throw new TypeError("build.license must be LGPL-2.1-or-later");
  }
  if (typeof libaom.revision !== "string" || !REVISION.test(libaom.revision)
      || typeof libaom.buildId !== "string" || !BUILD_ID.test(libaom.buildId)) {
    throw new TypeError("dependencies.libaom revision/buildId is invalid");
  }
  return {
    source: {
      repository: text(source.repository, "source.repository"),
      version: text(source.version, "source.version", 64),
      tag: text(source.tag, "source.tag", 128),
      revision: source.revision,
      archive: fileReference(source.archive, "source.archive"),
    },
    toolchain: {
      compiler: text(toolchain.compiler, "toolchain.compiler", 256),
      compilerVersion: text(toolchain.compilerVersion, "toolchain.compilerVersion", 512),
      target: text(toolchain.target, "toolchain.target", 256),
    },
    build: {
      sourceDateEpoch: build.sourceDateEpoch,
      license: build.license,
      configureFlags,
      commands: commandArray(build.commands, "build.commands"),
    },
    dependencies: {
      libaom: {
        version: text(libaom.version, "dependencies.libaom.version", 64),
        revision: libaom.revision,
        buildId: libaom.buildId,
        librarySha256: digest(libaom.librarySha256, "dependencies.libaom.librarySha256"),
      },
      zlib: {
        version: text(zlib.version, "dependencies.zlib.version", 64),
        soname: text(zlib.soname, "dependencies.zlib.soname", 128),
        librarySha256: digest(zlib.librarySha256, "dependencies.zlib.librarySha256"),
      },
    },
    features: normalizeFeatures(manifest.features),
  };
}

export function computeFfmpegBuildId(manifest) {
  return createHash("sha256")
    .update(stringifyCanonical(normalizeInputs(manifest)))
    .digest("hex")
    .slice(0, 40);
}

export function computeFfmpegSbomSerialNumber(buildId) {
  if (typeof buildId !== "string" || !BUILD_ID.test(buildId)) {
    throw new TypeError("buildId must be a lowercase 40-hex digest");
  }
  const bytes = Buffer.from(createHash("sha256")
    .update(`av1scope-ffmpeg-bundle:${buildId}`)
    .digest()
    .subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `urn:uuid:${[
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-")}`;
}

function libraryArtifacts(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_FFMPEG_BUNDLE_LIBRARIES.length) {
    throw new TypeError("artifacts.libraries must contain every required bundle library");
  }
  const libraries = value.map((item, index) => {
    const library = object(item, `artifacts.libraries[${index}]`);
    return {
      name: text(library.name, `artifacts.libraries[${index}].name`, 128),
      version: text(library.version, `artifacts.libraries[${index}].version`, 128),
      soname: text(library.soname, `artifacts.libraries[${index}].soname`, 128),
      ...fileReference(library, `artifacts.libraries[${index}]`),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (libraries.some((library, index) =>
    library.name !== REQUIRED_FFMPEG_BUNDLE_LIBRARIES[index])) {
    throw new TypeError("artifacts.libraries has an unexpected name set");
  }
  return libraries;
}

export function validateFfmpegBuildManifest(value) {
  const manifest = object(value, "FFmpeg build manifest");
  if (manifest.schemaVersion !== FFMPEG_BUILD_MANIFEST_SCHEMA_VERSION
      || manifest.kind !== FFMPEG_BUILD_MANIFEST_KIND) {
    throw new TypeError("unsupported FFmpeg build manifest kind or schemaVersion");
  }
  const inputs = normalizeInputs(manifest);
  if (typeof manifest.buildId !== "string" || !BUILD_ID.test(manifest.buildId)
      || manifest.buildId !== computeFfmpegBuildId(inputs)) {
    throw new TypeError("buildId does not match the canonical pinned build inputs");
  }
  const artifacts = object(manifest.artifacts, "artifacts");
  const compliance = object(manifest.compliance, "compliance");
  const licenses = sortedUniqueStrings(compliance.licenses, "compliance.licenses", {
    maximumItems: 32,
    requireNonEmpty: true,
  });
  for (const required of [
    "BSD-2-Clause",
    "LGPL-2.1-or-later",
    "LicenseRef-AOM-Patent-License-1.0",
    "Zlib",
  ]) {
    if (!licenses.includes(required)) {
      throw new TypeError(`compliance.licenses is missing ${required}`);
    }
  }
  const normalized = {
    schemaVersion: FFMPEG_BUILD_MANIFEST_SCHEMA_VERSION,
    kind: FFMPEG_BUILD_MANIFEST_KIND,
    buildId: manifest.buildId,
    ...inputs,
    artifacts: {
      ffmpeg: fileReference(artifacts.ffmpeg, "artifacts.ffmpeg"),
      ffprobe: fileReference(artifacts.ffprobe, "artifacts.ffprobe"),
      demuxAdapter: fileReference(artifacts.demuxAdapter, "artifacts.demuxAdapter"),
      demuxWorker: fileReference(artifacts.demuxWorker, "artifacts.demuxWorker"),
      libraries: libraryArtifacts(artifacts.libraries),
    },
    compliance: {
      licenses,
      bundleInventory: fileReference(
        compliance.bundleInventory,
        "compliance.bundleInventory",
      ),
      licenseInventory: fileReference(
        compliance.licenseInventory,
        "compliance.licenseInventory",
      ),
      sbom: fileReference(compliance.sbom, "compliance.sbom"),
    },
  };
  return {
    manifest: normalized,
    manifestSha256: createHash("sha256").update(stringifyCanonical(normalized)).digest("hex"),
  };
}
