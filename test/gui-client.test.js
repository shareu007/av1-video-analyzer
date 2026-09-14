import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { File } from "node:buffer";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { analyzeGuiBuffer } from "../src/gui-server.js";
import { DEMO_SAMPLE_NAME, demoSampleBytes } from "../public/demo-sample.js";
import { makeIvf } from "./fixtures.js";

// Execute the real client with a minimal DOM. These tests cover event wiring and
// async state changes; layout and native file dialogs still need browser QA.
async function client(fetch, crypto = webcrypto) {
  class Element {
    listeners = new Map();
    dataset = {};
    files = [];
    value = "";
    markup = "";
    children = [];
    attributes = new Map();
    style = {};
    set innerHTML(value) {
      this.markup = value;
      this.children = [...value.matchAll(/<(button|details|output)\b([^>]*)>/g)].map(([, tag, attributes]) => {
        const child = new Element();
        for (const [, key, value] of attributes.matchAll(/([\w-]+)="([^"]*)"/g)) {
          child.attributes.set(key, value);
          if (key.startsWith("data-")) child.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
        }
        child.open = /\sopen(?:\s|$)/.test(attributes);
        return child;
      });
    }
    get innerHTML() { return this.markup; }
    hidden = true;
    classList = { add() {}, remove() {}, toggle() {} };
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
    }
    remove() { this.removed = true; }
    async dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) ?? []) await listener(event);
      if (this.parent && !event.stopped) await this.parent.dispatch(type, event);
    }
    querySelectorAll(selector) {
      const match = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return match ? this.children.filter((child) => child.attributes.has(match[1])
        && (match[2] === undefined || child.attributes.get(match[1]) === match[2])) : [];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    scrollIntoView() {}
    after(value) { this.nextSibling = value; }
    append(value) { this.children.push(value); }
    focus() {}
  }
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const document = new Element();
  document.createElement = () => new Element();
  document.body = new Element();
  document.documentElement = new Element();
  document.querySelector = (selector) => elements.get(selector.slice(1)) ?? null;
  elements.get("viewport-content").parent = document.body;
  const context = vm.createContext({
    document, window: {}, HTMLElement: Element, HTMLInputElement: Element,
    HTMLTextAreaElement: Element, HTMLSelectElement: Element,
    fetch, crypto, File, Blob, URL, AbortController, TextEncoder, Uint8Array,
    queueMicrotask, setTimeout: () => 0, clearTimeout() {},
  });
  let source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)";/g)) {
    const module = await import(new URL(`../public/${match[2]}`, import.meta.url));
    for (const name of match[1].split(",").map((name) => name.trim()).filter(Boolean)) {
      context[name] = module[name];
    }
  }
  source = source.replace(/import\s*\{[^}]+\}\s*from\s*"[^"]+";/g, "");
  vm.runInContext(source, context, { filename: "public/app.js" });
  await new Promise(setImmediate);
  return { context, elements, document, app: context.window.__AV1SCOPE__ };
}

const health = () => Response.json({ capabilities: {} });
const sample = () => new File([demoSampleBytes()], DEMO_SAMPLE_NAME);

test("choosing the same stream twice updates the workspace and resets the picker", async () => {
  const report = await analyzeGuiBuffer(Buffer.from(demoSampleBytes()), DEMO_SAMPLE_NAME);
  let uploads = 0;
  const { elements, app } = await client(async (url) => {
    if (url === "/api/health") return health();
    uploads += 1;
    return Response.json(report);
  });
  const input = elements.get("file-input");
  for (let i = 0; i < 2; i += 1) {
    input.files = [sample()];
    input.value = DEMO_SAMPLE_NAME;
    await input.dispatch("change");
    while (app.state.controllers.size) await new Promise(setImmediate);
    assert.equal(input.value, "");
    assert.equal(app.state.report.summary.frameCount, 1);
    assert.match(elements.get("file-summary").innerHTML, /1 frames/);
    assert.match(elements.get("viewport-content").innerHTML, /overview/);
    assert.equal(elements.get("busy-overlay").hidden, true);
    assert.equal(elements.get("toast").hidden, true);
  }
  assert.equal(uploads, 2);
});

test("dropping a stream in the viewport starts only one upload", async () => {
  let uploads = 0;
  const { elements, app } = await client(async (url) => {
    if (url === "/api/health") return health();
    uploads += 1;
    return Response.json({ error: "test rejection" }, { status: 400 });
  });
  await elements.get("viewport-content").dispatch("drop", {
    dataTransfer: { files: [sample()] }, preventDefault() {},
    stopPropagation() { this.stopped = true; },
  });
  while (app.state.controllers.size) await new Promise(setImmediate);
  assert.equal(uploads, 1);
  assert.equal(elements.get("busy-overlay").hidden, true);
  assert.match(elements.get("toast").textContent, /test rejection/);
});

test("HTTP without Web Crypto still opens a successfully indexed snapshot", async () => {
  const { context, app, elements } = await client(async (url) => {
    if (url === "/api/health") return health();
    return Response.json({
      snapshotId: "a".repeat(64), source: { fingerprint: { digest: "b".repeat(64) } },
      summary: { frameCount: 1, obuCount: 2 },
    });
  }, {});
  // Isolate the transition to snapshot loading; snapshot routes have server tests.
  vm.runInContext("openSnapshot = (id, options) => { window.opened = { id, options }; };", context);
  await app.indexLargeFile(sample());
  assert.equal(context.window.opened?.id, "a".repeat(64));
  assert.equal(context.window.opened.options.sourceFile, null);
  assert.match(elements.get("toast").textContent, /HTTPS/);
  assert.equal(elements.get("busy-overlay").hidden, true);
});

