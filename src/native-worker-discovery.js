import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyFfmpegBundle } from "./ffmpeg-bundle-verifier.js";

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_DIRECTORY = path.resolve(MODULE_DIRECTORY, "..");
const DEFAULT_FFMPEG_SMOKE_FIXTURE = path.join(
  DEFAULT_PROJECT_DIRECTORY,
  "test", "fixtures", "libaom-v3.12.1", "motion-compound.ivf.base64",
);

const WORKERS = Object.freeze({
  demux: {
    basename: "av1scope_ffmpeg_demux_worker",
    environmentVariable: "AV1SCOPE_NATIVE_DEMUX_WORKER",
  },
  inspection: {
    basename: "av1scope_inspection_worker",
    environmentVariable: "AV1SCOPE_NATIVE_INSPECTION_WORKER",
  },
});

function workerDefinition(kind) {
  const definition = WORKERS[kind];
  if (!definition) throw new RangeError(`unknown native worker kind: ${kind}`);
  return definition;
}

export function defaultNativeWorkerCandidates(
  kind,
  { projectDirectory = DEFAULT_PROJECT_DIRECTORY, platform = process.platform } = {},
) {
  const { basename } = workerDefinition(kind);
  const filename = platform === "win32" ? `${basename}.exe` : basename;
  return [
    // Prefer the pinned, feature-complete producer over the older development
    // build, which may be linked against a different libaom inspection ABI.
    ...(kind === "inspection" ? [
      path.join(projectDirectory, "build", "native-v3.12.1-golden", filename),
      path.join(projectDirectory, "build", "native-v3.12.1", filename),
    ] : []),
    path.join(projectDirectory, "build", "native", filename),
    path.join(projectDirectory, "build", "native", "Release", filename),
    path.join(projectDirectory, "libexec", "av1scope", filename),
    path.join(projectDirectory, "native", "bin", filename),
  ];
}

export function defaultFfmpegBundleManifestCandidates({
  projectDirectory = DEFAULT_PROJECT_DIRECTORY,
} = {}) {
  return [
    path.join(
      projectDirectory,
      "build", "ffmpeg-v7.1.5-release", "ffmpeg-build-manifest.json",
    ),
    path.join(projectDirectory, "ffmpeg", "ffmpeg-build-manifest.json"),
    path.join(projectDirectory, "libexec", "av1scope", "ffmpeg-build-manifest.json"),
  ];
}

