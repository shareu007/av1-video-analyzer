import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GUI_PUBLIC_DIRECTORY = path.resolve(MODULE_DIRECTORY, "../public");
const REQUIRED_GUI_ASSETS = Object.freeze([
  "index.html",
  "styles.css",
  "app.js",
  "block-renderer.js",
  "trace-compare.js",
  "keyboard-navigation.js",
  "csv.js",
  "frame-table.js",
  "block-statistics.js",
  "demo-sample.js",
]);
const MAX_VERSION_OUTPUT_BYTES = 8 * 1024;

export function probeGuiTool(command, {
  spawnImpl = spawn,
  timeoutMs = 2_000,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, ["-version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ available: false, errorCode: error.code ?? "SPAWN_FAILED" });
      return;
    }
    const chunks = [];
    let received = 0;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const capture = (chunk) => {
      if (received >= MAX_VERSION_OUTPUT_BYTES) return;
      const bounded = chunk.subarray(0, MAX_VERSION_OUTPUT_BYTES - received);
      chunks.push(bounded);
      received += bounded.length;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("error", (error) => finish({
      available: false,
      errorCode: error.code ?? "SPAWN_FAILED",
    }));
    child.once("close", (code) => {
      const firstLine = Buffer.concat(chunks, received)
        .toString("utf8")
        .split(/\r?\n/, 1)[0]
        .trim()
        .slice(0, 200);
      finish(code === 0
        ? { available: true, version: firstLine || null }
        : { available: false, errorCode: "NON_ZERO_EXIT" });
    });
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
      finish({ available: false, errorCode: "TIMEOUT" });
    }, timeoutMs);
    timer.unref?.();
  });
}

function check(id, required, ok, message, disabled = false) {
  return {
    id,
    required,
    ok,
    status: disabled ? "disabled" : ok ? "ok" : required ? "error" : "warning",
    message,
  };
}

async function inspectPublicAssets(publicDirectory) {
  try {
    for (const asset of REQUIRED_GUI_ASSETS) {
      const target = path.join(publicDirectory, asset);
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new Error(`${asset} is not a regular file`);
      await access(target, fsConstants.R_OK);
    }
    return check("public-assets", true, true, `${REQUIRED_GUI_ASSETS.length} assets ready`);
  } catch (error) {
    return check("public-assets", true, false, error.code === "ENOENT"
      ? "required GUI asset is missing"
      : "required GUI asset is unreadable");
  }
}

async function inspectSnapshotStore(snapshotDirectory) {
  if (snapshotDirectory === null) {
    return check("snapshot-store", false, true, "not configured", true);
  }
  try {
    await mkdir(snapshotDirectory, { recursive: true });
    const metadata = await stat(snapshotDirectory);
    if (!metadata.isDirectory()) throw new Error("snapshot path is not a directory");
    await access(snapshotDirectory, fsConstants.R_OK | fsConstants.W_OK);
    return check("snapshot-store", true, true, "configured directory is readable and writable");
  } catch {
    return check("snapshot-store", true, false, "configured directory is unavailable");
  }
}

async function inspectNativeWorker(executable, id, discovery = null) {
  if (executable === null) {
    const message = discovery?.source === "disabled"
      ? "automatic discovery disabled"
      : "not found in trusted project locations";
    return check(id, false, true, message, true);
  }
  try {
    const metadata = await stat(executable);
    if (!metadata.isFile()) throw new Error("worker is not a regular file");
    await access(executable, fsConstants.R_OK | fsConstants.X_OK);
    return check(id, true, true, `${discovery?.source ?? "configured"} executable is ready`);
  } catch {
    return check(id, true, false, "configured executable is unavailable");
  }
}

function inspectFfmpegBundle(discovery) {
  if (!discovery || discovery.source === "not-found" || discovery.source === "disabled") {
    const message = discovery?.source === "disabled"
      ? "automatic bundle discovery disabled"
      : "verified release bundle not found; system tools may be used";
    return check("ffmpeg-release-bundle", false, true, message, true);
  }
  if (!discovery.available) {
    return check(
      "ffmpeg-release-bundle",
      true,
      false,
      discovery.error ?? "configured bundle failed verification",
    );
  }
  const verification = discovery.verification;
  return check(
    "ffmpeg-release-bundle",
    true,
    true,
    `verified ${verification.sourceVersion} build ${verification.buildId.slice(0, 12)}; legal review required`,
  );
}

