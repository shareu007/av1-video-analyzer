export class BitReader {
  #buffer;
  #startBit;
  #endBit;
  #position;

  constructor(buffer, { startByte = 0, lengthBytes = buffer.length - startByte } = {}) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError("BitReader expects a Buffer");
    }
    if (
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(lengthBytes) ||
      startByte < 0 ||
      lengthBytes < 0 ||
      startByte + lengthBytes > buffer.length
    ) {
      throw new RangeError("BitReader range is outside the buffer");
    }
    this.#buffer = buffer;
    this.#startBit = startByte * 8;
    this.#endBit = (startByte + lengthBytes) * 8;
    this.#position = this.#startBit;
  }

  get position() {
    return this.#position - this.#startBit;
  }

  get remaining() {
    return this.#endBit - this.#position;
  }

  readBit() {
    if (this.#position >= this.#endBit) {
      throw new RangeError("unexpected end of bit range");
    }
    const byteIndex = Math.floor(this.#position / 8);
    const bitIndex = 7 - (this.#position % 8);
    const value = (this.#buffer[byteIndex] >> bitIndex) & 1;
    this.#position += 1;
    return value;
  }

  readBits(count) {
    if (!Number.isInteger(count) || count < 0 || count > 53) {
      throw new RangeError("bit count must be between 0 and 53");
    }
    if (count > this.remaining) {
      throw new RangeError("unexpected end of bit range");
    }
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + this.readBit();
    }
    return value;
  }

  skipBits(count) {
    if (!Number.isInteger(count) || count < 0 || count > this.remaining) {
      throw new RangeError("cannot skip outside the bit range");
    }
    this.#position += count;
  }
}
