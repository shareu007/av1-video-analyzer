import assert from "node:assert/strict";
import test from "node:test";

import { attachPreviewPan } from "../public/preview-pan.js";

class FakeViewport {
  constructor() { this.listeners = new Map(); this.scrollLeft = 10; this.scrollTop = 20; this.classList = new SetClassList(); }
  addEventListener(type, fn, capture = false) { const key = `${type}:${capture}`; (this.listeners.get(key) ?? this.listeners.set(key, []).get(key)).push(fn); }
  removeEventListener(type, fn, capture = false) { const key = `${type}:${capture}`; this.listeners.set(key, (this.listeners.get(key) ?? []).filter((item) => item !== fn)); }
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
