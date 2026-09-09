import { createHash } from "node:crypto";

import { stringifyCanonical } from "./json.js";

export const LIBAOM_BUILD_MANIFEST_KIND = "av1scope-libaom-build-manifest";
export const LIBAOM_BUILD_MANIFEST_SCHEMA_VERSION = 2;
export const REQUIRED_LIBAOM_INSPECTION_FEATURES = Object.freeze([
  "coefficient",
  "filter",
  "mode",
  "motionVector",
  "partition",
  "qindex",
  "transform",
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const REVISION = /^[0-9a-f]{40,64}$/u;
const BUILD_ID = /^[0-9a-f]{40}$/u;
const BUNDLE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/u;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function text(value, name, maximum = 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maximum} bytes`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function stringArray(value, name, { maximumItems = 256 } = {}) {
  if (!Array.isArray(value) || value.length > maximumItems
      || value.some((item) => typeof item !== "string" || item.length > 1024)) {
    throw new TypeError(`${name} must be a bounded string array`);
  }
  return [...value];
}

function commandArray(value, name) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    throw new TypeError(`${name} must be a bounded non-empty argv array list`);
  }
  return value.map((command, index) => {
    const normalized = stringArray(command, `${name}[${index}]`, { maximumItems: 128 });
    if (normalized.length < 1 || normalized.some((item) => item.length < 1)) {
      throw new TypeError(`${name}[${index}] must contain non-empty argv strings`);
    }
    return normalized;
  });
}

function fileReference(value, name) {
  const reference = object(value, name);
  const relativePath = text(reference.path, `${name}.path`, 512);
  if (!BUNDLE_PATH.test(relativePath)) {
    throw new TypeError(`${name}.path must be a safe relative bundle path`);
  }
  return {
    path: relativePath,
    sha256: digest(reference.sha256, `${name}.sha256`),
  };
}

function normalizeBuildInputs(value) {
  const manifest = object(value, "libaom build manifest");
  const source = object(manifest.source, "source");
  const patch = object(manifest.patch, "patch");
  const toolchain = object(manifest.toolchain, "toolchain");
  const build = object(manifest.build, "build");
  if (typeof source.revision !== "string" || !REVISION.test(source.revision)) {
    throw new TypeError("source.revision must be a lowercase 40..64 hex revision");
  }
  const features = stringArray(build.features, "build.features", { maximumItems: 32 })
    .sort((left, right) => left.localeCompare(right));
  if (new Set(features).size !== features.length
      || features.length !== REQUIRED_LIBAOM_INSPECTION_FEATURES.length
      || features.some((feature, index) => feature !== REQUIRED_LIBAOM_INSPECTION_FEATURES[index])) {
    throw new TypeError("build.features must contain every required inspection feature exactly once");
  }
  if (!Number.isSafeInteger(build.sourceDateEpoch) || build.sourceDateEpoch < 0) {
    throw new TypeError("build.sourceDateEpoch must be a non-negative safe integer");
  }
  return {
    source: {
      repository: text(source.repository, "source.repository"),
      version: text(source.version, "source.version", 64),
      revision: source.revision,
      archiveSha256: digest(source.archiveSha256, "source.archiveSha256"),
    },
    patch: {
      revision: text(patch.revision, "patch.revision", 256),
      patchSetSha256: digest(patch.patchSetSha256, "patch.patchSetSha256"),
      producerSha256: digest(patch.producerSha256, "patch.producerSha256"),
      file: fileReference(patch.file, "patch.file"),
    },
    toolchain: {
      compiler: text(toolchain.compiler, "toolchain.compiler", 256),
      compilerVersion: text(toolchain.compilerVersion, "toolchain.compilerVersion", 512),
      target: text(toolchain.target, "toolchain.target", 256),
    },
    build: {
      sourceDateEpoch: build.sourceDateEpoch,
      commands: commandArray(build.commands, "build.commands"),
      cflags: stringArray(build.cflags, "build.cflags"),
      features,
    },
  };
}

export function computeLibaomBuildId(manifest) {
  return createHash("sha256")
    .update(stringifyCanonical(normalizeBuildInputs(manifest)))
    .digest("hex")
    .slice(0, 40);
}

export function validateLibaomBuildManifest(value) {
  const manifest = object(value, "libaom build manifest");
  if (manifest.schemaVersion !== LIBAOM_BUILD_MANIFEST_SCHEMA_VERSION
      || manifest.kind !== LIBAOM_BUILD_MANIFEST_KIND) {
    throw new TypeError("unsupported libaom build manifest kind or schemaVersion");
  }
  const inputs = normalizeBuildInputs(manifest);
  if (typeof manifest.buildId !== "string" || !BUILD_ID.test(manifest.buildId)
      || manifest.buildId !== computeLibaomBuildId(inputs)) {
    throw new TypeError("buildId does not match the canonical pinned build inputs");
  }
  const artifacts = object(manifest.artifacts, "artifacts");
  const compliance = object(manifest.compliance, "compliance");
  const licenses = stringArray(compliance.licenses, "compliance.licenses", { maximumItems: 32 })
    .sort((left, right) => left.localeCompare(right));
  if (!licenses.includes("BSD-2-Clause")
      || !licenses.includes("LicenseRef-AOM-Patent-License-1.0")) {
    throw new TypeError(
      "compliance.licenses must include BSD-2-Clause and the AOM patent license",
    );
  }
  const normalized = {
    schemaVersion: LIBAOM_BUILD_MANIFEST_SCHEMA_VERSION,
    kind: LIBAOM_BUILD_MANIFEST_KIND,
    buildId: manifest.buildId,
    ...inputs,
    artifacts: {
      patchLibrary: fileReference(artifacts.patchLibrary, "artifacts.patchLibrary"),
      inspectionAdapter: fileReference(artifacts.inspectionAdapter, "artifacts.inspectionAdapter"),
      inspectionWorker: fileReference(artifacts.inspectionWorker, "artifacts.inspectionWorker"),
    },
    compliance: {
      licenses,
      licenseInventory: fileReference(
        compliance.licenseInventory, "compliance.licenseInventory",
      ),
      sbom: fileReference(compliance.sbom, "compliance.sbom"),
    },
  };
  return {
    manifest: normalized,
    manifestSha256: createHash("sha256").update(stringifyCanonical(normalized)).digest("hex"),
  };
}