test("upload failures are visible and leave the picker usable", async () => {
  for (const failure of [
    () => { throw new TypeError("Failed to fetch"); },
    () => new Response("proxy upload limit", { status: 413, statusText: "Payload Too Large" }),
  ]) {
    const { app, elements } = await client(async (url) => url === "/api/health" ? health() : failure());
    await app.analyzeFile(sample());
    assert.match(elements.get("toast").textContent, /Analysis failed/);
    assert.equal(elements.get("toast").hidden, false);
    assert.equal(elements.get("busy-overlay").hidden, true);
    assert.equal(app.state.controllers.size, 0);
  }
});

test("cancelling during source fingerprinting does not open the old snapshot", async () => {
  let finishDigest;
  let markDigestStarted;
  const digestStarted = new Promise((resolve) => { markDigestStarted = resolve; });
  const { app, context, elements } = await client(async (url) => {
    if (url === "/api/health") return health();
    return Response.json({
      snapshotId: "a".repeat(64), source: { fingerprint: { digest: "00".repeat(32) } },
      summary: { frameCount: 1, obuCount: 2 },
    });
  }, { subtle: { digest() {
    markDigestStarted();
    return new Promise((resolve) => { finishDigest = resolve; });
  } } });
  vm.runInContext("openSnapshot = () => { window.opened = true; };", context);
  const operation = app.indexLargeFile(sample());
  await digestStarted;
  await elements.get("cancel-analysis-button").dispatch("click");
  finishDigest(new ArrayBuffer(32));
  await operation;
  assert.equal(context.window.opened, undefined);
  assert.equal(elements.get("busy-overlay").hidden, true);
});

async function multiFrameClient(count = 3) {
  const payload = Buffer.from(demoSampleBytes()).subarray(44);
  const bytes = makeIvf(Array.from({ length: count }, (_, timestamp) => ({ payload, timestamp })), { width: 16, height: 16 });
  const report = await analyzeGuiBuffer(bytes, "sequence.ivf");
  const result = await client(async (url) => url === "/api/health" ? health() : Response.json(report));
  await result.app.analyzeFile(new File([bytes], "sequence.ivf"));
  return result;
}

test("reference tables and timeline arcs use real frame targets and slot mappings", async () => {
  const { app, elements, context } = await multiFrameClient();
  app.state.selectedFrameId = 2;
  const picture0 = { frameId: 0, obuId: 2, previewFrameId: 0 }, picture1 = { frameId: 1, obuId: 4, previewFrameId: 1 };
  const slots = [picture0, picture1, ...Array(6).fill(null)];
  context.referenceStateFor = () => ({ frameId: 2, picture: { frameId: 2, obuId: 9, hidden: false }, summary: { refreshFrameFlags: 0, referenceFrameIds: [0, 1, 0], referenceSlotIndices: [0, 1, 0] }, bindings: [
    { reference: 1, slot: 0, frameId: 0, picture: picture0 },
    { reference: 2, slot: 1, frameId: 1, picture: picture1 },
    { reference: 3, slot: 0, frameId: 0, picture: picture0 },
  ], before: slots, after: slots.slice() });
  app.state.overlay = { frames: [{ frameId: 2, blocks: [{ mode: "inter", refs: [1] }, { mode: "intra" }] }] };
  const timeline = elements.get("timeline");
  const track = new timeline.constructor(), svg = new timeline.constructor();
  track.getBoundingClientRect = () => ({ left: 20, width: 270 });
  const originalQuery = timeline.querySelector.bind(timeline);
  timeline.querySelector = (selector) => {
    if (selector === ".timeline-track") return track;
    if (selector === ".timeline-reference-arcs") return svg;
    const result = originalQuery(selector);
    if (result) result.getBoundingClientRect = () => ({ left: 20 + Number(result.dataset.frameId) * 90, width: 86 });
    return result;
  };
  context.requestAnimationFrame = (callback) => { callback(); return 1; };
  context.cancelAnimationFrame = () => {};
  vm.runInContext("renderTimeline()", context);
  const map = elements.get("timeline").nextSibling;
  assert.equal(map.querySelectorAll("[data-reference-frame]").length, 2);
  assert.match(map.innerHTML, /Named references · 7 fixed entries/);
  assert.match(map.innerHTML, /DPB · 8 storage slots/);
  assert.equal((map.innerHTML.match(/data-named-reference=/g) ?? []).length, 7);
  assert.equal(map.querySelectorAll("[data-dpb-slot]").length, 8);
  assert.match(map.innerHTML, /GOLDEN_FRAME/);
  assert.match(map.innerHTML, /Before decode<\/th><th>After decode/);
  assert.match(map.innerHTML, /Viewing Frame 2 · shown picture/);
  assert.match(map.innerHTML, /Usage: 1 inter \/ 2 luma blocks/);
  assert.match(map.innerHTML, /0 · unused/);
  assert.match(map.innerHTML, /Header OBU 2/);
  assert.match(svg.innerHTML, /M 223 2 L 223 18 L 43 18 L 43 2/);
  assert.equal((svg.innerHTML.match(/marker-end=/g) ?? []).length, 2);
  assert.match(svg.innerHTML, /Frame 0 · shown picture: used by blocks/);
  assert.match(svg.innerHTML, /Frame 1 · shown picture: unused candidate/);
  assert.equal((svg.innerHTML.match(/stroke-dasharray=/g) ?? []).length, 1);
  assert.match(map.querySelector("[data-dpb-focus]").textContent, /LAST_FRAME \/ LAST3_FRAME → DPB\[0\] → Frame 0 · shown picture/);
  await map.querySelector('[data-reference-binding="2"]').dispatch("click");
  assert.equal(map.querySelector('[data-dpb-slot="1"]').attributes.get("aria-pressed"), "true");
  assert.equal(map.querySelector('[data-reference-binding="1"]').attributes.get("aria-pressed"), "false");
  assert.match(map.querySelector("[data-dpb-focus]").textContent, /LAST2_FRAME → DPB\[1\]/);
  await map.querySelector('[data-dpb-slot="0"]').dispatch("click");
  assert.equal(map.querySelector('[data-reference-binding="1"]').attributes.get("aria-pressed"), "true");
  assert.equal(map.querySelector('[data-reference-binding="3"]').attributes.get("aria-pressed"), "true");
  vm.runInContext("selectFrame = (id) => { window.referenceClicked = id; }", context);
  await map.querySelector('[data-reference-frame="1"]').dispatch("click");
  assert.equal(context.window.referenceClicked, 1);
});

