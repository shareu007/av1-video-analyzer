import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseObuSequence } from "../src/obu-parser.js";

const corpus = await readFile(
  new URL("./fixtures/obu-structural-golden-v1.tsv", import.meta.url),
  "utf8",
);

function optional(value) {
  return value === "-" ? null : Number(value);
}

function syntaxRecord(record) {
  const size = record.sizeFieldRange === null
    ? "-"
    : `${record.sizeFieldRange.start}:${record.sizeFieldRange.length}`;
  return [
    record.obuId,
    record.type.code,
    record.byteRange.start,
    record.byteRange.length,
    record.headerRange.start,
    record.headerRange.length,
    size,
    record.payloadRange.start,
    record.payloadRange.length,
    record.declaredPayloadSize ?? "-",
    Number(record.complete),
    record.header.temporalId ?? "-",
    record.header.spatialId ?? "-",
    record.syntaxStatus,
  ].join("/");
}

function syntaxDiagnostic(diagnostic) {
  return [
    diagnostic.code,
    `${diagnostic.byteRange.start}:${diagnostic.byteRange.length}`,
    diagnostic.obuId ?? "-",
    diagnostic.severity,
  ].join("@");
}

for (const line of corpus.split(/\r?\n/u)) {
  if (line.length === 0 || line.startsWith("#")) continue;
  const [
    name,
    hex,
    start,
    end,
    allowUnsized,
    maxObus,
    nextObuId,
    frameId,
    expectedRecords,
    expectedDiagnostics,
    expectedNextObuId,
    expectedLimitReached,
  ] = line.split("\t");

  test(`shared structural OBU Golden: ${name}`, () => {
    const input = Buffer.from(hex, "hex");
    const result = parseObuSequence(input, {
      start: Number(start),
      end: optional(end) ?? input.length,
      allowUnsizedFinalObu: allowUnsized === "1",
      nextObuId: Number(nextObuId),
      frameId: optional(frameId),
      maxObus: optional(maxObus) ?? Number.MAX_SAFE_INTEGER,
    });

    assert.equal(result.obus.map(syntaxRecord).join(";") || "-", expectedRecords);
    assert.equal(
      result.diagnostics.map(syntaxDiagnostic).join(";") || "-",
      expectedDiagnostics,
    );
    assert.equal(result.nextObuId, Number(expectedNextObuId));
    assert.equal(result.limitReached, expectedLimitReached === "1");
  });
}
