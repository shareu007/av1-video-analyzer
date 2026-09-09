import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { validateLibaomBuildManifest } from "../src/libaom-provenance.js";

const manifestPath = process.env.AV1SCOPE_LIBAOM_BUILD_MANIFEST;
if (!manifestPath) {
  if (process.env.AV1SCOPE_REQUIRE_LIBAOM_PRODUCER === "1") {
    assert.fail("libaom producer release gate requires AV1SCOPE_LIBAOM_BUILD_MANIFEST");
  }
  process.stdout.write("libaom producer provenance blocked: fixed fork/build manifest not configured\n");
  process.exit(0);
}

const resolvedManifestPath = path.resolve(manifestPath);
const bundleRoot = path.dirname(resolvedManifestPath);
const realBundleRoot = await realpath(bundleRoot);
const readBundleFile = async (reference, label, maximumBytes = 128 * 1024 * 1024) => {
  const target = path.resolve(bundleRoot, reference.path);
  assert.ok(
    target.startsWith(`${bundleRoot}${path.sep}`),
    `${label} escapes the libaom release bundle`,
  );
  const metadata = await lstat(target);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), `${label} must be a regular file`);
  assert.ok(metadata.size <= maximumBytes, `${label} exceeds ${maximumBytes} bytes`);
  const realTarget = await realpath(target);
  assert.ok(
    realTarget.startsWith(`${realBundleRoot}${path.sep}`),
    `${label} resolves outside the libaom release bundle`,
  );
  const bytes = await readFile(realTarget);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    reference.sha256,
    `${label} SHA-256 mismatch`,
  );
  return bytes;
};

const input = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
const { manifest, manifestSha256 } = validateLibaomBuildManifest(input);
assert.equal(manifest.patch.file.sha256, manifest.patch.patchSetSha256);
await readBundleFile(manifest.patch.file, "inspection patch", 4 * 1024 * 1024);
for (const [name, reference] of Object.entries(manifest.artifacts)) {
  await readBundleFile(reference, `artifact ${name}`);
}
const inventoryBytes = await readBundleFile(
  manifest.compliance.licenseInventory, "license inventory", 4 * 1024 * 1024,
);
const inventory = JSON.parse(inventoryBytes);
assert.equal(inventory.schemaVersion, 1, "unsupported license inventory schema");
assert.equal(inventory.kind, "av1scope-license-inventory", "invalid license inventory kind");
assert.equal(inventory.buildId, manifest.buildId, "license inventory build mismatch");
assert.ok(Array.isArray(inventory.components), "license inventory components are required");
const libaomLicense = inventory.components.find((item) => item?.name === "libaom");
assert.equal(libaomLicense?.version, manifest.source.version, "license inventory version mismatch");
assert.equal(libaomLicense?.revision, manifest.source.revision, "license inventory revision mismatch");
assert.ok(libaomLicense.licenses.includes("BSD-2-Clause"), "libaom BSD-2-Clause is missing");
assert.ok(
  libaomLicense.licenses.includes("LicenseRef-AOM-Patent-License-1.0"),
  "libaom patent license is missing",
);
for (const component of inventory.components) {
  assert.ok(Array.isArray(component.files) && component.files.length > 0,
    `license files are missing for ${component.name}`);
  for (const reference of component.files) {
    await readBundleFile(reference, `license file ${component.name}`, 4 * 1024 * 1024);
  }
}
const sbomBytes = await readBundleFile(manifest.compliance.sbom, "CycloneDX SBOM", 8 * 1024 * 1024);
const sbom = JSON.parse(sbomBytes);
assert.equal(sbom.bomFormat, "CycloneDX", "SBOM must use CycloneDX");
assert.equal(sbom.specVersion, "1.6", "SBOM must use CycloneDX 1.6");
assert.equal(sbom.metadata?.component?.version, manifest.buildId, "SBOM build mismatch");
assert.ok(Array.isArray(sbom.components), "SBOM components are required");
const component = (name) => sbom.components.find((item) => item?.name === name);
assert.equal(component("libaom")?.version, manifest.source.version, "SBOM libaom version mismatch");
const expectedHashes = new Map([
  ["av1scope-libaom-builtin-patch", manifest.artifacts.patchLibrary.sha256],
  ["av1scope-libaom-inspection-adapter", manifest.artifacts.inspectionAdapter.sha256],
  ["av1scope-inspection-worker", manifest.artifacts.inspectionWorker.sha256],
]);
for (const [name, expected] of expectedHashes) {
  assert.ok(
    component(name)?.hashes?.some((hash) => hash.alg === "SHA-256" && hash.content === expected),
    `SBOM hash mismatch for ${name}`,
  );
}
process.stdout.write(
  `libaom producer provenance eligible (${manifest.buildId}; manifest ${manifestSha256})\n`,
);