test("F3 highlights LAST and BWDREF usage simultaneously and splits their shared packet arrows", async () => {
  const { app, elements, context } = await multiFrameClient(4);
  app.state.selectedFrameId = 3;
  const key = { frameId: 0, obuId: 2, previewFrameId: 0 };
  const hidden = (hiddenIndex, obuId) => ({ frameId: 1, obuId, hidden: true, hiddenIndex, previewFrameId: null });
  const h1 = hidden(1, 4), h2 = hidden(2, 5), h3 = hidden(3, 6);
  const before = [h1, key, key, h2, key, h3, key, key];
  const slots = [5, 2, 5, 5, 3, 0, 3];
  const refs = slots.map((slot, index) => ({ reference: index + 1, slot, frameId: before[slot].frameId, picture: before[slot] }));
  context.referenceStateFor = () => ({ frameId: 3, picture: { frameId: 3, obuId: 11 },
    summary: { frameTypeName: "INTER_FRAME", refreshFrameFlags: 0, referenceFrameIds: refs.map((ref) => ref.frameId), referenceSlotIndices: slots },
    bindings: refs, before, after: before.slice() });
  const blocks = [...Array.from({ length: 4 }, () => ({ mode: "inter", refs: [1, 5] })),
    ...Array.from({ length: 6 }, () => ({ mode: "inter", refs: [1] })),
    ...Array.from({ length: 21 }, () => ({ mode: "inter", refs: [5] }))];
  app.state.overlay = { frames: [{ frameId: 3, blocks }] };
  const timeline = elements.get("timeline"), track = new timeline.constructor(), svg = new timeline.constructor();
  track.getBoundingClientRect = () => ({ left: 0, width: 360 });
  const originalQuery = timeline.querySelector.bind(timeline);
  timeline.querySelector = (selector) => {
    if (selector === ".timeline-track") return track;
    if (selector === ".timeline-reference-arcs") return svg;
    const result = originalQuery(selector);
    if (result) result.getBoundingClientRect = () => ({ left: Number(result.dataset.frameId) * 90, width: 86 });
    return result;
  };
  context.requestAnimationFrame = (callback) => { callback(); return 1; };
  context.cancelAnimationFrame = () => {};
  vm.runInContext("renderTimeline()", context);
  const map = elements.get("timeline").nextSibling;
  const row = (attribute, id) => map.innerHTML.match(new RegExp(`<tr ${attribute}="${id}"[\\s\\S]*?<\\/tr>`))[0];
  assert.match(row("data-named-reference", 1), /reference-used reference-forward/);
  assert.match(row("data-named-reference", 1), /10<small[^>]*>FWD · used/);
  assert.match(row("data-named-reference", 5), /reference-used reference-backward/);
  assert.match(row("data-named-reference", 5), /25<small[^>]*>BWD · used/);
  assert.match(row("data-dpb-row", 5), /reference-used reference-forward/);
  assert.match(row("data-dpb-row", 3), /reference-used reference-backward/);
  for (const ref of [2, 3, 4, 6, 7]) assert.doesNotMatch(row("data-named-reference", ref), /reference-used/);
  assert.doesNotMatch(row("data-dpb-row", 2), /reference-used/);
  assert.match(map.innerHTML, /Dashed outline = selected mapping, not block usage/);
  const forward = svg.innerHTML.match(/<g data-reference-direction="forward" data-reference-target="1">[\s\S]*?<\/g>/)[0];
  const backward = svg.innerHTML.match(/<g data-reference-direction="backward" data-reference-target="1">[\s\S]*?<\/g>/)[0];
  assert.match(forward, /used by blocks[\s\S]*var\(--reference-forward\)[\s\S]*F1 · FWD/);
  assert.match(backward, /used by blocks[\s\S]*var\(--reference-backward\)[\s\S]*F1 · BWD/);
  assert.doesNotMatch(forward + backward, /stroke-dasharray/);
  // Separate arrowheads keep the orange head from covering the blue one.
  assert.notEqual(forward.match(/<text x="([^"]+)"/)[1], backward.match(/<text x="([^"]+)"/)[1]);
  assert.equal((svg.innerHTML.match(/marker-end=/g) ?? []).length, 3);
  assert.match(timeline.querySelector('[data-frame-id="1"]').attributes.get("class"), /reference-mixed/);
  await map.querySelector('[data-reference-binding="5"]').dispatch("click");
  assert.equal(map.querySelector('[data-dpb-slot="3"]').attributes.get("aria-pressed"), "true");
  assert.match(map.querySelector("[data-dpb-focus]").textContent, /^Selected mapping: BWDREF_FRAME \/ ALTREF_FRAME/);
  assert.match(row("data-named-reference", 1), /reference-used reference-forward/);
  assert.match(row("data-named-reference", 5), /reference-used reference-backward/);
  await map.querySelector('[data-reference-binding="3"]').dispatch("click");
  assert.equal(map.querySelector('[data-reference-binding="3"]').attributes.get("aria-pressed"), "true");
  assert.doesNotMatch(row("data-named-reference", 3), /reference-used/);
});

