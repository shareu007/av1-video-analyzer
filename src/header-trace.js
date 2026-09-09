import { spawn } from "node:child_process";

const MAX_TRACE_BYTES = 4 * 1024 * 1024;

export function parseHeaderTrace(text) {
  const entries = [];
  let frameIndex = null;
  let section = "Unknown";
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/^\[trace_headers[^\]]*\]\s*/, "");
    if (content.startsWith("Packet:")) {
      frameIndex = frameIndex === null ? 0 : frameIndex + 1;
      section = "Packet";
      continue;
    }
    if (/^(OBU header|Sequence Header|Frame Header|Tile Group|Temporal Delimiter|Metadata)$/.test(content)) {
      section = content;
      continue;
    }
    const match = content.match(/^(\d+)\s+(.+?)\s+(?:([01]+)\s+)?=\s+(-?\d+)\s*$/);
    if (!match) continue;
    entries.push({
      frameIndex,
      section,
      bitOffset: Number(match[1]),
      name: match[2].trim(),
      bits: match[3] ?? null,
      value: Number(match[4]),
    });
  }
  return entries;
}

export function traceAv1Headers(
  input,
  { ffmpegPath = "ffmpeg", timeoutMs = 8000, signal = null } = {},
) {
  if (!Buffer.isBuffer(input)) throw new TypeError("traceAv1Headers expects a Buffer");
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "info", "-i", "pipe:0",
      "-map", "0:v:0", "-c", "copy", "-bsf:v", "trace_headers", "-f", "null", "-",
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`FFmpeg header trace timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg header trace cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_TRACE_BYTES) {
        child.kill("SIGKILL");
        finish(new Error("FFmpeg header trace exceeds the output limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      const raw = Buffer.concat(chunks, Math.min(size, MAX_TRACE_BYTES)).toString("utf8");
      if (code !== 0) finish(new Error(raw.trim() || `FFmpeg exited with code ${code}`));
      else finish(null, {
        provenance: { producer: "ffmpeg-trace_headers", sourceRanges: "OBU-relative" },
        entries: parseHeaderTrace(raw),
      });
    });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") finish(error); });
    child.stdin.end(input);
  });
}
