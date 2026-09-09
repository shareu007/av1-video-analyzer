export class Leb128Error extends Error {
  constructor(code, message, { start, length }) {
    super(message);
    this.name = "Leb128Error";
    this.code = code;
    this.start = start;
    this.length = length;
  }
}

export function readLeb128(buffer, offset, limit = buffer.length) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("readLeb128 expects a Buffer");
  }
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(limit) ||
    offset < 0 ||
    limit < offset ||
    limit > buffer.length
  ) {
    throw new RangeError("invalid LEB128 range");
  }

  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    const cursor = offset + index;
    if (cursor >= limit) {
      throw new Leb128Error(
        "LEB128_TRUNCATED",
        "LEB128 value ends before its terminating byte",
        { start: offset, length: cursor - offset },
      );
    }

    const byte = buffer[cursor];
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Leb128Error(
          "LEB128_VALUE_TOO_LARGE",
          "LEB128 value exceeds the safe integer range",
          { start: offset, length: index + 1 },
        );
      }
      return {
        value: Number(value),
        length: index + 1,
      };
    }
  }

  throw new Leb128Error(
    "LEB128_TOO_LONG",
    "AV1 LEB128 value uses more than eight bytes",
    { start: offset, length: Math.min(8, limit - offset) },
  );
}