test("reference usage styling keeps direction colours independent of selection", async () => {
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const forward = css.match(/--reference-forward:\s*([^;]+);/)[1];
  const backward = css.match(/--reference-backward:\s*([^;]+);/)[1];
  assert.notEqual(forward, backward);
  const selection = css.match(/\.reference-tables \.dpb-linked\s*\{([^}]+)\}/)[1];
  assert.match(selection, /outline: 1px dashed/);
  assert.doesNotMatch(selection, /background|box-shadow|--reference-color/);
  assert.match(css, /\[data-named-reference\]\.reference-used > td/);
  assert.match(css, /\[data-dpb-row\]\.reference-used > td:nth-child\(-n\+2\)/);
});

test("hidden reference links open the exact picture and unavailable usage never becomes unused", async () => {
  const { app, elements, context } = await multiFrameClient(9);
  app.state.selectedFrameId = 5;
  const hidden = { frameId: 5, obuId: 15, hidden: true, hiddenIndex: 1, previewFrameId: 6 };
  const unshown = { frameId: 1, obuId: 4, hidden: true, hiddenIndex: 1, previewFrameId: null };
  const slots = [unshown, null, null, null, null, hidden, null, null];
  const referenceState = { frameId: 5, picture: { frameId: 5, obuId: 16, hidden: false }, packetPictures: [hidden],
    summary: { refreshFrameFlags: 0, referenceFrameIds: [5, 1], referenceSlotIndices: [5, 0] }, bindings: [
      { reference: 5, slot: 5, frameId: 5, picture: hidden }, { reference: 6, slot: 0, frameId: 1, picture: unshown },
    ], before: slots, after: slots.slice() };
  context.referenceStateFor = () => referenceState;
  vm.runInContext("renderTimeline()", context);
  let map = elements.get("timeline").nextSibling;
  assert.match(map.innerHTML, /Frame 5 · hidden picture 1/);
  assert.match(map.innerHTML, /Header OBU 15 · same packet, different picture/);
  assert.match(map.innerHTML, /View in F6/);
  assert.match(map.innerHTML, /Preview unavailable/);
  assert.equal(map.querySelectorAll("[data-reference-frame]").length, 1);
  assert.equal(map.querySelector('[data-reference-frame="5"]'), null);
  assert.match(map.innerHTML, /Block usage unavailable/);
  assert.doesNotMatch(map.innerHTML, /0 · unused/);
  assert.match(map.querySelector("[data-dpb-focus]").textContent, /BWDREF_FRAME → DPB\[5\] → Frame 5 · hidden picture 1/);
  vm.runInContext("selectFrame = (id) => { window.referenceClicked = id; }", context);
  await map.querySelector('[data-reference-frame="6"]').dispatch("click");
  assert.equal(context.window.referenceClicked, 6);

  app.state.overlay = { frames: [{ frameId: 5, blocks: [{ mode: "inter", refs: [5] }, { mode: "inter", refs: [] }] }] };
  vm.runInContext("renderTimeline()", context);
  map = elements.get("timeline").nextSibling;
  assert.match(map.innerHTML, /≥1/);
  assert.match(map.innerHTML, /1 blocks have unknown reference usage/);
  assert.doesNotMatch(map.innerHTML, /0 · unused/);

  referenceState.summary.showExistingFrame = 1;
  referenceState.summary.frameToShowMapIdx = 5;
  referenceState.picture = hidden;
  vm.runInContext("renderTimeline()", context);
  map = elements.get("timeline").nextSibling;
  assert.match(map.innerHTML, /Display source · no new prediction/);
  assert.match(map.innerHTML, /no new picture is coded/);
  assert.doesNotMatch(map.innerHTML, /0 · unused|Usage:/);
  assert.equal((map.innerHTML.match(/data-named-reference=/g) ?? []).length, 7);
  assert.equal(map.querySelectorAll("[data-reference-binding]").length, 0);
  assert.match(map.querySelector("[data-dpb-focus]").textContent, /Display source \(show_existing_frame\) → DPB\[5\]/);
});

test("DPB table keeps before-decode pointers separate from refreshed storage", async () => {
  const { app, elements, context } = await multiFrameClient(6);
  app.state.selectedFrameId = 5;
  const old = { frameId: 1, obuId: 5, hidden: true, hiddenIndex: 2, previewFrameId: 4 };
  const current = { frameId: 5, obuId: 16, hidden: false, previewFrameId: 5 };
  const before = Array(8).fill(old), after = before.slice();
  after[3] = current;
  context.referenceStateFor = () => ({ frameId: 5, picture: current, summary: { refreshFrameFlags: 8 },
    bindings: [{ reference: 4, slot: 3, frameId: 1, picture: old }], before, after });
  vm.runInContext("renderTimeline()", context);
  let map = elements.get("timeline").nextSibling;
  const updatedRow = map.innerHTML.match(/<tr data-dpb-row="3"[\s\S]*?<\/tr>/)[0];
  assert.match(updatedRow, /dpb-refreshed/);
  assert.match(updatedRow, /F1·H2[\s\S]*Updated[\s\S]*F5·shown/);
  assert.match(map.querySelector("[data-dpb-focus]").textContent, /GOLDEN_FRAME → DPB\[3\] → Frame 1 · hidden picture 2 \(before decode\)/);
  assert.doesNotMatch(map.querySelector("[data-dpb-focus]").textContent, /Frame 5/);
  assert.equal((map.innerHTML.match(/dpb-unchanged/g) ?? []).length, 7);

  context.referenceStateFor = () => ({ frameId: 5, picture: current, summary: { frameTypeName: "KEY_FRAME", refreshFrameFlags: 255 }, bindings: [], before: Array(8).fill(null), after: Array(8).fill(current) });
  vm.runInContext("renderTimeline()", context);
  map = elements.get("timeline").nextSibling;
  assert.equal((map.innerHTML.match(/data-named-reference=/g) ?? []).length, 7);
  assert.equal(map.querySelectorAll("[data-reference-binding]").length, 0);
  assert.equal((map.innerHTML.match(/dpb-refreshed/g) ?? []).length, 8);
});

