export function encodeLeb128(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("LEB128 fixture value must be a safe unsigned integer");
  }
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0n);
  return Buffer.from(bytes);
}

export function makeObu({
  type = 1,
  payload = Buffer.alloc(0),
  extension = null,
  hasSizeField = true,
  forbiddenBit = 0,
  reservedBit = 0,
} = {}) {
  const extensionFlag = extension === null ? 0 : 1;
  const header =
    ((forbiddenBit & 1) << 7) |
    ((type & 0x0f) << 3) |
    (extensionFlag << 2) |
    ((hasSizeField ? 1 : 0) << 1) |
    (reservedBit & 1);
  const parts = [Buffer.from([header])];
  if (extension !== null) {
    const extensionByte =
      ((extension.temporalId & 0x07) << 5) |
      ((extension.spatialId & 0x03) << 3) |
      (extension.reservedBits ?? 0);
    parts.push(Buffer.from([extensionByte]));
  }
  if (hasSizeField) {
    parts.push(encodeLeb128(payload.length));
  }
  parts.push(payload);
  return Buffer.concat(parts);
}

export function makeIvf(
  frames,
  {
    codec = "AV01",
    width = 64,
    height = 36,
    rate = 30,
    scale = 1,
    declaredFrameCount = frames.length,
    version = 0,
    headerLength = 32,
  } = {},
) {
  const header = Buffer.alloc(32);
  header.write("DKIF", 0, "ascii");
  header.writeUInt16LE(version, 4);
  header.writeUInt16LE(headerLength, 6);
  header.write(codec, 8, "ascii");
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header.writeUInt32LE(rate, 16);
  header.writeUInt32LE(scale, 20);
  header.writeUInt32LE(declaredFrameCount, 24);

  const frameBuffers = frames.map(({ payload, timestamp = 0n, declaredSize }) => {
    const frameHeader = Buffer.alloc(12);
    frameHeader.writeUInt32LE(declaredSize ?? payload.length, 0);
    frameHeader.writeBigUInt64LE(BigInt(timestamp), 4);
    return Buffer.concat([frameHeader, payload]);
  });
  return Buffer.concat([header, ...frameBuffers]);
}
