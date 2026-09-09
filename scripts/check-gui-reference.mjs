import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEMO_SAMPLE_NAME, demoSampleBytes } from "../public/demo-sample.js";
import { inspectGuiPreflight } from "../src/gui-preflight.js";
import { analyzeGuiJsonInWorker } from "../src/gui-server.js";
import { readSnapshotManifest, readSnapshotPage } from "../src/snapshot-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-gui-smoke-"));
try {
  const preflight = await inspectGuiPreflight({ snapshotDirectory: root });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.capabilities.structuralAnalysis, true);
  assert.equal(preflight.capabilities.containerAnalysis, true);
  assert.equal(preflight.capabilities.framePreview, true);
  assert.equal(preflight.capabilities.snapshotStore, true);

  const result = await analyzeGuiJsonInWorker(
    Buffer.from(demoSampleBytes()),
    DEMO_SAMPLE_NAME,
    { snapshotDirectory: root, returnDetails: true },
  );
  const report = JSON.parse(result.json);
  assert.equal(report.summary.frameCount, 1);
  assert.equal(report.summary.errorCount, 0);
  assert.ok(report.summary.obuCount > 0);
  assert.match(result.snapshot?.snapshotId ?? "", /^[0-9a-f]{64}$/);

  const manifest = await readSnapshotManifest(root, result.snapshot.snapshotId);
  const frames = await readSnapshotPage(root, result.snapshot.snapshotId, "frames", {
    offset: 0,
    limit: 10,
  });
  assert.equal(manifest.header.source.name, DEMO_SAMPLE_NAME);
  assert.equal(frames.records.length, 1);
  process.stdout.write(
    `GUI reference smoke passed: ${report.summary.frameCount} frame, ` +
    `${report.summary.obuCount} OBU, snapshot ${result.snapshot.snapshotId.slice(0, 12)}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