test("frame navigation keeps the selected OBU and structure scope synchronized", async () => {
  const { app, elements } = await multiFrameClient();
  const tree = elements.get("structure-tree");
  assert.match(tree.innerHTML, /Frame 0/);
  assert.doesNotMatch(tree.innerHTML, /Frame 1/);
  assert.equal(elements.get("previous-frame").disabled, true);
  await elements.get("next-frame").dispatch("click");
  assert.equal(app.state.selectedFrameId, 1);
  assert.equal(app.state.selection.id, app.state.report.obus.find((obu) => obu.frameId === 1 && obu.frameHeaderSummary?.showFrame)?.obuId);
  assert.match(tree.innerHTML, /Frame 1/);
  assert.doesNotMatch(tree.innerHTML, /Frame 0/);
  const all = elements.get("structure-all-frames");
  all.checked = true;
  await all.dispatch("change");
  assert.match(tree.innerHTML, /Frame 0/);
  const lastObu = app.state.report.frames[2].obuIds[0];
  await tree.querySelector(`[data-obu-id="${lastObu}"]`).dispatch("click");
  assert.equal(app.state.selectedFrameId, 2);
  assert.equal(elements.get("next-frame").disabled, true);
  assert.equal(elements.get("frame-position").textContent, "Frame 2 / 2");
});

test("jumping validates bounds and renders a bounded timeline containing the target", async () => {
  const { app, elements } = await multiFrameClient(100);
  elements.get("frame-jump-input").value = "99";
  await elements.get("frame-jump-form").dispatch("submit", { preventDefault() {} });
  assert.equal(app.state.selectedFrameId, 99);
  const timeline = elements.get("timeline");
  assert.equal(timeline.querySelectorAll("[data-frame-id]").length, 80);
  assert.ok(timeline.querySelector('[data-frame-id="99"]'));
  elements.get("frame-jump-input").value = "100";
  await elements.get("frame-jump-form").dispatch("submit", { preventDefault() {} });
  assert.equal(app.state.selectedFrameId, 99);
  assert.match(elements.get("toast").textContent, /valid frame number/);
});

test("inspector details stay collapsed until requested and remember expanded sections", async () => {
  const { app, elements } = await multiFrameClient();
  const inspector = elements.get("inspector");
  const section = inspector.querySelector('[data-inspector-section="obu:OBU Header"]');
  assert.equal(section.open, false);
  section.open = true;
  await section.dispatch("toggle");
  await elements.get("next-frame").dispatch("click");
  assert.equal(inspector.querySelector('[data-inspector-section="obu:OBU Header"]').open, true);
  assert.equal(app.state.selectedFrameId, 1);
});

test("clean diagnostics collapse, can be expanded, and byte view remains accessible", async () => {
  const { app, elements } = await multiFrameClient();
  assert.equal(elements.get("diagnostic-list").hidden, true);
  await elements.get("diagnostic-toggle").dispatch("click");
  assert.equal(elements.get("diagnostic-list").hidden, false);
  assert.equal(elements.get("diagnostic-toggle").attributes.get("aria-expanded"), "true");
  await elements.get("hex-tab").dispatch("click");
  assert.equal(app.state.view, "hex");
  assert.match(elements.get("viewport-content").innerHTML, /hex-view/);
  await elements.get("frame-table-tab").dispatch("click");
  assert.match(elements.get("viewport-content").innerHTML, /<details class="analysis-disclosure"><summary>Filters/);
  app.state.frameTableFilters.frameIdMin = "1";
  await elements.get("frame-table-tab").dispatch("click");
  assert.match(elements.get("viewport-content").innerHTML, /Filters · 1 active/);
});

test("frame-level diagnostics select that frame's OBU and clear a hiding filter", async () => {
  const { app, elements, context } = await multiFrameClient();
  app.state.report.diagnostics = [{ frameId: 2, obuId: null, severity: "warning", code: "FRAME_WARNING", message: "frame warning", byteRange: null }];
  app.state.report.summary.warningCount = 1;
  app.state.filter = "no matching field";
  vm.runInContext("renderDiagnostics();", context);
  await elements.get("diagnostic-list").querySelector('[data-diagnostic-index="0"]').dispatch("click");
  assert.equal(app.state.selectedFrameId, 2);
  assert.equal(app.state.selection.id, app.state.report.frames[2].obuIds[0]);
  assert.equal(app.state.filter, "");
  assert.match(elements.get("structure-tree").innerHTML, /Frame 2/);
});

test("selecting a block shows only the block's details", async () => {
  const { app, elements, context } = await multiFrameClient();
  app.state.selectedBlock = { blockId: 3, width: 8, height: 8, x: 0, y: 0, plane: 0, mv: [], refs: [], mode: "INTRA", qindex: 80 };
  vm.runInContext("renderSelection();", context);
  assert.match(elements.get("inspector").innerHTML, /Block 3/);
  assert.doesNotMatch(elements.get("inspector").innerHTML, /Source range|OBU Header|Syntax fields/);
});

test("a late preview from the previous stream cannot populate the new stream's cache", async () => {
  const report = await analyzeGuiBuffer(Buffer.from(demoSampleBytes()), DEMO_SAMPLE_NAME);
  let finishPreview;
  const { app, context } = await client(async (url) => {
    if (url === "/api/health") return health();
    if (url.startsWith("/api/preview")) return new Promise((resolve) => { finishPreview = resolve; });
    return Response.json(report);
  });
  await app.analyzeFile(sample());
  const preview = vm.runInContext('state.view = "frame"; renderFramePreview();', context);
  assert.equal(typeof finishPreview, "function");
  await app.analyzeFile(sample());
  finishPreview(new Response(new Blob(["obsolete preview"])));
  await preview;
  assert.equal(app.state.previews.size, 0);
});

