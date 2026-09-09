import { spawn } from "node:child_process";

const MAX_COMPARISON_PIXELS = 33_554_432;
const MAX_PROCESS_ERROR_BYTES = 64 * 1024;

function decodeGrayFrame(input, frameIndex, { ffmpegPath, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-vf", `select=eq(n\\,${frameIndex}),format=gray`, "-vsync", "0", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let outputSize = 0;
    let errorSize = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`FFmpeg comparison decode timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    const abort = () => {
      child.kill("SIGKILL");
      finish(new Error("FFmpeg comparison cancelled"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize > MAX_COMPARISON_PIXELS) {
        child.kill("SIGKILL");
        finish(new Error("comparison frame exceeds the pixel limit"));
      } else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errorSize >= MAX_PROCESS_ERROR_BYTES) return;
      const bounded = chunk.subarray(0, MAX_PROCESS_ERROR_BYTES - errorSize);
      errors.push(bounded);
      errorSize += bounded.length;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) finish(new Error(Buffer.concat(errors).toString("utf8").trim() || `FFmpeg exited with code ${code}`));
      else if (outputSize === 0) finish(new Error(`frame ${frameIndex} produced no comparison pixels`));
      else finish(null, Buffer.concat(output, outputSize));
    });
    child.stdin.on("error", (error) => { if (error.code !== "EPIPE") finish(error); });
    child.stdin.end(input);
  });
}

export function compareGrayFrames(reference, candidate) {
  if (!Buffer.isBuffer(reference) || !Buffer.isBuffer(candidate)) {
    throw new TypeError("compareGrayFrames expects two Buffers");
  }
  if (reference.length !== candidate.length || reference.length === 0) {
    throw new Error("comparison frames must have the same non-zero pixel count");
  }
  let sumAbsoluteError = 0;
  let sumSquaredError = 0;
  let sumReference = 0;
  let sumCandidate = 0;
  let sumReferenceSquares = 0;
  let sumCandidateSquares = 0;
  let sumProducts = 0;
  let maximumAbsoluteError = 0;
  const differenceHistogram = Array(256).fill(0);
  for (let index = 0; index < reference.length; index += 1) {
    const left = reference[index];
    const right = candidate[index];
    const difference = Math.abs(left - right);
    differenceHistogram[difference] += 1;
    sumAbsoluteError += difference;
    sumSquaredError += difference * difference;
    maximumAbsoluteError = Math.max(maximumAbsoluteError, difference);
    sumReference += left;
    sumCandidate += right;
    sumReferenceSquares += left * left;
    sumCandidateSquares += right * right;
    sumProducts += left * right;
  }
  const count = reference.length;
  const mse = sumSquaredError / count;
  const meanReference = sumReference / count;
  const meanCandidate = sumCandidate / count;
  const varianceReference = sumReferenceSquares / count - meanReference * meanReference;
  const varianceCandidate = sumCandidateSquares / count - meanCandidate * meanCandidate;
  const covariance = sumProducts / count - meanReference * meanCandidate;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  const ssim = ((2 * meanReference * meanCandidate + c1) * (2 * covariance + c2)) /
    ((meanReference ** 2 + meanCandidate ** 2 + c1) * (varianceReference + varianceCandidate + c2));
  return {
    pixelCount: count,
    mae: sumAbsoluteError / count,
    mse,
    psnr: mse === 0 ? null : 10 * Math.log10((255 * 255) / mse),
    identical: mse === 0,
    ssim,
    maximumAbsoluteError,
    differenceHistogram,
  };
}

export async function compareVideoFrames(
  referenceInput,
  candidateInput,
  frameIndex,
  { ffmpegPath = "ffmpeg", timeoutMs = 8000, signal = null } = {},
) {
  if (!Buffer.isBuffer(referenceInput) || !Buffer.isBuffer(candidateInput)) {
    throw new TypeError("compareVideoFrames expects two Buffers");
  }
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new RangeError("frame index must be non-negative");
  const [reference, candidate] = await Promise.all([
    decodeGrayFrame(referenceInput, frameIndex, { ffmpegPath, timeoutMs, signal }),
    decodeGrayFrame(candidateInput, frameIndex, { ffmpegPath, timeoutMs, signal }),
  ]);
  return { frameIndex, ...compareGrayFrames(reference, candidate) };
}