export async function inspectGuiPreflight({
  publicDirectory = DEFAULT_GUI_PUBLIC_DIRECTORY,
  snapshotDirectory = null,
  nativeDemuxWorkerExecutable = null,
  nativeInspectionWorkerExecutable = null,
  nativeWorkerAutodiscovery = true,
  nativeWorkerDiscovery = null,
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
  ffmpegBundleAutodiscovery = true,
  ffmpegBundleDiscovery = null,
  nodeVersion = process.versions.node,
  toolProbe = probeGuiTool,
  host = "127.0.0.1",
  port = 4173,
} = {}) {
  const nodeMajor = Number.parseInt(nodeVersion.split(".", 1)[0], 10);
  const nodeCheck = check(
    "node-runtime",
    true,
    Number.isInteger(nodeMajor) && nodeMajor >= 20,
    `Node ${nodeVersion}; required >=20`,
  );
  const bundleCheck = inspectFfmpegBundle(ffmpegBundleDiscovery);
  const [publicCheck, snapshotCheck, nativeCheck, inspectionCheck, ffprobe, ffmpeg] = await Promise.all([
    inspectPublicAssets(publicDirectory),
    inspectSnapshotStore(snapshotDirectory),
    inspectNativeWorker(
      nativeDemuxWorkerExecutable, "native-demux-worker", nativeWorkerDiscovery?.demux,
    ),
    inspectNativeWorker(
      nativeInspectionWorkerExecutable, "native-inspection-worker",
      nativeWorkerDiscovery?.inspection,
    ),
    toolProbe(ffprobePath),
    toolProbe(ffmpegPath),
  ]);
  const nativeDemux = nativeDemuxWorkerExecutable !== null && nativeCheck.ok;
  const nativeInspection = nativeInspectionWorkerExecutable !== null && inspectionCheck.ok;
  const ffprobeCheck = nativeDemux && !ffprobe.available
    ? check("ffprobe", false, true, "not required while Native Demux Worker is configured", true)
    : check(
      "ffprobe",
      false,
      ffprobe.available,
      ffprobe.available ? ffprobe.version ?? "available" : "MP4/WebM reference demux unavailable",
    );
  const ffmpegCheck = check(
    "ffmpeg",
    false,
    ffmpeg.available,
    ffmpeg.available ? ffmpeg.version ?? "available" : "preview, trace and comparison unavailable",
  );
  const checks = [
    nodeCheck, publicCheck, snapshotCheck, bundleCheck, nativeCheck, inspectionCheck,
    ffprobeCheck, ffmpegCheck,
  ];
  const ok = checks.every((item) => !item.required || item.ok);
  const degraded = checks.some((item) => item.status === "warning");
  const structuralAnalysis = nodeCheck.ok && publicCheck.ok;
  const snapshotStore = snapshotDirectory !== null && snapshotCheck.ok;
  return {
    schemaVersion: "gui-preflight-v1",
    service: "av1scope-gui",
    ok,
    status: ok ? degraded ? "degraded" : "ready" : "error",
    runtime: {
      node: nodeVersion,
      requiredNode: ">=20",
      platform: `${process.platform}-${process.arch}`,
    },
    config: {
      host,
      port,
      snapshotStoreEnabled: snapshotDirectory !== null,
      nativeDemuxWorkerEnabled: nativeDemuxWorkerExecutable !== null,
      nativeInspectionWorkerEnabled: nativeInspectionWorkerExecutable !== null,
      nativeWorkerAutodiscovery,
      ffmpegBundleAutodiscovery,
    },
    capabilities: {
      structuralAnalysis,
      containerAnalysis: structuralAnalysis && (nativeDemux || ffprobe.available),
      framePreview: structuralAnalysis && ffmpeg.available,
      headerTrace: structuralAnalysis && ffmpeg.available,
      pixelComparison: structuralAnalysis && ffmpeg.available,
      snapshotStore,
      streamingIndex: snapshotStore,
      nativeDemux,
      deepBlockInspection: structuralAnalysis && nativeInspection,
    },
    dependencies: {
      ffprobe: { ...ffprobe, path: ffprobePath },
      ffmpeg: { ...ffmpeg, path: ffmpegPath },
      ffmpegReleaseBundle: {
        enabled: ffmpegBundleDiscovery?.configured ?? false,
        available: ffmpegBundleDiscovery?.available ?? false,
        source: ffmpegBundleDiscovery?.source ?? "not-found",
        manifestPath: ffmpegBundleDiscovery?.path ?? null,
        buildId: ffmpegBundleDiscovery?.verification?.buildId ?? null,
        legalReviewRequired:
          ffmpegBundleDiscovery?.verification?.legalReviewRequired ?? null,
      },
      nativeDemuxWorker: {
        enabled: nativeDemuxWorkerExecutable !== null,
        available: nativeDemux,
        source: nativeWorkerDiscovery?.demux?.source ?? "unspecified",
        path: nativeDemuxWorkerExecutable,
      },
      nativeInspectionWorker: {
        enabled: nativeInspectionWorkerExecutable !== null,
        available: nativeInspection,
        source: nativeWorkerDiscovery?.inspection?.source ?? "unspecified",
        path: nativeInspectionWorkerExecutable,
      },
    },
    checks,
  };
}

export function preflightFailureMessage(report) {
  return report.checks
    .filter((item) => item.required && !item.ok)
    .map((item) => `${item.id}: ${item.message}`)
    .join("; ");
}
