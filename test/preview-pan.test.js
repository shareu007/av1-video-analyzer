import assert from "node:assert/strict";
import test from "node:test";

import { attachPreviewPan } from "../public/preview-pan.js";

class FakeViewport {
  constructor() { this.listeners = new Map(); this.scrollLeft = 10; this.scrollTop = 20; this.classList = new SetClassList(); }
  addEventListener(type, fn, options = false) { const capture = typeof options === "object" ? Boolean(options?.capture) : Boolean(options); const key = `${type}:${capture}`; (this.listeners.get(key) ?? this.listeners.set(key, []).get(key)).push(fn); }
  removeEventListener(type, fn, options = false) { const capture = typeof options === "object" ? Boolean(options?.capture) : Boolean(options); const key = `${type}:${capture}`; this.listeners.set(key, (this.listeners.get(key) ?? []).filter((item) => item !== fn)); }
  emit(type, event = {}, capture = false) { const dispatched = { preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...event }; for (const fn of this.listeners.get(`${type}:${capture}`) ?? []) fn(dispatched); return dispatched; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture(id) { if (this.captured === id) this.released = id; }
}
class SetClassList { constructor() { this.values = new Set(); } add(v) { this.values.add(v); } remove(v) { this.values.delete(v); } contains(v) { return this.values.has(v); } }

const pointer = (x, y, extra = {}) => ({ pointerId: 1, isPrimary: true, button: 0, clientX: x, clientY: y, target: null, ...extra });

test("fitted pictures pan horizontally and vertically without any scroll overflow", () => {
  const viewport = new FakeViewport();
  const stage = { style: { translate: "" } };
  viewport.querySelector = () => stage;
  // Real browsers clamp scrolling to zero when the picture fits.
  Object.defineProperty(viewport, "scrollLeft", { get: () => 0, set() {} });
  Object.defineProperty(viewport, "scrollTop", { get: () => 0, set() {} });
  const cleanup = attachPreviewPan(viewport);
  viewport.emit("pointerdown", pointer(100, 100));
  viewport.emit("pointermove", pointer(180, 100));
  assert.equal(stage.style.translate, "80px 0px");
  viewport.emit("pointerup", pointer(180, 100));
  viewport.emit("pointerdown", pointer(180, 100));
  viewport.emit("pointermove", pointer(50, 160));
  assert.equal(stage.style.translate, "-50px 60px");
  viewport.emit("pointerup", pointer(50, 160));
  assert.equal(viewport.emit("click", pointer(50, 160), true).stopped, true);
  viewport.emit("dblclick");
  assert.equal(stage.style.translate, "0px 0px");
  cleanup();
  assert.equal(stage.style.translate, "");
  assert.equal(viewport.classList.contains("free-pan"), false);
});

test("pans after threshold and suppresses the resulting click", () => {
  const viewport = new FakeViewport();
  const cleanup = attachPreviewPan(viewport);
  viewport.emit("pointerdown", pointer(100, 100));
  viewport.emit("pointermove", pointer(105, 110));
  assert.equal(viewport.scrollLeft, 5);
  assert.equal(viewport.scrollTop, 10);
  assert.equal(viewport.classList.contains("is-panning"), true);
  assert.equal(viewport.captured, 1);
  viewport.emit("pointerup", pointer(105, 110));
  const click = viewport.emit("click", pointer(105, 110), true);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  cleanup();
});

test("small movement preserves ordinary clicks and controls are ignored", () => {
  const viewport = new FakeViewport();
  const cleanup = attachPreviewPan(viewport);
  viewport.emit("pointerdown", pointer(0, 0, { target: { closest: () => "button" } }));
  viewport.emit("pointermove", pointer(20, 20));
  assert.equal(viewport.scrollLeft, 10);
  viewport.emit("pointerdown", pointer(0, 0));
  viewport.emit("pointermove", pointer(2, 2));
  viewport.emit("pointerup", pointer(2, 2));
  const click = viewport.emit("click", pointer(2, 2), true);
  assert.equal(click.defaultPrevented, undefined);
  cleanup();
});

test("cancel and cleanup release panning state", () => {
  const viewport = new FakeViewport();
  const cleanup = attachPreviewPan(viewport);
  viewport.emit("pointerdown", pointer(1, 1));
  viewport.emit("pointermove", pointer(10, 1));
  viewport.emit("pointercancel", pointer(10, 1));
  assert.equal(viewport.classList.contains("is-panning"), false);
  assert.equal(viewport.released, 1);
  cleanup();
});

test("the observed image point survives stage replacement, zoom and viewport resizing", () => {
  const viewport = new FakeViewport();
  viewport.clientWidth = 400;
  viewport.clientHeight = 300;
  viewport.getBoundingClientRect = () => ({ left: 100, top: 50 });
  let width = 256;
  let height = 128;
  const stage = { style: { translate: "" }, getBoundingClientRect() {
    const [x, y] = this.style.translate.split(" ").map((part) => Number.parseFloat(part) || 0);
    return { left: 100 + Math.max(0, (viewport.clientWidth - width) / 2) + x,
      top: 50 + y, width, height };
  } };
  viewport.querySelector = () => stage;
  const viewState = {};
  let cleanup = attachPreviewPan(viewport, { viewState });
  viewport.emit("pointerdown", pointer(200, 150));
  viewport.emit("pointermove", pointer(260, 120));
  viewport.emit("pointerup", pointer(260, 120));
  const center = { ...viewState.center };
  assert.equal(center.x, 0.5 - 60 / 256);
  assert.equal(center.y, 0.5 + 30 / 128);
  cleanup();
  width = 1024;
  height = 512;
  viewport.clientWidth = 500;
  cleanup = attachPreviewPan(viewport, { viewState });
  const picture = stage.getBoundingClientRect();
  assert.equal((350 - picture.left) / width, center.x);
  assert.equal((200 - picture.top) / height, center.y);
  cleanup.reset();
  assert.deepEqual(viewState.center, { x: 0.5, y: 0.5 });
  assert.equal(stage.getBoundingClientRect().left + width / 2, 350);
  cleanup();
});

test("keyboard panning is limited to the focused viewport and Home resets it", () => {
  const viewport = new FakeViewport();
  const stage = { style: { translate: "" } };
  viewport.querySelector = () => stage;
  const cleanup = attachPreviewPan(viewport);
  viewport.emit("keydown", { target: {}, key: "ArrowLeft" });
  assert.equal(stage.style.translate, "0px 0px");
  viewport.emit("keydown", { target: viewport, key: "ArrowLeft" });
  assert.equal(stage.style.translate, "40px 0px");
  viewport.emit("keydown", { target: viewport, key: "ArrowUp" });
  assert.equal(stage.style.translate, "40px 40px");
  viewport.emit("keydown", { target: viewport, key: "Home" });
  assert.equal(stage.style.translate, "0px 0px");
  cleanup();
});

function zoomFixture() {
  const viewport = new FakeViewport();
  viewport.clientWidth = 400; viewport.clientHeight = 300;
  viewport.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 300 });
  const stage = { style: { translate: "", width: "256px" }, getBoundingClientRect() {
    const width = Number.parseFloat(this.style.width) || 256;
    const height = width / 2;
    const [x, y] = this.style.translate.split(" ").map((part) => Number.parseFloat(part) || 0);
    return { left: 100 + Math.max(0, (viewport.clientWidth - width) / 2) + x, top: 50 + Math.max(0, (viewport.clientHeight - height) / 2) + y, width, height };
  } };
  viewport.querySelector = () => stage;
  return { viewport, stage };
}

