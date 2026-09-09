const RECT_VERTEX_SHADER = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
in vec4 a_rect;
in vec4 a_color;
out vec4 v_color;
out vec2 v_local;
flat out vec2 v_size;
void main() {
  vec2 corners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
    vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
  );
  vec2 pixel = a_rect.xy + corners[gl_VertexID] * a_rect.zw;
  vec2 clip = pixel / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
  v_local = corners[gl_VertexID] * a_rect.zw;
  v_size = a_rect.zw;
}`;

const RECT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
flat in vec2 v_size;
uniform float u_borders;
out vec4 out_color;
void main() {
  vec2 pixel = min(v_local, v_size - v_local) / max(fwidth(v_local), vec2(0.00001));
  float edge = min(pixel.x, pixel.y) / max(u_borders, 1.0);
  if (u_borders > 0.0 && edge < 1.65) {
    out_color = edge < 0.65 ? vec4(0.02, 0.04, 0.06, 1.0) : vec4(0.92, 0.97, 1.0, 1.0);
  } else { out_color = v_color; }
}`;

const VECTOR_VERTEX_SHADER = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
uniform float u_css_pixel;
in vec4 a_vector;
in vec4 a_color;
out vec4 v_color;
void main() {
  vec2 start = a_vector.xy;
  vec2 end = a_vector.zw;
  vec2 delta = end - start;
  float magnitude = max(length(delta), 0.0001);
  vec2 direction = delta / magnitude;
  vec2 normal = vec2(-direction.y, direction.x);
  float thickness = 1.25 * u_css_pixel;
  float arrow_length = clamp(magnitude * 0.30, 4.0 * u_css_pixel, 10.0 * u_css_pixel);
  float arrow_width = arrow_length * 0.58;
  vec2 shaft_end = end - direction * arrow_length * 0.45;
  vec2 vertices[9] = vec2[9](
    start - normal * thickness, start + normal * thickness, shaft_end - normal * thickness,
    shaft_end - normal * thickness, start + normal * thickness, shaft_end + normal * thickness,
    end, end - direction * arrow_length + normal * arrow_width, end - direction * arrow_length - normal * arrow_width
  );
  vec2 clip = vertices[gl_VertexID] / u_resolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = a_color;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 out_color;
void main() { out_color = v_color; }`;

const MODE_COLORS = {
  intra: [0.208, 0.831, 0.729],
  inter: [0.294, 0.643, 1.0],
  skip: [1.0, 0.710, 0.278],
  unknown: [0.510, 0.588, 0.659],
};

const PARTITION_COLORS = {
  none: [0.35, 0.65, 1.0], split: [1.0, 0.40, 0.47], horz: [0.30, 0.83, 0.69],
  vert: [0.65, 0.45, 1.0], horz_a: [1.0, 0.71, 0.28], horz_b: [0.93, 0.50, 0.20],
  vert_a: [0.35, 0.78, 0.95], vert_b: [0.20, 0.65, 0.85], horz_4: [0.95, 0.35, 0.72],
  vert_4: [0.62, 0.85, 0.32], unknown: [0.51, 0.59, 0.66],
};

const MV_PRECISION_DIVISORS = Object.freeze({
  integer: 1,
  "1/2 pel": 2,
  "1/4 pel": 4,
  "1/8 pel": 8,
});

const REFERENCE_COLORS = Object.freeze([
  [0.208, 0.831, 0.729],
  [1.0, 0.404, 0.467],
  [0.294, 0.643, 1.0],
  [1.0, 0.710, 0.278],
  [0.650, 0.450, 1.0],
  [0.950, 0.350, 0.720],
  [0.620, 0.850, 0.320],
  [0.350, 0.780, 0.950],
]);

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compilation failed: ${message}`);
  }
  return shader;
}