test("leaving the preview clears pending statistics so returning can retry", async () => {
  const { app, elements } = await multiFrameClient();
  app.state.view = "frame";
  app.state.frameStats.set(0, { status: "loading" });
  app.state.controllers.set("luma", new AbortController());
  app.state.frameStats.set(1, { status: "ready", value: {} });
  await elements.get("hex-tab").dispatch("click");
  assert.equal(app.state.frameStats.has(0), false);
  assert.equal(app.state.frameStats.get(1).status, "ready");
});

test("block layer controls redraw, preserve explicit boundaries and clean up resize observers", async () => {
  let finishReferencePreview;
  const { context, elements, app, document } = await client(async (url) => url.startsWith("/api/preview")
    ? new Promise((resolve) => { finishReferencePreview = resolve; }) : health());
  const viewport = elements.get("viewport-content");
  const nodes = new Map();
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new viewport.constructor());
    return nodes.get(selector);
  };
  viewport.querySelector = node;
  const canvas = node(".block-overlay");
  canvas.parentElement = new viewport.constructor();
  canvas.closest = () => viewport;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 512, height: 512 });
  let legend;
  document.createElement = () => new viewport.constructor();
  node(".block-controls").after = (value) => { legend = value; };
  node(".block-selection").remove = () => {};
  const draws = [];
  let disconnected = false;
  let destroyed = false;
  context.BlockOverlayRenderer = class {
    render(blocks, options) { draws.push({ blocks, options }); }
    destroy() { destroyed = true; }
  };
  context.requestAnimationFrame = (callback) => { callback(); return 1; };
  context.cancelAnimationFrame = () => {};
  context.ResizeObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() { this.callback(); }
    disconnect() { disconnected = true; }
  };
  vm.runInContext('setupBlockOverlay([{blockId: 1, x: 0, y: 0, width: 16, height: 16, plane: 0, mode: "intra", intraMode: "INTRA_0", coeffNonZero: 0}, {blockId: 2, x: 32, y: 0, width: 64, height: 64, plane: 0, mode: "inter", coeffNonZero: 24, refs: [2], mv: [{x: -8, y: 4, precision: "1/2 pel"}]}], 256, 256, true)', context);
  assert.equal(draws.at(-1).options.layer, "partition");
  assert.equal(node("#block-borders").disabled, true);
  const legendText = () => legend.children.map((child) => child.textContent).join(" ");
  assert.match(legendText(), /Coding block boundaries/);
  const annotations = canvas.parentElement.children.find((child) => child.className === "block-annotations");
  const readout = viewport.children.find((child) => child.className === "block-image-readout");
  await node("#block-layer").dispatch("change", { target: { value: "mode" } });
  const labelText = () => annotations.children.map((child) => child.textContent).join(" ");
  assert.match(labelText(), /DC/);
  assert.ok(new Set(annotations.children.map((child) => child.style.left)).size > 1);
  assert.match(readout.innerHTML, /Predictions/);
  await canvas.dispatch("click", { clientX: 4, clientY: 4 });
  assert.match(readout.innerHTML, /Base mode: DC/);
  context.referenceStateFor = () => ({ summary: { frameWidth: 256, frameHeight: 256 }, bindings: [{ reference: 2, slot: 0, frameId: 0, picture: { frameId: 0, obuId: 2, previewFrameId: 0, summary: { frameWidth: 256, frameHeight: 256 } } }] });
  app.state.previews.set(0, { status: "ready", url: "blob:reference-test" });
  app.state.overlay = { frames: [{ frameId: 0, blocks: [{ blockId: 100, x: 0, y: 0, width: 128, height: 128, plane: 0 }] }] };
  await canvas.dispatch("click", { clientX: 80, clientY: 20 });
  const sources = node(".preview-caption").nextSibling;
  assert.match(sources.innerHTML, /Predictor 1 ← Frame 0 · shown picture/);
  assert.match(sources.innerHTML, /R2 → cache slot 0 · header OBU 2/);
  assert.match(sources.innerHTML, /Source \(28, 2\)/);
  assert.match(sources.innerHTML, /Overlaps B100/);
  assert.doesNotMatch(sources.innerHTML, /style=/);
  app.state.previews.delete(0);
  await canvas.dispatch("click", { clientX: 4, clientY: 4 });
  await canvas.dispatch("click", { clientX: 80, clientY: 20 });
  assert.equal(typeof finishReferencePreview, "function");
  await canvas.dispatch("click", { clientX: 4, clientY: 4 });
  finishReferencePreview(new Response(new Blob(["stale reference picture"])));
  await new Promise(setImmediate);
  assert.match(sources.innerHTML, /Intra prediction uses neighbours/);
  assert.doesNotMatch(sources.innerHTML, /source-picture|reference-picture/);
  await node("#block-labels").dispatch("change", { target: { value: "selected" } });
  assert.equal(annotations.innerHTML, "");
  assert.match(readout.innerHTML, /B1 · 16×16/);
  await node("#block-labels").dispatch("change", { target: { value: "off" } });
  assert.equal(readout.hidden, true);
  await node("#block-labels").dispatch("change", { target: { value: "auto" } });
  await node("#block-layer").dispatch("change", { target: { value: "coefficients" } });
  assert.equal(sources.innerHTML, "");
  assert.match(labelText(), /NZ 24/);
  assert.match(labelText(), /Sparse · 0.6%/);
  assert.match(legendText(), /S = Sparse · >0–5%/);
  assert.match(legendText(), /D = Dense · >20%/);
  assert.match(readout.innerHTML, /Residuals · coefficient density/);
  assert.match(readout.innerHTML, /Non-zero coefficients: 0/);
  await canvas.dispatch("click", { clientX: 80, clientY: 20 });
  assert.match(readout.innerHTML, /Coefficient density: Sparse · 0.6%/);
  assert.match(readout.innerHTML, /24 \/ 4096 = 0.6%/);
  await node("#mv-toggle").dispatch("change", { target: { checked: true } });
  await node("#block-layer").dispatch("change", { target: { value: "motion" } });
  await canvas.dispatch("click", { clientX: 80, clientY: 20 });
  assert.match(labelText(), /R2/);
  assert.match(readout.innerHTML, /MV1 R2: Δx -4, Δy \+2 px/);
  await node("#block-filter").dispatch("change", { target: { value: "intra" } });
  assert.equal(app.state.selectedBlock, null);
  assert.doesNotMatch(readout.innerHTML, /MV1 R2/);
  await node("#block-layer").dispatch("change", { target: { value: "qindex" } });
  assert.equal(draws.at(-1).options.layer, "qindex");
  assert.equal(node("#block-borders").disabled, false);
  assert.match(legendText(), /QIndex 255/);
  await node("#block-borders").dispatch("change", { target: { checked: false } });
  assert.equal(draws.at(-1).options.showBorders, false);
  await node("#block-layer").dispatch("change", { target: { value: "none" } });
  assert.equal(node("#sb-grid-toggle").disabled, true);
  assert.equal(app.state.selectedBlock, null);
  const before = draws.length;
  await canvas.dispatch("click", { clientX: 4, clientY: 4 });
  assert.equal(draws.length, before);
  vm.runInContext("releaseBlockRenderer()", context);
  assert.equal(disconnected, true);
  assert.equal(destroyed, true);
  assert.equal(annotations.removed, true);
  assert.equal(readout.removed, true);
  assert.equal(viewport.listeners.get("pointermove").length, 0);
});

