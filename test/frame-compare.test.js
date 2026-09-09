import assert from "node:assert/strict";
import test from "node:test";

import { compareGrayFrames, compareVideoFrames } from "../src/frame-compare.js";

const SINGLE_FRAME_IVF = Buffer.from(
  "REtJRgAAIABBVjAxEAAQAAEAAAABAAAAAQAAAAAAAAAYAAAAAAAAAAAAAAASAAoGGAz/2gCAMgwYAAAAUAAAAKmOWNQ=",
  "base64",
);

test("computes deterministic grayscale quality metrics", () => {
  const reference = Buffer.from([0, 10, 20, 30]);
  const candidate = Buffer.from([0, 12, 18, 40]);
  const result = compareGrayFrames(reference, candidate);
  assert.equal(result.pixelCount, 4);
  assert.equal(result.mae, 3.5);
  assert.equal(result.mse, 27);
  assert.equal(result.maximumAbsoluteError, 10);
  assert.equal(result.differenceHistogram[0], 1);
  assert.equal(result.differenceHistogram[2], 2);
  assert.equal(result.differenceHistogram[10], 1);
  assert.ok(result.psnr > 30 && result.psnr < 40);
  assert.ok(result.ssim > 0 && result.ssim < 1);
});

test("identical frames report infinite PSNR as null and SSIM one", () => {
  const pixels = Buffer.from([4, 5, 6, 7]);
  const result = compareGrayFrames(pixels, pixels);
  assert.equal(result.identical, true);
  assert.equal(result.psnr, null);
  assert.equal(result.ssim, 1);
});

test("decodes and compares a real AV1 frame through FFmpeg", async () => {
  const result = await compareVideoFrames(SINGLE_FRAME_IVF, SINGLE_FRAME_IVF, 0);
  assert.equal(result.pixelCount, 256);
  assert.equal(result.identical, true);
  assert.equal(result.maximumAbsoluteError, 0);
});

test("rejects frames with incompatible pixel counts", () => {
  assert.throws(() => compareGrayFrames(Buffer.alloc(4), Buffer.alloc(3)), /same non-zero pixel count/);
});

test("comparison decode supports cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    compareVideoFrames(SINGLE_FRAME_IVF, SINGLE_FRAME_IVF, 0, { signal: controller.signal }),
    /cancelled/,
  );
});
