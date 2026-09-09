import assert from "node:assert/strict";
import test from "node:test";

import { parseObuSequence } from "../src/obu-parser.js";
import { makeObu } from "./fixtures.js";

test("parses multiple sized OBUs with precise byte ranges", () => {
  const sequenceHeader = makeObu({
    type: 1,
    payload: Buffer.from([0xaa, 0xbb]),
  });
  const frame = makeObu({
    type: 6,
    payload: Buffer.from([0x10, 0x20, 0x30]),
    extension: { temporalId: 3, spatialId: 2 },
  });
  const input = Buffer.concat([sequenceHeader, frame]);
  const result = parseObuSequence(input);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.obus.length, 2);
  assert.deepEqual(result.obus[0].byteRange, { start: 0, length: 4 });
  assert.deepEqual(result.obus[0].headerRange, { start: 0, length: 1 });
  assert.deepEqual(result.obus[0].sizeFieldRange, { start: 1, length: 1 });
  assert.deepEqual(result.obus[0].payloadRange, { start: 2, length: 2 });
  assert.equal(result.obus[1].type.name, "frame");
  assert.equal(result.obus[1].header.temporalId, 3);
  assert.equal(result.obus[1].header.spatialId, 2);
  assert.deepEqual(result.obus[1].byteRange, { start: 4, length: 6 });
});

test("reports invalid header bits without losing the OBU record", () => {
  const input = makeObu({
    type: 1,
    payload: Buffer.alloc(0),
    forbiddenBit: 1,
    reservedBit: 1,
  });
  const result = parseObuSequence(input);

  assert.equal(result.obus.length, 1);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["OBU_FORBIDDEN_BIT_SET", "OBU_RESERVED_BIT_SET"],
  );
  assert.equal(result.obus[0].complete, true);
});

test("rejects an unsized raw OBU because its next boundary is unknown", () => {
  const input = makeObu({
    type: 6,
    payload: Buffer.from([1, 2, 3]),
    hasSizeField: false,
  });
  const result = parseObuSequence(input);

  assert.equal(result.obus.length, 1);
  assert.equal(result.obus[0].complete, false);
  assert.equal(result.obus[0].payloadRange.length, 0);
  assert.equal(result.diagnostics.at(-1).code, "OBU_SIZE_FIELD_REQUIRED");
});

test("uses a container sample boundary for an unsized final OBU", () => {
  const input = makeObu({
    type: 6,
    payload: Buffer.from([1, 2, 3]),
    hasSizeField: false,
  });
  const result = parseObuSequence(input, { allowUnsizedFinalObu: true });

  assert.equal(result.obus[0].complete, true);
  assert.deepEqual(result.obus[0].payloadRange, { start: 1, length: 3 });
  assert.equal(result.diagnostics[0].code, "OBU_BOUNDARY_FROM_CONTAINER");
});

test("clamps a truncated payload to available bytes", () => {
  const input = Buffer.from([0b00001010, 0x05, 0xaa, 0xbb]);
  const result = parseObuSequence(input);

  assert.equal(result.obus[0].declaredPayloadSize, 5);
  assert.deepEqual(result.obus[0].payloadRange, { start: 2, length: 2 });
  assert.equal(result.obus[0].complete, false);
  assert.equal(result.diagnostics.at(-1).code, "OBU_PAYLOAD_TRUNCATED");
});

test("reports a missing extension byte without reading past the source", () => {
  const result = parseObuSequence(Buffer.from([0b00110110]));

  assert.equal(result.obus.length, 1);
  assert.equal(result.obus[0].complete, false);
  assert.deepEqual(result.obus[0].headerRange, { start: 0, length: 1 });
  assert.equal(result.diagnostics[0].code, "OBU_EXTENSION_TRUNCATED");
});

test("reports non-zero extension reserved bits while preserving layer ids", () => {
  const input = makeObu({
    type: 6,
    payload: Buffer.alloc(0),
    extension: { temporalId: 5, spatialId: 3, reservedBits: 7 },
  });
  const result = parseObuSequence(input);

  assert.equal(result.obus[0].header.temporalId, 5);
  assert.equal(result.obus[0].header.spatialId, 3);
  assert.equal(result.obus[0].complete, true);
  assert.equal(result.diagnostics[0].code, "OBU_EXTENSION_RESERVED_BITS_SET");
});

test("stops before the next OBU when the record budget is reached", () => {
  const unit = makeObu({ type: 2 });
  const result = parseObuSequence(Buffer.concat([unit, unit, unit]), { maxObus: 2 });

  assert.equal(result.obus.length, 2);
  assert.equal(result.nextObuId, 2);
  assert.equal(result.limitReached, true);
  assert.equal(result.diagnostics.at(-1).code, "OBU_RECORD_LIMIT_REACHED");
  assert.deepEqual(result.diagnostics.at(-1).byteRange, { start: unit.length * 2, length: 0 });
});

test("rejects invalid OBU record budgets", () => {
  assert.throws(() => parseObuSequence(Buffer.alloc(0), { maxObus: -1 }), /maxObus/);
});
