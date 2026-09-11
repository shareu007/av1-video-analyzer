import test from "node:test";
import assert from "node:assert/strict";
import { blockAnnotationContent, layoutBlockAnnotations, paintBlockAnnotationElements } from "../public/block-annotations.js";
import { buildReferenceStateIndex } from "../public/reference-state.js";

function documentMock() {
  const createElement = (tag) => ({ tagName: tag, style: {}, children: [], className: "", textContent: "", append(...nodes) { this.children.push(...nodes); } });
  return { createElement };
}

const base = (extra = {}) => ({ blockId: 1, x: 0, y: 0, width: 64, height: 64, mode: "intra", ...extra });

test("mode annotations distinguish intra DC/V and skip", () => {
  const dc = blockAnnotationContent(base({ intraMode: "INTRA_0" }), "mode");
  const vertical = blockAnnotationContent(base({ intraMode: "INTRA_1" }), "mode");
  const skip = blockAnnotationContent(base({ intraMode: "INTRA_0", skip: true }), "mode");
  assert.match(dc.lines[0], /DC/);
  assert.match(vertical.lines[0], /↕ V|Vertical/);
  assert.match(skip.lines.join(" "), /Transform skipped/);
});

test("mode annotation keeps same-packet source INTER and labels the referenced picture", () => {
  const obu = (obuId, frameId, summary) => ({ obuId, frameId, type: { code: 3 }, frameHeaderSummary: summary });
  const state = buildReferenceStateIndex({ obus: [
    obu(50, 5, { frameTypeName: "KEY_FRAME", showFrame: 0, refreshFrameFlags: 1, frameWidth: 64, frameHeight: 64, referenceSlotIndices: [], referenceFrameIds: [] }),
    obu(51, 5, { frameTypeName: "INTER_FRAME", showFrame: 0, refreshFrameFlags: 16, frameWidth: 64, frameHeight: 64, referenceSlotIndices: [0], referenceFrameIds: [5] }),
    obu(52, 5, { frameTypeName: "INTER_FRAME", showFrame: 1, refreshFrameFlags: 0, frameWidth: 64, frameHeight: 64, referenceSlotIndices: [0, 4, 0, 0, 4, 0, 0], referenceFrameIds: [5, 5, 5, 5, 5, 5, 5] }),
  ] }).get(5);
  const content = blockAnnotationContent({ mode: "inter", refs: [1], interMode: "NEAREST" }, "mode", { referenceState: state });
  assert.equal(content.lines[0], "INTER ← F5·H1");
  assert.match(content.lines[1], /Same packet/);
  assert.match(content.detail.join(" "), /still INTER/);
  assert.equal(state.picture.obuId, 52);
  const compound = blockAnnotationContent({ mode: "inter", refs: [1, 5] }, "mode", { referenceState: state });
  assert.equal(compound.lines[0], "INTER ← F5·H1 + F5·H2");
  assert.equal(compound.compact, "BI");
  const alias = blockAnnotationContent({ mode: "inter", refs: [1, 3] }, "mode", { referenceState: state });
  assert.equal(alias.lines[0], "INTER ← F5·H1");
  assert.match(alias.lines[1], /2 predictors/);
  const unresolved = blockAnnotationContent({ mode: "inter", refs: [1] }, "mode");
  assert.match(unresolved.detail.join(" "), /Unresolved picture/);
  assert.doesNotMatch(unresolved.lines[0], /F\d/);
});

test("coefficient annotations preserve missing, zero, positive density and bounded bar", () => {
  const missing = blockAnnotationContent(base({ coeffNonZero: null }), "coefficients");
  const zero = blockAnnotationContent(base({ coeffNonZero: 0, width: 8, height: 8 }), "coefficients");
  const positive = blockAnnotationContent(base({ coeffNonZero: 8, width: 8, height: 8 }), "coefficients");
  assert.equal(missing.tone, "unknown");
  assert.match(missing.detail[0], /unavailable/);
  assert.equal(zero.tone, "zero");
  assert.equal(zero.bar, 0);
  assert.equal(positive.tone, "residual");
  assert.ok(positive.bar > 0 && positive.bar <= 1);
});

test("motion annotations scale precision, signs, refs and compound vectors", () => {
  const content = blockAnnotationContent({ mode: "inter", refs: [2, 7], mv: [
    { x: -8, y: 4, precision: "1/2 pel" }, { x: 8, y: -4, precision: "1/4 pel" },
  ] }, "motion");
  assert.deepEqual(content.lines, ["MV1 R2 (-4, +2) px", "MV2 R7 (+2, -1) px"]);
  assert.match(content.detail.join(" "), /Δx: right \+ \/ left − · Δy: down \+ \/ up −/);
});