test("property rows omit empty placeholders but retain zero and false", async () => {
  const { context } = await client(async () => health());
  const markup = vm.runInContext('propertyRows([["Zero", 0], ["Flag", false], ["Empty", null], ["Missing", undefined], ["Dash", "—"]])', context);
  assert.match(markup, />0</);
  assert.match(markup, />false</);
  assert.doesNotMatch(markup, /Empty|Missing|Dash/);
});

test("preview defers luma computation until statistics are expanded", async () => {
  let statsRequests = 0;
  const { context, app, elements } = await client(async (url) => {
    if (url === "/api/health") return health();
    assert.match(url, /frame-stats/);
    statsRequests++;
    return Response.json({ histogram: [3, 1], minimum: 0, maximum: 1, mean: 0.25, standardDeviation: 0.4 });
  });
  const viewport = elements.get("viewport-content");
  const nodes = new Map();
  viewport.querySelector = (selector) => {
    if (!nodes.has(selector)) {
      const value = new viewport.constructor();
      value.style = {};
      value.insertAdjacentHTML = (_position, markup) => { value.markup += markup; };
      value.parentElement = { insertAdjacentHTML() {} };
      nodes.set(selector, value);
    }
    return nodes.get(selector);
  };
  app.state.view = "frame";
  app.state.selectedFrameId = 0;
  app.state.report = { frames: [{ frameId: 0, timestamp: 0, declaredSize: 100, obuIds: [] }], obus: [], syntaxNodes: [], container: { width: 256, height: 256 } };
  app.state.previews.set(0, { status: "ready", url: "blob:test" });
  app.state.analysisMode = "simple-motion";
  app.state.showMotionVectors = false;
  await vm.runInContext("renderFramePreview()", context);
  assert.equal(app.state.analysisMode, "simple-motion", "a frame without block data must not overwrite the requested mode");
  assert.equal(app.state.overlayLayer, "none", "a frame without blocks displays the decoded picture");
  assert.equal(app.state.showMotionVectors, false, "rendering must not overwrite the user's vector toggle");
  assert.equal(statsRequests, 0);
  const details = nodes.get("#luma-details");
  assert.match(nodes.get(".frame-preview").markup, /<details[^>]+id="luma-details"><summary>Luma statistics/);
  details.open = true;
  await details.dispatch("toggle");
  while (app.state.controllers.size) await new Promise(setImmediate);
  assert.equal(statsRequests, 1);
  assert.match(details.markup, /Luma histogram/);
  await details.dispatch("toggle");
  assert.equal(statsRequests, 1);
});

// Exercise the real rendering/selection code; only geometry and WebGL are stubbed.
function picturePreviewDom({ elements, context }) {
  const viewport = elements.get("viewport-content"), nodes = new Map();
  const markup = Object.getOwnPropertyDescriptor(viewport.constructor.prototype, "innerHTML");
  Object.defineProperty(viewport, "innerHTML", {
    get() { return markup.get.call(this); },
    set(value) { markup.set.call(this, value); nodes.clear(); },
  });
  viewport.querySelector = (selector) => {
    if (!nodes.has(selector)) {
      const node = new viewport.constructor();
      node.insertAdjacentHTML = (_position, text) => { node.markup += text; };
      node.parentElement = { insertAdjacentHTML() {} };
      nodes.set(selector, node);
    }
    return nodes.get(selector);
  };
  context.setupBlockOverlay = (blocks) => { context.window.drawnPictureBlocks = blocks; };
  return { viewport, nodes };
}

async function hiddenPictureSample(t) {
  try { return await readFile(new URL("../media/test_256x256_av1.ivf", import.meta.url)); }
  catch (error) { if (error.code !== "ENOENT") throw error; t.skip("local test media is not installed"); return null; }
}

