import { spawn } from "node:child_process";
import path from "node:path";

import { discoverNativeWorker } from "../src/native-worker-discovery.js";

const buildDirectory = path.resolve("build/native");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0) resolve();
      else reject(new Error(
        `${command} ${args.join(" ")} failed (${signal ?? `status ${status}`})`,
      ));
    });
  });
}

await run("cmake", [
  "-S", "native", "-B", buildDirectory, "-DCMAKE_BUILD_TYPE=Release",
]);
await run("cmake", [
  "--build", buildDirectory, "--config", "Release",
  "--target", "av1scope_ffmpeg_demux_worker",
]);

const worker = await discoverNativeWorker("demux", { environment: {} });
if (!worker.available) throw new Error("CMake completed but the Native Demux Worker was not found");
process.stdout.write(`Native Demux Worker ready: ${worker.path}\n`);