async function executableFile(target, { platform = process.platform } = {}) {
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) return false;
    await access(target, platform === "win32"
      ? fsConstants.R_OK
      : fsConstants.R_OK | fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readableFile(target) {
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) return false;
    await access(target, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function discoverFfmpegBundle({
  explicitManifest = null,
  disabled = false,
  environment = process.env,
  candidatePaths = defaultFfmpegBundleManifestCandidates(),
  fixturePath = DEFAULT_FFMPEG_SMOKE_FIXTURE,
  verifyBundle = verifyFfmpegBundle,
} = {}) {
  let source = "not-found";
  let manifestPath = null;
  if (explicitManifest !== null) {
    source = "argument";
    manifestPath = path.resolve(explicitManifest);
  } else if (disabled) {
    return {
      path: null, source: "disabled", configured: false, available: false,
      searched: [], verification: null, artifacts: null, error: null,
    };
  } else if (typeof environment?.AV1SCOPE_FFMPEG_BUILD_MANIFEST === "string"
      && environment.AV1SCOPE_FFMPEG_BUILD_MANIFEST.length > 0) {
    source = "environment";
    manifestPath = path.resolve(environment.AV1SCOPE_FFMPEG_BUILD_MANIFEST);
  }
  const searched = candidatePaths.map((candidate) => path.resolve(candidate));
  if (manifestPath === null) {
    for (const candidate of searched) {
      if (await readableFile(candidate)) {
        source = "bundled";
        manifestPath = candidate;
        break;
      }
    }
  }
  if (manifestPath === null) {
    return {
      path: null, source, configured: false, available: false,
      searched, verification: null, artifacts: null, error: null,
    };
  }
  if (!await readableFile(manifestPath)) {
    return {
      path: manifestPath, source, configured: true, available: false,
      searched, verification: null, artifacts: null, error: "manifest is unavailable",
    };
  }
  try {
    const verification = await verifyBundle({ manifestPath, fixturePath });
    return {
      path: manifestPath,
      source,
      configured: true,
      available: true,
      searched,
      verification,
      artifacts: verification.artifacts,
      error: null,
    };
  } catch (error) {
    return {
      path: manifestPath,
      source,
      configured: true,
      available: false,
      searched,
      verification: null,
      artifacts: null,
      error: error.message,
    };
  }
}

export async function discoverNativeWorker(kind, {
  explicitPath = null,
  disabled = false,
  environment = process.env,
  candidatePaths = defaultNativeWorkerCandidates(kind),
  platform = process.platform,
} = {}) {
  const { environmentVariable } = workerDefinition(kind);
  if (explicitPath !== null) {
    const resolved = path.resolve(explicitPath);
    return {
      kind, path: resolved, source: "argument", configured: true,
      available: await executableFile(resolved, { platform }), searched: [],
    };
  }
  if (disabled) {
    return {
      kind, path: null, source: "disabled", configured: false,
      available: false, searched: [],
    };
  }
  const environmentPath = environment?.[environmentVariable];
  if (typeof environmentPath === "string" && environmentPath.length > 0) {
    const resolved = path.resolve(environmentPath);
    return {
      kind, path: resolved, source: "environment", configured: true,
      available: await executableFile(resolved, { platform }), searched: [],
    };
  }
  const searched = candidatePaths.map((candidate) => path.resolve(candidate));
  for (const candidate of searched) {
    if (await executableFile(candidate, { platform })) {
      return {
        kind, path: candidate, source: "bundled", configured: true,
        available: true, searched,
      };
    }
  }
  return {
    kind, path: null, source: "not-found", configured: false,
    available: false, searched,
  };
}

export async function resolveGuiNativeWorkers(options = {}, {
  environment = process.env,
  demuxCandidatePaths,
  inspectionCandidatePaths,
  ffmpegBundleCandidatePaths,
  ffmpegBundleFixturePath = DEFAULT_FFMPEG_SMOKE_FIXTURE,
  verifyFfmpegBundleImpl = verifyFfmpegBundle,
  platform = process.platform,
} = {}) {
  if (options.nativeWorkersResolved === true) return options;
  const disabled = options.nativeWorkerAutodiscovery === false;
  const ffmpegBundle = await discoverFfmpegBundle({
    explicitManifest: options.ffmpegBuildManifest ?? null,
    disabled: options.ffmpegBundleAutodiscovery === false,
    environment,
    candidatePaths: ffmpegBundleCandidatePaths ?? defaultFfmpegBundleManifestCandidates(),
    fixturePath: ffmpegBundleFixturePath,
    verifyBundle: verifyFfmpegBundleImpl,
  });
  const defaultDemuxCandidates = demuxCandidatePaths
    ?? defaultNativeWorkerCandidates("demux", { platform });
  const resolvedDemuxCandidates = ffmpegBundle.available
    ? [ffmpegBundle.artifacts.demuxWorker, ...defaultDemuxCandidates]
    : defaultDemuxCandidates;
  const [demux, inspection] = await Promise.all([
    discoverNativeWorker("demux", {
      explicitPath: options.nativeDemuxWorkerExecutable ?? null,
      disabled,
      environment,
      candidatePaths: resolvedDemuxCandidates,
      platform,
    }),
    discoverNativeWorker("inspection", {
      explicitPath: options.nativeInspectionWorkerExecutable ?? null,
      disabled,
      environment,
      candidatePaths: inspectionCandidatePaths
        ?? defaultNativeWorkerCandidates("inspection", { platform }),
      platform,
    }),
  ]);
  return {
    ...options,
    ffmpegPath: options.ffmpegPath ?? ffmpegBundle.artifacts?.ffmpeg ?? "ffmpeg",
    ffprobePath: options.ffprobePath ?? ffmpegBundle.artifacts?.ffprobe ?? "ffprobe",
    ffmpegBundleDiscovery: ffmpegBundle,
    nativeDemuxWorkerExecutable: demux.path,
    nativeInspectionWorkerExecutable: inspection.path,
    nativeWorkerDiscovery: { demux, inspection },
    nativeWorkersResolved: true,
  };
}