const zoomOptions = { sourceWidth: 256, fitWidth: "256px" };

test("wheel zoom normalizes units, anchors at pointer, and obeys limits", () => {
  const { viewport, stage } = zoomFixture();
  const cleanup = attachPreviewPan(viewport, { zoom: { ...zoomOptions, minimum: 0.01, maximum: 16 } });
  viewport.emit("pointerdown", pointer(200, 150)); viewport.emit("pointermove", pointer(260, 150)); viewport.emit("pointerup", pointer(260, 150));
  const before = stage.getBoundingClientRect();
  const anchor = { x: 340, y: 180 };
  const source = { x: (anchor.x - before.left) / before.width, y: (anchor.y - before.top) / before.height };
  const event = viewport.emit("wheel", { clientX: anchor.x, clientY: anchor.y, deltaY: -100, deltaMode: 0 });
  assert.equal(event.defaultPrevented, true);
  const after = stage.getBoundingClientRect();
  assert.ok(after.width > before.width);
  assert.ok(Math.abs((anchor.x - after.left) / after.width - source.x) < 1e-9);
  assert.ok(Math.abs((anchor.y - after.top) / after.height - source.y) < 1e-9);
  const sizeAfter = (deltaY, deltaMode) => {
    cleanup.zoomTo(1);
    viewport.emit("wheel", { clientX: anchor.x, clientY: anchor.y, deltaY, deltaMode });
    return Number.parseFloat(stage.style.width);
  };
  assert.equal(sizeAfter(16, 0), sizeAfter(1, 1));
  assert.equal(sizeAfter(240, 0), sizeAfter(1, 2)); // Page movement is capped.
  cleanup.zoomTo(100);
  assert.equal(viewport.emit("wheel", { deltaY: -100 }).defaultPrevented, true);
  assert.equal(stage.style.width, "4096px");
  cleanup.zoomTo(0.0001);
  assert.equal(viewport.emit("wheel", { deltaY: 100 }).defaultPrevented, true);
  assert.equal(stage.style.width, "2.56px");
  cleanup();
});

