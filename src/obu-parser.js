import { BitReader } from "./bit-reader.js";
import { Leb128Error, readLeb128 } from "./leb128.js";
import {
  SCHEMA_VERSION,
  Severity,
  byteRange,
  diagnostic,
  obuType,
} from "./model.js";

export function createObuRecord({
  obuId,
  frameId,
  typeCode,
  forbiddenBit,
  extensionFlag,
  hasSizeField,
  reservedBit,
  temporalId,
  spatialId,
  start,
  headerLength,
  sizeFieldStart,
  sizeFieldLength,
  payloadStart,
  actualPayloadLength,
  declaredPayloadSize,
  complete,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    obuId,
    frameId,
    type: obuType(typeCode),
    header: {
      forbiddenBit,
      extensionFlag,
      hasSizeField,
      reservedBit,
      temporalId,
      spatialId,
    },
    byteRange: byteRange(
      start,
      headerLength + sizeFieldLength + actualPayloadLength,
    ),
    headerRange: byteRange(start, headerLength),
    sizeFieldRange: hasSizeField
      ? byteRange(sizeFieldStart, sizeFieldLength)
      : null,
    payloadRange: byteRange(payloadStart, actualPayloadLength),
    declaredPayloadSize,
    complete,
    syntaxNodeIds: [],
    syntaxStatus:
      [1, 3, 4, 5, 6, 7].includes(typeCode) && complete
        ? "pending"
        : "not_applicable",
  };
}

