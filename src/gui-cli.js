import { inspectGuiPreflight } from "./gui-preflight.js";
import { startGuiServer } from "./gui-server.js";
import { resolveGuiNativeWorkers } from "./native-worker-discovery.js";

const HELP = `AV1Scope GUI

Usage: av1scope-gui [--host 127.0.0.1] [--port 4173] [--snapshot-dir PATH|--no-snapshot] [--ffmpeg-bundle-manifest PATH|--no-ffmpeg-bundle] [--native-demux-worker PATH] [--native-inspection-worker PATH] [--no-native-workers] [--check]
`;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

export function parseGuiArguments(args) {
  const options = {
    host: "127.0.0.1",
    port: 4173,
    snapshotDirectory: ".av1scope-cache",
    nativeDemuxWorkerExecutable: null,
    nativeInspectionWorkerExecutable: null,
    nativeWorkerAutodiscovery: true,
    ffmpegBuildManifest: null,
    ffmpegBundleAutodiscovery: true,
    checkOnly: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--host") {
      options.host = args[++index];
      if (!options.host) throw new Error("--host requires a value");
    } else if (args[index] === "--port") {
      options.port = parsePort(args[++index]);
    } else if (args[index] === "--snapshot-dir") {
      options.snapshotDirectory = args[++index];
      if (!options.snapshotDirectory) throw new Error("--snapshot-dir requires a value");
    } else if (args[index] === "--no-snapshot") {
      options.snapshotDirectory = null;
    } else if (args[index] === "--native-demux-worker") {
      options.nativeDemuxWorkerExecutable = args[++index];
      if (!options.nativeDemuxWorkerExecutable) {
        throw new Error("--native-demux-worker requires a path");
      }
    } else if (args[index] === "--native-inspection-worker") {
      options.nativeInspectionWorkerExecutable = args[++index];
      if (!options.nativeInspectionWorkerExecutable) {
        throw new Error("--native-inspection-worker requires a path");
      }
    } else if (args[index] === "--no-native-workers") {
      options.nativeWorkerAutodiscovery = false;
    } else if (args[index] === "--ffmpeg-bundle-manifest") {
      options.ffmpegBuildManifest = args[++index];
      if (!options.ffmpegBuildManifest) {
        throw new Error("--ffmpeg-bundle-manifest requires a path");
      }
    } else if (args[index] === "--no-ffmpeg-bundle") {
      options.ffmpegBundleAutodiscovery = false;
    } else if (args[index] === "--check") {
      options.checkOnly = true;
    } else if (args[index] === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${args[index]}`);
    }
  }
  if (!options.nativeWorkerAutodiscovery
      && (options.nativeDemuxWorkerExecutable !== null
        || options.nativeInspectionWorkerExecutable !== null)) {
    throw new Error("--no-native-workers conflicts with explicit native worker paths");
  }
  if (!options.ffmpegBundleAutodiscovery && options.ffmpegBuildManifest !== null) {
    throw new Error("--no-ffmpeg-bundle conflicts with --ffmpeg-bundle-manifest");
  }
  return options;
}

export async function runGuiCli(args, {
  stdout = process.stdout,
  inspectPreflight = inspectGuiPreflight,
  startServer = startGuiServer,
  resolveNativeWorkers = resolveGuiNativeWorkers,
} = {}) {
  const options = parseGuiArguments(args);
  if (options.help) {
    stdout.write(HELP);
    return { status: 0, server: null };
  }
  const runtimeOptions = {
    host: options.host,
    port: options.port,
    snapshotDirectory: options.snapshotDirectory,
    nativeDemuxWorkerExecutable: options.nativeDemuxWorkerExecutable,
    nativeInspectionWorkerExecutable: options.nativeInspectionWorkerExecutable,
    nativeWorkerAutodiscovery: options.nativeWorkerAutodiscovery,
    ffmpegBuildManifest: options.ffmpegBuildManifest,
    ffmpegBundleAutodiscovery: options.ffmpegBundleAutodiscovery,
  };
  const resolvedRuntimeOptions = await resolveNativeWorkers(runtimeOptions);
  if (options.checkOnly) {
    const report = await inspectPreflight(resolvedRuntimeOptions);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return { status: report.ok ? 0 : 1, server: null, report };
  }
  const { server, url } = await startServer(resolvedRuntimeOptions);
  stdout.write(`AV1Scope GUI listening on ${url}\n`);
  return { status: 0, server, url };
}

export async function mainGui() {
  try {
    const result = await runGuiCli(process.argv.slice(2));
    process.exitCode = result.status;
    if (result.server) {
      const stop = () => result.server.close(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }
  } catch (error) {
    process.stderr.write(`av1scope-gui: ${error.message}\n`);
    process.exitCode = 1;
  }
}
