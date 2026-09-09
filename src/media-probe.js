import { spawn } from "node:child_process";

const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PROBE_ERROR_BYTES = 64 * 1024;

function runPacketProbe(
  input,
  { ffprobePath = "ffprobe", timeoutMs = 5000, signal = null } = {},
) {
  if (!Buffer.isBuffer(input) && (typeof input !== "string" || input.length === 0)) {
    throw new TypeError("packet probe expects a Buffer or file path");
  }
  if (signal?.aborted) return Promise.reject(new Error("ffprobe cancelled"));
  return new Promise((resolve, reject) => {
    const fromBuffer = Buffer.isBuffer(input);
    const args = [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=index,codec_name,width,height,time_base:packet=stream_index,pts,dts,pos,size,flags",
      "-of", "json", fromBuffer ? "pipe:0" : input,
    ];
    const child = spawn(ffprobePath, args, { stdio: [fromBuffer ? "pipe" : "ignore", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let outputSize = 0;
    let errorSize = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`ffprobe timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("ffprobe cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_PROBE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("ffprobe output exceeds the metadata limit"));
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (errorSize >= MAX_PROBE_ERROR_BYTES) return;
      const bounded = chunk.subarray(0, MAX_PROBE_ERROR_BYTES - errorSize);
      errors.push(bounded);
      errorSize += bounded.length;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(Buffer.concat(errors).toString("utf8").trim() || `ffprobe exited with code ${code}`));
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(output, outputSize).toString("utf8")));
      } catch (error) {
        finish(new Error(`invalid ffprobe JSON: ${error.message}`));
      }
    });
    if (fromBuffer) {
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") finish(error);
      });
      child.stdin.end(input);
    }
  });
}

export function probeMediaPackets(input, options = {}) {
  if (!Buffer.isBuffer(input)) throw new TypeError("probeMediaPackets expects a Buffer");
  return runPacketProbe(input, options);
}

export function probeMediaFilePackets(inputPath, options = {}) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new TypeError("probeMediaFilePackets expects a file path");
  }
  return runPacketProbe(inputPath, options);
}

export const probeIsoBmff = probeMediaPackets;
