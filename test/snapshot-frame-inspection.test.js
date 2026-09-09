import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectSnapshotFrameWindow,
  planSnapshotFrameInspection,
} from "../src/snapshot-frame-inspection.js";
import { readBlockOverlaySnapshot } from "../src/block-overlay-store.js";
import { writeReportSnapshot } from "../src/snapshot-store.js";

function report() {
  return {
    schemaVersion: 1,
    source: {
      name: "window.ivf",
      size: 100,
      format: "ivf",
      fingerprint: { algorithm: "test", digest: "a".repeat(64) },
    },
    container: { type: "ivf", width: 32, height: 16 },
    summary: { frameCount: 4, obuCount: 0, errorCount: 0, warningCount: 0 },
    provenance: { parser: "test", parserVersion: "1" },
    frames: [
      { frameId: 0, decodeIndex: 0, timestamp: "0", keyframe: true, complete: true, payloadRange: { start: 10, length: 2 } },
      { frameId: 1, decodeIndex: 1, timestamp: "1", keyframe: false, complete: true, payloadRange: { start: 20, length: 3 } },
      { frameId: 2, decodeIndex: 2, timestamp: "2", keyframe: true, complete: true, payloadRange: { start: 30, length: 4 } },
      { frameId: 3, decodeIndex: 3, timestamp: "3", keyframe: false, complete: true, payloadRange: { start: 40, length: 5 } },
    ],
    obus: [],
    syntaxNodes: [],
    diagnostics: [],
  };
}

test("snapshot frame inspection plans a bounded random-access window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-frame-plan-"));
  try {
    const parent = await writeReportSnapshot(report(), root);
    const plan = await planSnapshotFrameInspection(root, parent.snapshotId, 3);
    assert.equal(plan.randomAccessFrameId, 2);
    assert.equal(plan.targetFrameId, 3);
    assert.equal(plan.inputByteLength, 9);
    assert.deepEqual(plan.frames.map(({ frameId }) => frameId), [2, 3]);
    await assert.rejects(
      planSnapshotFrameInspection(root, parent.snapshotId, 3, { maximumInputBytes: 8 }),
      { code: "SNAPSHOT_FRAME_INSPECTION_WINDOW_TOO_LARGE", statusCode: 413 },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot frame inspection remaps local decoder IDs and persists only selected parent pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "av1scope-frame-inspect-"));
  try {
    const configured = report();
    configured.frames[0].obuIds = [0];
    configured.frames[2].obuIds = [1];
    configured.obus = [
      { obuId: 0, frameId: 0, type: { code: 1, name: "OBU_SEQUENCE_HEADER" }, byteRange: { start: 2, length: 2 } },
      { obuId: 1, frameId: 2, type: { code: 6, name: "OBU_FRAME" }, byteRange: { start: 30, length: 4 } },
    ];
    const parent = await writeReportSnapshot(configured, root);
    const input = Buffer.alloc(11, 7);
    const result = await inspectSnapshotFrameWindow(root, parent.snapshotId, 3, input, {
      executable: "/fixed/mock-worker",
      inspectFrames: async (received, localReport, options) => {
        assert.equal(received, input);
        assert.equal(options.executable, "/fixed/mock-worker");
        assert.deepEqual(localReport.frames.map(({ frameId, payloadRange }) => ({
          frameId, payloadRange,
        })), [
          { frameId: 0, payloadRange: { start: 0, length: 6 } },
          { frameId: 1, payloadRange: { start: 6, length: 5 } },
        ]);
        return {
          schemaVersion: 1,
          provenance: { producer: "window-test", build: "fixed" },
          frames: localReport.frames.map(({ frameId }) => ({
            frameId,
            blocks: [{ x: 0, y: 0, width: 16, height: 16, mode: "intra", partition: "none" }],
          })),
        };
      },
    });
    assert.deepEqual(result.overlay.frames.map(({ frameId }) => frameId), [2, 3]);
    assert.equal(result.overlay.provenance.frameWindow.targetFrameId, 3);
    assert.match(result.overlay.provenance.inputSha256, /^[0-9a-f]{64}$/u);
    const replay = await readBlockOverlaySnapshot(root, result.stored.blockOverlaySnapshotId);
    assert.deepEqual(replay.frames.map(({ frameId }) => frameId), [2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