test("real hidden-picture OBU and dropdown selection change preview without leaving the packet", async (t) => {
  const bytes = await hiddenPictureSample(t);
  if (!bytes) return;
  const report = await analyzeGuiBuffer(bytes, "test_256x256_av1.ivf");
  const requests = [];
  const harness = await client(async (url) => {
    if (url === "/api/health") return health();
    requests.push(url);
    if (url.startsWith("/api/frame-stats")) return Response.json({ histogram: [1], minimum: 0, maximum: 0, mean: 0, standardDeviation: 0 });
    return new Response(new Blob([url]));
  });
  const { app, elements, context } = harness;
  const { viewport, nodes } = picturePreviewDom(harness);
  app.state.report = report;
  app.state.bytes = bytes;
  app.state.file = { name: "test_256x256_av1.ivf" };
  app.state.view = "frame";
  app.state.analysisMode = "predictions";
  app.state.overlay = { frames: [{ frameId: 1, blocks: [{ blockId: 1, x: 0, y: 0, width: 64, height: 64, plane: 0, mode: "inter", refs: [1], mv: [] }] }] };
  const settle = async () => { while (app.state.controllers.size) await new Promise(setImmediate); };
  vm.runInContext("selectFrame(1)", context);
  await settle();
  assert.equal(app.state.selection.id, 7);
  assert.match(viewport.innerHTML, /shown picture · Header OBU 7/);
  assert.match(viewport.innerHTML, /class="block-overlay"/);
  const shownUrl = app.state.previews.get("picture:7").url;
  for (const [obuId, displayIndex, name] of [[4, 8, "1"], [5, 4, "2"], [6, 2, "3"]]) {
    if (obuId === 4) await elements.get("structure-tree").querySelector(`[data-obu-id="${obuId}"]`).dispatch("click");
    else await nodes.get("#preview-picture").dispatch("change", { target: { value: String(obuId) } });
    await settle();
    assert.equal(app.state.selectedFrameId, 1);
    assert.equal(app.state.selection.id, obuId);
    assert.equal(requests.at(-1), `/api/preview?frame=${displayIndex}`);
    assert.match(viewport.innerHTML, new RegExp(`hidden picture ${name} · Header OBU ${obuId}`));
    assert.match(viewport.innerHTML, new RegExp(`<option value="${obuId}" selected>`));
    assert.match(viewport.innerHTML, /Block data unavailable for this picture/);
    assert.doesNotMatch(viewport.innerHTML, /class="block-overlay"/);
    assert.notEqual(app.state.previews.get(`picture:${obuId}`).url, shownUrl);
    assert.equal(vm.runInContext("referenceStateFor(1).obuId", context), obuId);
    assert.match(elements.get("timeline").nextSibling.innerHTML, new RegExp(`Viewing Frame 1 · hidden picture ${name}`));
    assert.doesNotMatch(elements.get("timeline").nextSibling.innerHTML, /Usage: \d+ inter/);
  }
  const details = nodes.get("#luma-details");
  details.open = true;
  await details.dispatch("toggle");
  await settle();
  assert.equal(requests.at(-1), "/api/frame-stats?frame=2");
  assert.match(details.markup, /Luma histogram/);
  let exported;
  context.downloadBlob = (_blob, filename) => { exported = filename; };
  await elements.get("png-button").dispatch("click");
  assert.equal(requests.at(-1), "/api/preview?frame=2");
  assert.match(exported, /frame-1.obu-6.png$/);
  const beforeReturn = requests.length;
  await nodes.get("#preview-picture").dispatch("change", { target: { value: "7" } });
  await settle();
  assert.equal(requests.length, beforeReturn, "shown picture reuses its own cache");
  assert.match(viewport.innerHTML, /class="block-overlay"/);
  assert.match(viewport.innerHTML, /shown picture · Header OBU 7/);
  assert.equal(app.state.analysisMode, "predictions");
  for (const preview of app.state.previews.values()) URL.revokeObjectURL(preview.url);
});

test("late hidden-picture previews cannot overwrite a newer selection and unmapped pictures stay unavailable", async (t) => {
  const bytes = await hiddenPictureSample(t);
  if (!bytes) return;
  const report = await analyzeGuiBuffer(bytes, "test_256x256_av1.ivf");
  const pending = [];
  const harness = await client(async (url, options) => url === "/api/health" ? health() : new Promise((resolve) => pending.push({ url, resolve, signal: options.signal })));
  const { app, context } = harness;
  const { viewport } = picturePreviewDom(harness);
  Object.assign(app.state, { report, bytes, view: "frame", selectedFrameId: 1, selection: { kind: "obu", id: 4 } });
  const old = vm.runInContext("renderFramePreview()", context);
  vm.runInContext("selectPicture(5)", context);
  assert.equal(pending[0].signal.aborted, true);
  assert.deepEqual(pending.map(({ url }) => url), ["/api/preview?frame=8", "/api/preview?frame=4"]);
  pending[1].resolve(new Response(new Blob(["H2"])));
  while (app.state.controllers.size) await new Promise(setImmediate);
  pending[0].resolve(new Response(new Blob(["late H1"])));
  await old;
  assert.equal(app.state.previews.has("picture:4"), false);
  assert.equal(app.state.previews.get("picture:5").status, "ready");
  assert.match(viewport.innerHTML, /hidden picture 2 · Header OBU 5/);
  const hidden = vm.runInContext("pictureStateIndex().obus.get(4).picture", context);
  hidden.previewIndex = null;
  hidden.previewFrameId = null;
  vm.runInContext("selectPicture(4)", context);
  assert.equal(pending.length, 2, "an unmapped hidden picture must not request the shown preview");
  assert.match(viewport.innerHTML, /Preview unavailable for this picture/);
  assert.doesNotMatch(viewport.innerHTML, /<img|class="block-overlay"/);
  assert.match(viewport.innerHTML, /id="preview-picture"/);
  for (const preview of app.state.previews.values()) URL.revokeObjectURL(preview.url);
});