test("motion handles zero, unknown precision, filtering and switched-off wording", () => {
  const block = { mode: "inter", refs: [0, 3], mv: [
    { x: 0, y: 0, precision: "integer" }, { x: 1, y: 0, precision: "unknown" },
  ] };
  assert.deepEqual(blockAnnotationContent(block, "motion").lines, ["MV1 R0 • 0 px", "MV2 R3 ? px"]);
  assert.deepEqual(blockAnnotationContent(block, "motion", { component: "primary" }).lines, ["MV1 R0 • 0 px"]);
  assert.deepEqual(blockAnnotationContent({ ...block, mv: [{ x: 1, y: 0, precision: "integer" }] }, "motion", { minimumMagnitudePixels: 2 }).lines, ["Below MV threshold"]);
  const off = blockAnnotationContent(block, "motion", { showMotionVectors: false });
  assert.deepEqual(off.lines, ["Vectors hidden"]);
  assert.match(off.detail.join(" "), /switched off/);
});

test("layout keeps labels inside blocks, omits tiny blocks, and zoom reveals detail", () => {
  const block = base({ width: 64, height: 64 });
  const small = base({ blockId: 2, width: 10, height: 10, x: 70 });
  const normal = layoutBlockAnnotations([block, small], { layer: "mode", width: 100, height: 100, bounds: { left: 0, top: 0, width: 100, height: 100 } });
  assert.equal(normal.length, 1);
  assert.ok(normal[0].left >= 0 && normal[0].top >= 0);
  assert.ok(normal[0].left + normal[0].width <= 64 && normal[0].top + normal[0].height <= 64);
  const zoom = layoutBlockAnnotations([base({ width: 64, height: 64 })], { layer: "mode", width: 100, height: 100, bounds: { left: 0, top: 0, width: 300, height: 300 } });
  assert.ok(zoom[0].lines.length >= normal[0].lines.length);
});

test("layout culls viewport, rejects overlap across planes, prioritizes selected, and disables labels", () => {
  const a = base({ blockId: 1, plane: 0, width: 64, height: 64 });
  const b = base({ blockId: 2, plane: 1, x: 0, y: 0, width: 64, height: 64 });
  const c = base({ blockId: 3, x: 200, y: 0, width: 64, height: 64 });
  const opts = { layer: "mode", width: 300, height: 100, bounds: { left: 0, top: 0, width: 300, height: 100 }, viewport: { left: 0, top: 0, width: 100, height: 100 }, selectedBlockId: 2 };
  const labels = layoutBlockAnnotations([a, b, c], opts);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].blockId, 2);
  assert.deepEqual(layoutBlockAnnotations([a], { ...opts, labels: "off" }), []);
  assert.deepEqual(layoutBlockAnnotations([a], { ...opts, labels: "selected" }), []);
});

test("long motion labels fall back without disappearing at the detailed-label threshold", () => {
  const block = base({ mode: "inter", refs: [2, 7], mv: [{ x: 10, y: -20, precision: "integer" }, { x: 12, y: 8, precision: "integer" }] });
  for (const size of [120, 130, 140, 200, 300]) {
    const labels = layoutBlockAnnotations([block], { layer: "motion", width: 64, height: 64, bounds: { width: size, height: size } });
    assert.equal(labels.length, 1, `label lost at ${size}px`);
    assert.ok(labels[0].width < size);
  }
});

test("pan reveals labels previously outside the viewport and unknown modes remain unknown", () => {
  const block = base({ x: 200, intraMode: "INTRA_0" });
  const options = { layer: "mode", width: 300, height: 100, bounds: { left: 0, top: 0, width: 300, height: 100 }, viewport: { left: 0, top: 0, width: 100, height: 100 } };
  assert.equal(layoutBlockAnnotations([block], options).length, 0);
  assert.equal(layoutBlockAnnotations([block], { ...options, bounds: { ...options.bounds, left: -200 } }).length, 1);
  assert.equal(blockAnnotationContent(base({ mode: "unknown" }), "mode").tone, "unknown");
});

test("paints annotation positions through CSSOM and keeps label text inert", () => {
  const root = { innerHTML: "old", children: [], append(...nodes) { this.children.push(...nodes); } };
  const doc = documentMock();
  paintBlockAnnotationElements(root, [
    { blockId: 1, left: 4, top: 8, width: 30, height: 14, fontSize: 10, tone: "zero", lines: ["<img src=x>"] },
    { blockId: 2, left: 44, top: 28, width: 30, height: 14, fontSize: 10, tone: "residual", lines: ["NZ 2"], bar: 0.25 },
  ], doc);
  assert.equal(root.innerHTML, "");
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].style.left, "4px");
  assert.equal(root.children[0].style.top, "8px");
  assert.notEqual(root.children[0].style.left, root.children[1].style.left);
  assert.equal(root.children[0].textContent, "<img src=x>");
  assert.equal(root.children[0].children.length, 0);
  assert.equal(root.children[1].children[0].children[0].style.width, "25%");
});

test("16px residual blocks produce labels at many positions", () => {
  const blocks = Array.from({ length: 8 }, (_, index) => ({
    blockId: index, x: (index % 4) * 16, y: Math.floor(index / 4) * 16,
    width: 16, height: 16, coeffNonZero: index + 1,
  }));
  const labels = layoutBlockAnnotations(blocks, {
    layer: "coefficients", width: 64, height: 32,
    bounds: { left: 0, top: 0, width: 64, height: 32 },
  });
  assert.equal(labels.length, 8);
  assert.equal(new Set(labels.map(({ left, top }) => `${left}:${top}`)).size, 8);
});