test("post-zoom ResizeObserver delivery does not undo the anchored transform", () => {
  const previous = globalThis.ResizeObserver;
  let observed;
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe(target) { observed = this; this.target = target; }
    disconnect() {}
  };
  try {
    const { viewport, stage } = zoomFixture();
    const cleanup = attachPreviewPan(viewport, { zoom: zoomOptions });
    const event = viewport.emit("wheel", { deltaY: -120, deltaMode: 0, clientX: 340, clientY: 210 });
    assert.equal(event.defaultPrevented, true);
    const translate = stage.style.translate;
    observed.callback([{ target: viewport }]);
    assert.equal(stage.style.translate, translate);
    cleanup();
  } finally {
    if (previous === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previous;
  }
});

test("wheel ignores browser shortcuts and controls, and cleanup removes it", () => {
  const { viewport, stage } = zoomFixture();
  const cleanup = attachPreviewPan(viewport, { zoom: zoomOptions });
  const original = stage.style.width;
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { target: { closest: () => "select" } }, { deltaY: 0 }, { deltaY: NaN }]) {
    const event = viewport.emit("wheel", { deltaY: -100, clientX: 200, clientY: 150, ...extra });
    assert.equal(event.defaultPrevented, undefined);
    assert.equal(stage.style.width, original);
  }
  cleanup.zoomTo(4);
  assert.notEqual(stage.style.width, original);
  cleanup();
  assert.equal(viewport.listeners.get("wheel:false").length, 0);
  viewport.emit("wheel", { deltaY: -100, clientX: 200, clientY: 150 });
  assert.equal(stage.style.width, original);
});

test("keyboard zoom, zoomTo, and reset restore fit and center", () => {
  const { viewport, stage } = zoomFixture();
  const cleanup = attachPreviewPan(viewport, { viewState: {}, zoom: zoomOptions });
  cleanup.zoomTo(4); assert.equal(stage.style.width, "1024px");
  viewport.emit("keydown", { target: viewport, key: "-" });
  assert.equal(stage.style.width, "819.2px");
  viewport.emit("keydown", { target: viewport, key: "+" });
  viewport.emit("keydown", { target: viewport, key: "0" });
  assert.equal(stage.style.width, "256px");
  cleanup.zoomTo(32); assert.equal(stage.style.width, "4096px");
  cleanup.reset();
  assert.equal(stage.style.width, "256px");
  assert.equal(stage.style.translate, "0px 0px");
  cleanup();
});