export function parseObuSequence(
  buffer,
  {
    start = 0,
    end = buffer.length,
    frameId = null,
    allowUnsizedFinalObu = false,
    nextObuId = 0,
    maxObus = Number.MAX_SAFE_INTEGER,
  } = {},
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("parseObuSequence expects a Buffer");
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > buffer.length
  ) {
    throw new RangeError("invalid OBU sequence range");
  }
  if (!Number.isSafeInteger(maxObus) || maxObus < 0) {
    throw new RangeError("maxObus must be a non-negative safe integer");
  }

  const obus = [];
  const diagnostics = [];
  let cursor = start;
  let limitReached = false;

  while (cursor < end) {
    if (obus.length >= maxObus) {
      diagnostics.push(diagnostic(
        "OBU_RECORD_LIMIT_REACHED",
        Severity.ERROR,
        "OBU indexing stopped because the configured record budget was reached",
        { range: byteRange(cursor, 0), frameId },
      ));
      limitReached = true;
      break;
    }
    const obuId = nextObuId;
    nextObuId += 1;
    const obuStart = cursor;
    const reader = new BitReader(buffer, { startByte: cursor, lengthBytes: 1 });
    const forbiddenBit = reader.readBit();
    const typeCode = reader.readBits(4);
    const extensionFlag = reader.readBit();
    const hasSizeField = reader.readBit();
    const reservedBit = reader.readBit();
    cursor += 1;

    if (forbiddenBit !== 0) {
      diagnostics.push(
        diagnostic(
          "OBU_FORBIDDEN_BIT_SET",
          Severity.ERROR,
          "obu_forbidden_bit must be zero",
          { range: byteRange(obuStart, 1), frameId, obuId },
        ),
      );
    }
    if (reservedBit !== 0) {
      diagnostics.push(
        diagnostic(
          "OBU_RESERVED_BIT_SET",
          Severity.ERROR,
          "obu_reserved_1bit must be zero",
          { range: byteRange(obuStart, 1), frameId, obuId },
        ),
      );
    }
    if (typeCode === 0 || (typeCode >= 9 && typeCode <= 14)) {
      diagnostics.push(
        diagnostic(
          "OBU_RESERVED_TYPE",
          Severity.WARNING,
          `OBU type ${typeCode} is reserved`,
          { range: byteRange(obuStart, 1), frameId, obuId },
        ),
      );
    }

    let temporalId = null;
    let spatialId = null;
    let headerLength = 1;
    if (extensionFlag) {
      if (cursor >= end) {
        const record = createObuRecord({
          obuId,
          frameId,
          typeCode,
          forbiddenBit,
          extensionFlag,
          hasSizeField,
          reservedBit,
          temporalId,
          spatialId,
          start: obuStart,
          headerLength,
          sizeFieldStart: cursor,
          sizeFieldLength: 0,
          payloadStart: cursor,
          actualPayloadLength: 0,
          declaredPayloadSize: null,
          complete: false,
        });
        obus.push(record);
        diagnostics.push(
          diagnostic(
            "OBU_EXTENSION_TRUNCATED",
            Severity.ERROR,
            "OBU extension header is missing",
            { range: byteRange(cursor, 0), frameId, obuId },
          ),
        );
        break;
      }
      const extension = buffer[cursor];
      temporalId = (extension >> 5) & 0x07;
      spatialId = (extension >> 3) & 0x03;
      const extensionReserved = extension & 0x07;
      cursor += 1;
      headerLength += 1;
      if (extensionReserved !== 0) {
        diagnostics.push(
          diagnostic(
            "OBU_EXTENSION_RESERVED_BITS_SET",
            Severity.ERROR,
            "OBU extension reserved bits must be zero",
            { range: byteRange(cursor - 1, 1), frameId, obuId },
          ),
        );
      }
    }

    const sizeFieldStart = cursor;
    let sizeFieldLength = 0;
    let declaredPayloadSize = null;
    if (hasSizeField) {
      try {
        const size = readLeb128(buffer, cursor, end);
        sizeFieldLength = size.length;
        declaredPayloadSize = size.value;
        cursor += size.length;
      } catch (error) {
        if (!(error instanceof Leb128Error)) {
          throw error;
        }
        sizeFieldLength = error.length;
        const payloadStart = Math.min(sizeFieldStart + sizeFieldLength, end);
        obus.push(
          createObuRecord({
            obuId,
            frameId,
            typeCode,
            forbiddenBit,
            extensionFlag,
            hasSizeField,
            reservedBit,
            temporalId,
            spatialId,
            start: obuStart,
            headerLength,
            sizeFieldStart,
            sizeFieldLength,
            payloadStart,
            actualPayloadLength: 0,
            declaredPayloadSize: null,
            complete: false,
          }),
        );
        diagnostics.push(
          diagnostic(error.code, Severity.ERROR, error.message, {
            range: byteRange(error.start, error.length),
            frameId,
            obuId,
          }),
        );
        break;
      }
    } else if (!allowUnsizedFinalObu) {
      obus.push(
        createObuRecord({
          obuId,
          frameId,
          typeCode,
          forbiddenBit,
          extensionFlag,
          hasSizeField,
          reservedBit,
          temporalId,
          spatialId,
          start: obuStart,
          headerLength,
          sizeFieldStart,
          sizeFieldLength,
          payloadStart: cursor,
          actualPayloadLength: 0,
          declaredPayloadSize: null,
          complete: false,
        }),
      );
      diagnostics.push(
        diagnostic(
          "OBU_SIZE_FIELD_REQUIRED",
          Severity.ERROR,
          "A raw low-overhead OBU requires obu_has_size_field to locate its boundary",
          { range: byteRange(obuStart, headerLength), frameId, obuId },
        ),
      );
      break;
    }

    const payloadStart = cursor;
    if (!hasSizeField) {
      const actualPayloadLength = end - payloadStart;
      obus.push(
        createObuRecord({
          obuId,
          frameId,
          typeCode,
          forbiddenBit,
          extensionFlag,
          hasSizeField,
          reservedBit,
          temporalId,
          spatialId,
          start: obuStart,
          headerLength,
          sizeFieldStart,
          sizeFieldLength,
          payloadStart,
          actualPayloadLength,
          declaredPayloadSize: null,
          complete: true,
        }),
      );
      diagnostics.push(
        diagnostic(
          "OBU_BOUNDARY_FROM_CONTAINER",
          Severity.INFO,
          "OBU payload consumes the remaining container sample",
          { range: byteRange(obuStart, end - obuStart), frameId, obuId },
        ),
      );
      cursor = end;
      continue;
    }

    const availablePayloadLength = end - payloadStart;
    const actualPayloadLength = Math.min(
      declaredPayloadSize,
      availablePayloadLength,
    );
    const complete = declaredPayloadSize <= availablePayloadLength;
    obus.push(
      createObuRecord({
        obuId,
        frameId,
        typeCode,
        forbiddenBit,
        extensionFlag,
        hasSizeField,
        reservedBit,
        temporalId,
        spatialId,
        start: obuStart,
        headerLength,
        sizeFieldStart,
        sizeFieldLength,
        payloadStart,
        actualPayloadLength,
        declaredPayloadSize,
        complete,
      }),
    );

    cursor = payloadStart + actualPayloadLength;
    if (!complete) {
      diagnostics.push(
        diagnostic(
          "OBU_PAYLOAD_TRUNCATED",
          Severity.ERROR,
          `OBU declares ${declaredPayloadSize} payload bytes but only ${availablePayloadLength} remain`,
          {
            range: byteRange(payloadStart, availablePayloadLength),
            frameId,
            obuId,
          },
        ),
      );
      break;
    }
  }

  return { obus, diagnostics, nextObuId, limitReached };
}
