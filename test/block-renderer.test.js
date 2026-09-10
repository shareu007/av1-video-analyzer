import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rendererSource = await readFile(new URL("../public/block-renderer.js", import.meta.url), "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(rendererSource).toString("base64")}`;
const {
  BlockOverlayRenderer,
  BlockSpatialIndex,
  buildBlockInstanceData,
  buildMotionVectorInstanceData,
  motionVectorReferenceColor,
  motionVectorToPixels,
  summarizeMotionVectors,
  blockLayerLegend,
  overlayRasterSize,
  coefficientDensity,
  intraPredictionName,
  blockAnalysisLabel,
} = await import(moduleUrl);

test("prediction labels decode all AV1 intra base modes without inventing unknown values", () => {
  const names = ["DC", "Vertical", "Horizontal", "D45", "D135", "D113", "D157", "D203", "D67", "Smooth", "Smooth V", "Smooth H", "Paeth"];
  names.forEach((name, code) => assert.equal(intraPredictionName(`INTRA_${code}`), name));
  assert.equal(intraPredictionName("INTRA_99"), "INTRA_99");
  assert.equal(blockAnalysisLabel({ intraMode: "INTRA_0", mode: "skip" }, "mode"), "DC");
});

test("coefficient display distinguishes unavailable, zero and normalized block activity", () => {
  assert.equal(coefficientDensity({ width: 8, height: 8, coeffNonZero: null }), null);
  assert.equal(coefficientDensity({ width: 8, height: 8, coeffNonZero: -1 }), null);
  assert.equal(blockAnalysisLabel({ width: 8, height: 8, coeffNonZero: 0 }, "coefficients"), "0 · 0.0%");
  const small = { width: 8, height: 8, coeffNonZero: 4 };
  const large = { width: 16, height: 16, coeffNonZero: 16 };
  assert.equal(coefficientDensity(small), coefficientDensity(large));
  const colors = buildBlockInstanceData([small, large], { layer: "coefficients" }).colors;
  assert.deepEqual([...colors.slice(0, 4)], [...colors.slice(4)]);
});

test("block spatial index picks the smallest overlapping block", () => {
  const large = { blockId: 0, x: 0, y: 0, width: 64, height: 64 };
  const small = { blockId: 1, x: 16, y: 16, width: 8, height: 8 };
  const index = new BlockSpatialIndex([large, small]);
  assert.equal(index.pick(17, 17).blockId, 1);
  assert.equal(index.pick(40, 40).blockId, 0);
  assert.equal(index.pick(80, 80), null);
});

test("block spatial index handles records crossing bucket boundaries", () => {
  const block = { blockId: 7, x: 60, y: 60, width: 16, height: 16 };
  const index = new BlockSpatialIndex([block], 64);
  assert.equal(index.pick(62, 62).blockId, 7);
  assert.equal(index.pick(70, 70).blockId, 7);
});

test("renderer source uses instanced WebGL2 drawing rather than per-block DOM", () => {
  assert.match(rendererSource, /getContext\("webgl2"/);
  assert.match(rendererSource, /drawArraysInstanced/);
  assert.doesNotMatch(rendererSource, /createElement/);
});

test("renderer keeps source coordinates aligned across a DPR-scaled backing store", () => {
  const calls = { uniforms: [], viewport: null };
  let attribute = 0;
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    ARRAY_BUFFER: 5, FLOAT: 6, DYNAMIC_DRAW: 7, COLOR_BUFFER_BIT: 8,
    BLEND: 9, SRC_ALPHA: 10, ONE_MINUS_SRC_ALPHA: 11, TRIANGLES: 12, ONE: 13,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => "", deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: () => true, getProgramInfoLog: () => "", deleteProgram() {},
    createVertexArray: () => ({}), createBuffer: () => ({}), bindVertexArray() {},
    getAttribLocation: () => attribute++, bindBuffer() {}, enableVertexAttribArray() {},
    vertexAttribPointer() {}, vertexAttribDivisor() {},
    viewport: (...values) => { calls.viewport = values; },
    clearColor() {}, clear() {}, enable() {}, blendFuncSeparate: (...values) => { calls.blend = values; }, useProgram() {},
    getUniformLocation: (_program, name) => name,
    uniform2f: (name, x, y) => calls.uniforms.push([name, x, y]),
    uniform1f: (name, value) => calls.uniforms.push([name, value]), bufferData() {}, drawArraysInstanced() {},
    deleteBuffer() {}, deleteVertexArray() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => gl,
    getBoundingClientRect: () => ({ width: 320, height: 180 }),
  };
  const previousRatio = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;
  try {
    const renderer = new BlockOverlayRenderer(canvas, 640, 360);
    renderer.render([], { layer: "partition", showBorders: false });
    assert.deepEqual(calls.blend, [gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA]);
    assert.deepEqual(calls.uniforms.find(([name]) => name === "u_borders"), ["u_borders", 2]);
    assert.deepEqual(calls.viewport, [0, 0, 640, 360]);
    assert.deepEqual(calls.uniforms.find(([name]) => name === "u_resolution"), ["u_resolution", 640, 360]);
    const sourceRightEdgeClip = 640 / 640 * 2 - 1;
    const backingRightEdge = (sourceRightEdgeClip + 1) / 2 * calls.viewport[2];
    assert.equal(backingRightEdge, canvas.width);
    renderer.destroy();
  } finally {
    if (previousRatio === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = previousRatio;
  }
});

test("Canvas fallback draws real block rectangles without coloring partition interiors", () => {
  const strokes = [];
  const fills = [];
  const ctx = {
    setTransform() {}, clearRect() {},
    fillRect(...rect) { fills.push({ rect, color: this.fillStyle }); },
    strokeRect(...rect) { strokes.push({ rect, color: this.strokeStyle }); },
  };
  const canvas = { getContext: (kind) => kind === "2d" ? ctx : null,
    getBoundingClientRect: () => ({ width: 256, height: 256 }) };
  const renderer = new BlockOverlayRenderer(canvas, 256, 256);
  assert.equal(renderer.backend, "canvas2d");
  const blocks = [{ x: 0, y: 0, width: 16, height: 8 }, { x: 16, y: 0, width: 32, height: 8 }];
  renderer.render(blocks, { layer: "partition", showBorders: false });
  assert.equal(strokes.length, 4);
  assert.notDeepEqual(strokes[0].rect, strokes[2].rect);
  assert.ok(fills.every(({ color }) => color === "rgba(0,0,0,0)"));
  strokes.length = 0;
  renderer.render(blocks, { layer: "none" });
  assert.equal(strokes.length, 0);
  renderer.render(blocks, { layer: "mode", showBorders: false });
  assert.equal(strokes.length, 0);
  renderer.destroy();
});

test("layer legends distinguish geometry, broad prediction categories and missing QIndex", () => {
  assert.match(blockLayerLegend("partition")[0].label, /Coding block/);
  assert.ok(blockLayerLegend("mode").some(({ label }) => label === "Inter prediction"));
  const { colors } = buildBlockInstanceData([{ qindex: null }, { qindex: 0 }], { layer: "qindex" });
  assert.notDeepEqual([...colors.slice(0, 3)], [...colors.slice(4, 7)]);
});

test("large-frame zoom keeps raster allocations bounded while preserving aspect ratio", () => {
  assert.deepEqual(overlayRasterSize({ width: 320, height: 180 }, 2), { width: 640, height: 360, ratio: 2 });
  const raster = overlayRasterSize({ width: 7680 * 8, height: 4320 * 8 }, 2);
  assert.equal(raster.width, 4096);
  assert.equal(raster.height, 2304);
});

test("motion vectors convert coded precision to pixel displacement", () => {
  assert.deepEqual(motionVectorToPixels({ x: 4, y: -2, precision: "1/8 pel" }), {
    x: 0.5,
    y: -0.25,
    magnitude: Math.hypot(0.5, -0.25),
  });
  assert.deepEqual(motionVectorToPixels({ x: -3, y: 2, precision: "integer" }), {
    x: -3,
    y: 2,
    magnitude: Math.hypot(-3, 2),
  });
  assert.equal(motionVectorToPixels({ x: 1, y: 1, precision: "future" }), null);
});

test("motion vector buffers support compound refs, scaling, filtering and selection", () => {
  const blocks = [{
    blockId: 7, x: 10, y: 20, width: 16, height: 8, mode: "inter", refs: [0, 3],
    mv: [
      { x: 8, y: -16, precision: "1/8 pel" },
      { x: -4, y: 0, precision: "1/4 pel" },
    ],
  }];
  const data = buildMotionVectorInstanceData(blocks, { scale: 4, opacity: 0.75 });
  assert.equal(data.count, 2);
  assert.deepEqual([...data.vectors], [18, 24, 22, 16, 18, 24, 14, 24]);
  assert.ok([...data.colors.slice(0, 3)].every((value, index) =>
    Math.abs(value - motionVectorReferenceColor(0)[index]) < 1e-6));
  assert.notDeepEqual([...data.colors.slice(0, 3)], [...data.colors.slice(4, 7)]);
  assert.equal(buildMotionVectorInstanceData(blocks, { component: "secondary" }).count, 1);
  assert.equal(buildMotionVectorInstanceData(blocks, { minimumMagnitudePixels: 3 }).count, 0);
  assert.deepEqual(
    [...buildMotionVectorInstanceData(blocks, { selectedBlockId: 7 }).colors.slice(0, 4)],
    [1, 1, 1, 1],
  );
});

test("motion vector summary reports compound, zero, unknown precision and magnitudes", () => {
  const summary = summarizeMotionVectors([
    { mode: "inter", refs: [0, 1], mv: [{ x: 8, y: 0, precision: "1/8 pel" }, { x: 0, y: 0, precision: "1/8 pel" }] },
    { mode: "intra", refs: [], mv: [{ x: 2, y: 3, precision: "unknown" }] },
  ]);
  assert.equal(summary.interBlockCount, 1);
  assert.equal(summary.compoundBlockCount, 1);
  assert.equal(summary.vectorCount, 2);
  assert.equal(summary.zeroVectorCount, 1);
  assert.equal(summary.unknownPrecisionCount, 1);
  assert.equal(summary.meanMagnitudePixels, 0.5);
  assert.equal(summary.maximumMagnitudePixels, 1);
  assert.deepEqual(summary.referenceSlotCounts, { 0: 1, 1: 1 });
});

test("quant delta layer maps negative and positive values to different heat colors", () => {
  const { colors } = buildBlockInstanceData([
    { x: 0, y: 0, width: 4, height: 4, quantDelta: -255 },
    { x: 4, y: 0, width: 4, height: 4, quantDelta: 255 },
  ], { layer: "quant-delta", opacity: 0.5 });
  assert.deepEqual([...colors.slice(0, 4)], [0.25, 0.6000000238418579, 1, 0.5]);
  assert.deepEqual([...colors.slice(4, 8)], [1, 0.30000001192092896, 0.15000000596046448, 0.5]);
});
