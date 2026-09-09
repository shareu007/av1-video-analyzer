import assert from "node:assert/strict";
import test from "node:test";

import { Leb128Error, readLeb128 } from "../src/leb128.js";
import { encodeLeb128 } from "./fixtures.js";

test("LEB128 round-trips representative AV1 payload sizes", () => {
  for (const expected of [0, 1, 127, 128, 255, 16_384, 1_000_000]) {
    const encoded = encodeLeb128(expected);
    assert.deepEqual(readLeb128(encoded, 0), {
      value: expected,
      length: encoded.length,
    });
  }
});

test("LEB128 reports truncation with a source range", () => {
  assert.throws(
    () => readLeb128(Buffer.from([0x80]), 0),
    (error) => {
      assert.ok(error instanceof Leb128Error);
      assert.equal(error.code, "LEB128_TRUNCATED");
      assert.equal(error.start, 0);
      assert.equal(error.length, 1);
      return true;
    },
  );
});

test("LEB128 is limited to eight bytes", () => {
  assert.throws(
    () => readLeb128(Buffer.alloc(9, 0x80), 0),
    (error) => error.code === "LEB128_TOO_LONG" && error.length === 8,
  );
});
