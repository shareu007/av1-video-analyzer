import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";

const corpus = await readFile(
  new URL("./fixtures/ivf-index-golden-v1.tsv", import.meta.url),
  "utf8",
);

function canonicalContainer(container) {
  if (container === null) return "-";
  return [
    container.version,
    container.headerLength,
    container.codec,
    container.width,
    container.height,
    container.timebase.rate,
    container.timebase.scale,
    container.declaredFrameCount,
  ].join("/");
}

function canonicalFrame(frame) {
  return [
    frame.frameId,
    frame.timestamp,
    `${frame.sampleRange.start}:${frame.sampleRange.length}`,
    `${frame.payloadRange.start}:${frame.payloadRange.length}`,
    frame.declaredSize,
    Number(frame.complete),
  ].join("/");
}

function canonicalDiagnostic(diagnostic) {
  return [
    diagnostic.code,
    diagnostic.severity,
    `${diagnostic.byteRange.start}:${diagnostic.byteRange.length}`,
    diagnostic.frameId ?? "-",
  ].join("@");
}

for (const line of corpus.split(/\r?\n/u)) {
  if (line.length === 0 || line.startsWith("#")) continue;
  const [name, hex, maxFrames, container, frames, diagnostics] = line.split("\t");
  test(`shared IVF index Golden: ${name}`, () => {
    const report = analyzeBuffer(Buffer.from(hex, "hex"), {
      maxFrames: Number(maxFrames),
    });
    const relevantDiagnostics = report.diagnostics.filter(
      ({ code }) => code.startsWith("IVF_") || code === "FRAME_RECORD_LIMIT_REACHED",
    );
    assert.equal(canonicalContainer(report.container), container);
    assert.equal(report.frames.map(canonicalFrame).join(";") || "-", frames);
    assert.equal(
      relevantDiagnostics.map(canonicalDiagnostic).join(";") || "-",
      diagnostics,
    );
  });
}