function programFor(gl, vertexSource = RECT_VERTEX_SHADER, fragmentSource = RECT_FRAGMENT_SHADER) {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program linking failed: ${message}`);
  }
  return program;
}

function colorFor(block, layer, opacity) {
  if (layer === "none" || layer === "partition" || layer === "motion") return [0, 0, 0, 0];
  if (layer === "coefficients") {
    if (!Number.isFinite(block.coeffNonZero)) return [0.51, 0.59, 0.66, opacity];
    const value = Math.min(1, Math.log2(1 + Math.max(0, block.coeffNonZero)) / 12);
    return [value, 0.25 + (1 - value) * 0.55, 1 - value, opacity];
  }
  if (layer === "qindex") {
    if (block.qindex === null || block.qindex === undefined) return [0.51, 0.59, 0.66, opacity];
    const normalized = (block.qindex ?? 0) / 255;
    return [normalized, 0.25 + (1 - normalized) * 0.55, 1 - normalized, opacity];
  }
  if (layer === "quant-delta") {
    if (block.quantDelta === null || block.quantDelta === undefined) {
      return [0.51, 0.59, 0.66, opacity];
    }
    const magnitude = Math.min(1, Math.abs(block.quantDelta) / 255);
    return block.quantDelta < 0
      ? [1 - magnitude * 0.75, 1 - magnitude * 0.4, 1, opacity]
      : [1, 1 - magnitude * 0.7, 1 - magnitude * 0.85, opacity];
  }
  const rgb = layer === "partition-type"
    ? (PARTITION_COLORS[block.partition] ?? PARTITION_COLORS.unknown)
    : (MODE_COLORS[block.mode] ?? MODE_COLORS.unknown);
  return [...rgb, opacity];
}

export function buildBlockInstanceData(blocks, { layer = "mode", opacity = 0.28 } = {}) {
  const rects = new Float32Array(blocks.length * 4);
  const colors = new Float32Array(blocks.length * 4);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const offset = index * 4;
    rects[offset] = block.x;
    rects[offset + 1] = block.y;
    rects[offset + 2] = block.width;
    rects[offset + 3] = block.height;
    const color = colorFor(block, layer, opacity);
    colors[offset] = color[0];
    colors[offset + 1] = color[1];
    colors[offset + 2] = color[2];
    colors[offset + 3] = color[3];
  }
  return { rects, colors };
}

export function blockLayerLegend(layer) {
  if (layer === "motion") return [{ label: "Motion vectors · reference colors in Block statistics", color: null }];
  if (layer === "coefficients") return [{ label: "0 coefficients", color: "#00ccff" }, { label: "4095+ coefficients", color: "#ff4000" }, { label: "Unavailable", color: "#8296a8" }];
  if (layer === "none") return [{ label: "Original frame · no block overlay", color: null }];
  if (layer === "partition") return [{ label: "Coding block boundaries", color: "#ebf7ff" }];
  if (layer === "qindex") return [
    { label: "QIndex 0", color: "rgb(0,204,255)" },
    { label: "QIndex 255", color: "rgb(255,64,0)" },
    { label: "Not available", color: "#8296a8" },
  ];
  if (layer === "quant-delta") return [
    { label: "Negative delta", color: "#4099ff" }, { label: "0", color: "#ffffff" },
    { label: "Positive delta", color: "#ff4d26" }, { label: "Not available", color: "#8296a8" },
  ];
  return Object.entries(MODE_COLORS).map(([mode, color]) => ({
    label: { intra: "Intra prediction", inter: "Inter prediction", skip: "Skip", unknown: "Not available" }[mode],
    color: `rgb(${color.map((channel) => Math.round(channel * 255)).join(",")})`,
  }));
}

export function overlayRasterSize(bounds, devicePixelRatio = 1) {
  const width = Math.max(1, bounds.width);
  const height = Math.max(1, bounds.height);
  // Zoom changes CSS geometry, not an unbounded GPU/Canvas allocation.
  const ratio = Math.min(devicePixelRatio, 2, 4096 / width, 4096 / height);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), ratio };
}

// The same source geometry, colors and motion vectors remain usable without WebGL.
export class CanvasBlockOverlayRenderer {
  constructor(canvas, width, height) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.context = canvas.getContext("2d");
    if (!this.context) throw new Error("Canvas rendering is unavailable");
    this.backend = "canvas2d";
  }

  render(blocks, options = {}) {
    const { layer = "mode", opacity = 0.28, showBorders = true } = options;
    const bounds = this.canvas.getBoundingClientRect();
    const raster = overlayRasterSize(bounds, globalThis.devicePixelRatio ?? 1);
    this.canvas.width = raster.width;
    this.canvas.height = raster.height;
    const ctx = this.context;
    ctx.setTransform(this.canvas.width / this.width, 0, 0, this.canvas.height / this.height, 0, 0);
    const pixel = this.width / Math.max(bounds.width, 1);
    for (const block of blocks) {
      const [r, g, b, a] = colorFor(block, layer, opacity);
      ctx.fillStyle = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
      ctx.fillRect(block.x, block.y, block.width, block.height);
      if (layer !== "none" && (showBorders || layer === "partition")) {
        const inset = Math.min(pixel * 1.5, block.width / 2, block.height / 2);
        for (const [color, width] of [["#050a0f", 3], ["#ebf7ff", 1]]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width * pixel;
          ctx.strokeRect(block.x + inset, block.y + inset, Math.max(0, block.width - inset * 2), Math.max(0, block.height - inset * 2));
        }
      }
    }
    if (options.showMotionVectors && layer !== "none") {
      const data = buildMotionVectorInstanceData(blocks, {
        component: options.motionVectorComponent, scale: options.motionVectorScale,
        minimumMagnitudePixels: options.motionVectorMinimumMagnitude,
        opacity: options.motionVectorOpacity, selectedBlockId: options.selectedBlockId,
      });
      for (let i = 0; i < data.count; i += 1) {
        const [x, y, endX, endY] = data.vectors.subarray(i * 4, i * 4 + 4);
        const [r, g, b, a] = data.colors.subarray(i * 4, i * 4 + 4);
        const angle = Math.atan2(endY - y, endX - x);
        const head = Math.min(8 * pixel, Math.hypot(endX - x, endY - y) * 0.4);
        ctx.strokeStyle = `rgba(${r * 255},${g * 255},${b * 255},${a})`;
        ctx.lineWidth = 1.5 * pixel;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY);
        ctx.moveTo(endX - head * Math.cos(angle - 0.5), endY - head * Math.sin(angle - 0.5));
        ctx.lineTo(endX, endY);
        ctx.lineTo(endX - head * Math.cos(angle + 0.5), endY - head * Math.sin(angle + 0.5));
        ctx.stroke();
      }
    }
  }

  destroy() { this.context.clearRect(0, 0, this.width, this.height); }
}

export function motionVectorToPixels(vector) {
  const divisor = MV_PRECISION_DIVISORS[vector?.precision];
  if (divisor === undefined || !Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return null;
  const x = vector.x / divisor;
  const y = vector.y / divisor;
  return { x, y, magnitude: Math.hypot(x, y) };
}

export function motionVectorReferenceColor(referenceSlot, vectorIndex = 0) {
  const index = Number.isInteger(referenceSlot) && referenceSlot >= 0 && referenceSlot < REFERENCE_COLORS.length
    ? referenceSlot
    : vectorIndex % REFERENCE_COLORS.length;
  return [...REFERENCE_COLORS[index]];
}

export function summarizeMotionVectors(blocks) {
  let interBlockCount = 0;
  let compoundBlockCount = 0;
  let vectorCount = 0;
  let zeroVectorCount = 0;
  let unknownPrecisionCount = 0;
  let magnitudeSum = 0;
  let maximumMagnitudePixels = 0;
  const referenceSlotCounts = {};
  for (const block of blocks) {
    if (block.mode === "inter") interBlockCount += 1;
    if ((block.mv?.length ?? 0) > 1) compoundBlockCount += 1;
    for (let index = 0; index < (block.mv?.length ?? 0); index += 1) {
      const vector = motionVectorToPixels(block.mv[index]);
      if (vector === null) {
        unknownPrecisionCount += 1;
        continue;
      }
      vectorCount += 1;
      if (vector.magnitude === 0) zeroVectorCount += 1;
      magnitudeSum += vector.magnitude;
      maximumMagnitudePixels = Math.max(maximumMagnitudePixels, vector.magnitude);
      const referenceSlot = block.refs?.[index];
      if (Number.isInteger(referenceSlot)) {
        referenceSlotCounts[referenceSlot] = (referenceSlotCounts[referenceSlot] ?? 0) + 1;
      }
    }
  }
  return {
    blockCount: blocks.length,
    interBlockCount,
    compoundBlockCount,
    vectorCount,
    zeroVectorCount,
    unknownPrecisionCount,
    meanMagnitudePixels: vectorCount === 0 ? null : magnitudeSum / vectorCount,
    maximumMagnitudePixels: vectorCount === 0 ? null : maximumMagnitudePixels,
    referenceSlotCounts,
  };
}

export function buildMotionVectorInstanceData(blocks, {
  component = "all",
  scale = 1,
  minimumMagnitudePixels = 0,
  opacity = 0.85,
  selectedBlockId = null,
} = {}) {
  const maximumCount = blocks.length * 2;
  const vectors = new Float32Array(maximumCount * 4);
  const colors = new Float32Array(maximumCount * 4);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const safeMinimum = Number.isFinite(minimumMagnitudePixels) && minimumMagnitudePixels >= 0
    ? minimumMagnitudePixels : 0;
  const safeOpacity = Math.min(1, Math.max(0, Number.isFinite(opacity) ? opacity : 0.85));
  let count = 0;
  for (const block of blocks) {
    for (let index = 0; index < (block.mv?.length ?? 0); index += 1) {
      if (component === "primary" && index !== 0) continue;
      if (component === "secondary" && index !== 1) continue;
      const vector = motionVectorToPixels(block.mv[index]);
      if (vector === null || vector.magnitude === 0 || vector.magnitude < safeMinimum) continue;
      const offset = count * 4;
      const startX = block.x + block.width / 2;
      const startY = block.y + block.height / 2;
      vectors[offset] = startX;
      vectors[offset + 1] = startY;
      vectors[offset + 2] = startX + vector.x * safeScale;
      vectors[offset + 3] = startY + vector.y * safeScale;
      const color = block.blockId === selectedBlockId
        ? [1, 1, 1]
        : motionVectorReferenceColor(block.refs?.[index], index);
      colors[offset] = color[0];
      colors[offset + 1] = color[1];
      colors[offset + 2] = color[2];
      colors[offset + 3] = block.blockId === selectedBlockId ? 1 : safeOpacity;
      count += 1;
    }
  }
  return {
    count,
    vectors: vectors.subarray(0, count * 4),
    colors: colors.subarray(0, count * 4),
  };
}

export class BlockSpatialIndex {
  constructor(blocks, cellSize = 64) {
    this.blocks = blocks;
    this.cellSize = cellSize;
    this.buckets = new Map();
    for (const block of blocks) {
      const left = Math.floor(block.x / cellSize);
      const top = Math.floor(block.y / cellSize);
      const right = Math.floor((block.x + block.width - 1) / cellSize);
      const bottom = Math.floor((block.y + block.height - 1) / cellSize);
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          const key = `${column}:${row}`;
          const bucket = this.buckets.get(key) ?? [];
          bucket.push(block);
          this.buckets.set(key, bucket);
        }
      }
    }
  }

  pick(x, y) {
    const bucket = this.buckets.get(`${Math.floor(x / this.cellSize)}:${Math.floor(y / this.cellSize)}`) ?? [];
    let selected = null;
    for (const block of bucket) {
      if (x >= block.x && x < block.x + block.width && y >= block.y && y < block.y + block.height &&
          (!selected || block.width * block.height < selected.width * selected.height)) {
        selected = block;
      }
    }
    return selected;
  }
}

export class BlockOverlayRenderer {
  constructor(canvas, width, height) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.backend = "webgl2";
    this.gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true });
    if (!this.gl) return new CanvasBlockOverlayRenderer(canvas, width, height);
    this.program = null;
    this.vao = null;
    this.rectBuffer = null;
    this.colorBuffer = null;
    this.vectorProgram = null;
    this.vectorVao = null;
    this.vectorBuffer = null;
    this.vectorColorBuffer = null;
    try {
      this.program = programFor(this.gl);
      this.vao = this.gl.createVertexArray();
      this.rectBuffer = this.gl.createBuffer();
      this.colorBuffer = this.gl.createBuffer();
      this.gl.bindVertexArray(this.vao);
      this.#attribute(this.program, "a_rect", this.rectBuffer);
      this.#attribute(this.program, "a_color", this.colorBuffer);
      this.vectorProgram = programFor(this.gl, VECTOR_VERTEX_SHADER, FRAGMENT_SHADER);
      this.vectorVao = this.gl.createVertexArray();
      this.vectorBuffer = this.gl.createBuffer();
      this.vectorColorBuffer = this.gl.createBuffer();
      this.gl.bindVertexArray(this.vectorVao);
      this.#attribute(this.vectorProgram, "a_vector", this.vectorBuffer);
      this.#attribute(this.vectorProgram, "a_color", this.vectorColorBuffer);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  #attribute(program, name, buffer) {
    const location = this.gl.getAttribLocation(program, name);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.enableVertexAttribArray(location);
    this.gl.vertexAttribPointer(location, 4, this.gl.FLOAT, false, 0, 0);
    this.gl.vertexAttribDivisor(location, 1);
  }

  render(blocks, {
    layer = "mode",
    opacity = 0.28,
    showMotionVectors = false,
    motionVectorComponent = "all",
    motionVectorScale = 1,
    motionVectorMinimumMagnitude = 0,
    motionVectorOpacity = 0.85,
    selectedBlockId = null,
    showBorders = true,
  } = {}) {
    const { rects, colors } = buildBlockInstanceData(blocks, { layer, opacity });
    const bounds = this.canvas.getBoundingClientRect();
    const { width: rasterWidth, height: rasterHeight, ratio } = overlayRasterSize(bounds, globalThis.devicePixelRatio ?? 1);
    this.canvas.width = rasterWidth;
    this.canvas.height = rasterHeight;
    const gl = this.gl;
    // Vertices and u_resolution intentionally share source-image coordinates.
    // NDC maps them across the full DPR-scaled viewport; DPR only raises raster density.
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);
    gl.uniform2f(gl.getUniformLocation(this.program, "u_resolution"), this.width, this.height);
    gl.uniform1f(gl.getUniformLocation(this.program, "u_borders"), layer === "none" ? 0 : ratio * Number(showBorders || layer === "partition"));
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, rects, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, blocks.length);
    if (showMotionVectors && layer !== "none") {
      const vectors = buildMotionVectorInstanceData(blocks, {
        component: motionVectorComponent,
        scale: motionVectorScale,
        minimumMagnitudePixels: motionVectorMinimumMagnitude,
        opacity: motionVectorOpacity,
        selectedBlockId,
      });
      if (vectors.count > 0) {
        gl.useProgram(this.vectorProgram);
        gl.uniform2f(gl.getUniformLocation(this.vectorProgram, "u_resolution"), this.width, this.height);
        const cssPixel = Math.max(
          this.width / Math.max(bounds.width, 1),
          this.height / Math.max(bounds.height, 1),
        );
        gl.uniform1f(gl.getUniformLocation(this.vectorProgram, "u_css_pixel"), cssPixel);
        gl.bindVertexArray(this.vectorVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vectors.vectors, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vectorColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, vectors.colors, gl.DYNAMIC_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 9, vectors.count);
      }
    }
  }

  destroy() {
    if (this.rectBuffer) this.gl.deleteBuffer(this.rectBuffer);
    if (this.colorBuffer) this.gl.deleteBuffer(this.colorBuffer);
    if (this.vao) this.gl.deleteVertexArray(this.vao);
    if (this.program) this.gl.deleteProgram(this.program);
    if (this.vectorBuffer) this.gl.deleteBuffer(this.vectorBuffer);
    if (this.vectorColorBuffer) this.gl.deleteBuffer(this.vectorColorBuffer);
    if (this.vectorVao) this.gl.deleteVertexArray(this.vectorVao);
    if (this.vectorProgram) this.gl.deleteProgram(this.vectorProgram);
  }
}
