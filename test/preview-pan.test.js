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
