import { parentPort, workerData } from "node:worker_threads";

import { analyzeMediaBuffer } from "./analyzer.js";
import { writeBlockOverlaySnapshot } from "./block-overlay-store.js";
import { stringifyReport } from "./json.js";
import { inspectReportFramesInNativeWorker } from "./native-inspection-worker.js";
import { writeReportSnapshot } from "./snapshot-store.js";
import { diagnostic, Severity } from "./model.js";

if (!parentPort) throw new Error("analyze-worker must run inside a Worker Thread");

const controller = new AbortController();
const abort = (message) => {
  if (message?.type === "abort") controller.abort();
};
parentPort.on("message", abort);

try {
  const input = Buffer.from(workerData.input);
  const report = await analyzeMediaBuffer(input, {
    sourceName: workerData.sourceName,
    maxObus: workerData.maxObus,
    maxSyntaxNodes: workerData.maxSyntaxNodes,
    maxFrames: workerData.maxFrames,
    signal: controller.signal,
    ffprobePath: workerData.ffprobePath,
    nativeDemuxWorkerExecutable: workerData.nativeDemuxWorkerExecutable,
  });
  let blockOverlay = null;
  let blockInspection = { status: "unavailable", reason: "Block inspection is not configured" };
  if (workerData.nativeInspectionWorkerExecutable && report.frames.length > 0) {
    try {
      blockOverlay = await inspectReportFramesInNativeWorker(input, report, {
        executable: workerData.nativeInspectionWorkerExecutable,
        signal: controller.signal,
        // Leave time inside the GUI's 15-second deadline for snapshot writing.
        timeoutMs: 10_000,
      });
      blockInspection = {
        status: "ready",
        frameCount: blockOverlay.frames.length,
        blockCount: blockOverlay.frames.reduce((sum, frame) => sum + frame.blocks.length, 0),
        features: blockOverlay.provenance.features,
        missingFeatures: blockOverlay.provenance.missingFeatures,
      };
    } catch (error) {
      if (controller.signal.aborted || error.code === "NATIVE_INSPECTION_CANCELLED") throw error;
      const code = typeof error.code === "string" && /^NATIVE_INSPECTION_[A-Z_]+$/.test(error.code)
        ? error.code : "NATIVE_INSPECTION_FAILED";
      blockInspection = {
        status: "failed", code,
        reason: "Block inspection failed. Stream analysis is still available. Check the inspection worker version and configuration.",
      };
      report.diagnostics.push(diagnostic("BLOCK_INSPECTION_FAILED", Severity.WARNING,
        `${blockInspection.reason} (${code})`));
      report.summary.warningCount += 1;
    }
  }
  report.blockInspection = blockInspection;
  const snapshot = workerData.snapshotDirectory
    ? await writeReportSnapshot(report, workerData.snapshotDirectory)
    : null;
  const storedBlockOverlay = snapshot && blockOverlay
    ? await writeBlockOverlaySnapshot(workerData.snapshotDirectory, {
      parentSnapshotId: snapshot.snapshotId,
      overlay: blockOverlay,
    })
    : null;
  parentPort.postMessage({
    ok: true,
    json: stringifyReport(blockOverlay ? { ...report, blockOverlay } : report),
    snapshot: snapshot ? {
      snapshotId: snapshot.snapshotId,
      created: snapshot.created,
      blockOverlaySnapshotId: storedBlockOverlay?.blockOverlaySnapshotId ?? null,
    } : null,
  });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error.name,
      message: error.message,
      code: typeof error.code === "string" ? error.code : null,
      statusCode: Number.isInteger(error.statusCode) ? error.statusCode : null,
    },
  });
} finally {
  parentPort.off("message", abort);
  parentPort.close();
}
