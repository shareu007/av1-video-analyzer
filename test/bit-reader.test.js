import assert from "node:assert/strict";
import test from "node:test";

import { BitReader } from "../src/bit-reader.js";

test("BitReader reads AV1 header bits most-significant-bit first", () => {
  const reader = new BitReader(Buffer.from([0b01010110]));
  assert.equal(reader.readBit(), 0);
  assert.equal(reader.readBits(4), 0b1010);
  assert.equal(reader.readBit(), 1);
  assert.equal(reader.readBit(), 1);
  assert.equal(reader.readBit(), 0);
  assert.equal(reader.remaining, 0);
});

test("BitReader enforces its selected byte range", () => {
  const reader = new BitReader(Buffer.from([0xff, 0x00]), {
    startByte: 1,
    lengthBytes: 1,
  });
  assert.equal(reader.readBits(8), 0);
  assert.throws(() => reader.readBit(), /unexpected end/);
});

test("BitReader rejects unsafe bit counts", () => {
  const reader = new BitReader(Buffer.from([0xff]));
  assert.throws(() => reader.readBits(54), /between 0 and 53/);
  assert.throws(() => reader.skipBits(9), /outside/);
});
