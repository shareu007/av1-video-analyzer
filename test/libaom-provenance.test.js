import assert from "node:assert/strict";
import test from "node:test";

import {
  computeLibaomBuildId,
  REQUIRED_LIBAOM_INSPECTION_FEATURES,
  validateLibaomBuildManifest,
} from "../src/libaom-provenance.js";

const digest = (value) => value.repeat(64);

function manifest() {
  const value = {
    schemaVersion: 2,
    kind: "av1scope-libaom-build-manifest",
    source: {
      repository: "https://aomedia.googlesource.com/aom",
      version: "3.12.1",
      revision: "1".repeat(40),
      archiveSha256: digest("2"),
    },
    patch: {
      revision: "av1scope-inspection-v1",
      patchSetSha256: digest("3"),
      producerSha256: digest("9"),
      file: { path: "compliance/libaom-inspection.patch", sha256: digest("3") },
    },
    toolchain: { compiler: "clang", compilerVersion: "clang 19.1.0", target: "x86_64-linux-gnu" },
    build: {
      sourceDateEpoch: 1_700_000_000,
      commands: [
        ["cmake", "-S", "${LIBAOM_SOURCE}", "-B", "${LIBAOM_BUILD}"],
        ["cmake", "--build", "${LIBAOM_BUILD}", "--target", "aom"],
      ],
      cflags: ["-O2", "-fPIC"],
      features: [...REQUIRED_LIBAOM_INSPECTION_FEATURES].reverse(),
    },
    artifacts: {
      patchLibrary: { path: "libpatch.a", sha256: digest("4") },
      inspectionAdapter: { path: "libinspection.so", sha256: digest("5") },
      inspectionWorker: { path: "inspection-worker", sha256: digest("6") },
    },
    compliance: {
      licenses: ["LicenseRef-AOM-Patent-License-1.0", "BSD-2-Clause"],
      licenseInventory: { path: "compliance/licenses.json", sha256: digest("7") },
      sbom: { path: "compliance/sbom.cdx.json", sha256: digest("8") },
    },
  };
  value.buildId = computeLibaomBuildId(value);
  return value;
}

test("libaom build manifest binds reproducible inputs, artifacts and compliance", () => {
  const value = manifest();
  const result = validateLibaomBuildManifest(value);
  assert.match(value.buildId, /^[0-9a-f]{40}$/u);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.manifest.build.features, REQUIRED_LIBAOM_INSPECTION_FEATURES);
  assert.equal(computeLibaomBuildId({ ...value, artifacts: {
    ...value.artifacts,
    patchLibrary: { ...value.artifacts.patchLibrary, sha256: digest("9") },
  } }), value.buildId);
});

test("libaom build manifest rejects incomplete features and artifact drift", () => {
  const incomplete = manifest();
  incomplete.build.features.pop();
  assert.throws(() => validateLibaomBuildManifest(incomplete), /every required/u);
  const drifted = manifest();
  drifted.build.cflags.push("-DNDEBUG");
  assert.throws(() => validateLibaomBuildManifest(drifted), /buildId/u);
  const missingSbom = manifest();
  delete missingSbom.compliance.sbom;
  assert.throws(() => validateLibaomBuildManifest(missingSbom), /compliance\.sbom/u);
  const traversal = manifest();
  traversal.artifacts.inspectionWorker.path = "../inspection-worker";
  assert.throws(() => validateLibaomBuildManifest(traversal), /safe relative/u);
});
