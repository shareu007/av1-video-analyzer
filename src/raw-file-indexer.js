import { open } from "node:fs/promises";
import path from "node:path";

import { Leb128Error, readLeb128 } from "./leb128.js";
import {
  IMPLEMENTATION,
  InputFormat,
  PARSER_NAME,
  PARSER_VERSION,
  SCHEMA_VERSION,
  Severity,
  byteRange,
  diagnostic,
} from "./model.js";
import { createObuRecord } from "./obu-parser.js";
import { computeSourceFingerprint } from "./source-fingerprint.js";

export class FileReadWindow {
  constructor(handle, size, { capacity = 64 * 1024, signal = null } = {}) {
    this.handle = handle;
    this.size = size;
    this.buffer = Buffer.allocUnsafe(capacity);
    this.signal = signal;
    this.start = 0;
    this.length = 0;
  }

  async read(position, length) {
    throwIfFileIndexCancelled(this.signal);
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) ||
        position < 0 || length < 0 || position > this.size) {
      throw new RangeError("invalid file read window range");
    }
    const available = Math.min(length, this.size - position);
    if (available === 0) return Buffer.alloc(0);
    if (position >= this.start && position + available <= this.start + this.length) {
      const offset = position - this.start;
      return this.buffer.subarray(offset, offset + available);
    }
    const requested = Math.min(this.buffer.length, this.size - position);
    const { bytesRead } = await this.handle.read(this.buffer, 0, requested, position);
    this.start = position;
    this.length = bytesRead;
    return this.buffer.subarray(0, Math.min(available, bytesRead));
  }
}

export function throwIfFileIndexCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error("streaming index cancelled");
  error.code = "INDEX_CANCELLED";
  error.statusCode = 499;
  throw error;
}

export async function* scanObuFileRange(
  reader,
  {
    start,
    end,
    frameId = null,
    allowUnsizedFinalObu = false,
    maxObus = Number.MAX_SAFE_INTEGER,
    nextObuId = 0,
    state = {},
    onDiagnostic = () => {},
  },
) {
  let cursor = start;
  let count = 0;
  state.nextObuId = nextObuId;
  state.limitReached = false;
  state.allComplete = true;
  while (cursor < end) {
    if (count >= maxObus) {
      onDiagnostic(diagnostic(
        "OBU_RECORD_LIMIT_REACHED", Severity.ERROR,
        "OBU indexing stopped because the configured record budget was reached",
        { range: byteRange(cursor, 0), frameId },
      ));
      state.limitReached = true;
      state.allComplete = false;
      break;
    }
    const obuId = state.nextObuId;
    state.nextObuId += 1;
    const obuStart = cursor;
    const firstBytes = await reader.read(cursor, 1);
    if (firstBytes.length === 0) throw new Error("input file changed while indexing an OBU header");
    const first = firstBytes[0];
    cursor += 1;
    const forbiddenBit = first >> 7;
    const typeCode = (first >> 3) & 0x0f;
    const extensionFlag = (first >> 2) & 1;
    const hasSizeField = (first >> 1) & 1;
    const reservedBit = first & 1;
    if (forbiddenBit !== 0) onDiagnostic(diagnostic(
      "OBU_FORBIDDEN_BIT_SET", Severity.ERROR, "obu_forbidden_bit must be zero",
      { range: byteRange(obuStart, 1), frameId, obuId },
    ));
    if (reservedBit !== 0) onDiagnostic(diagnostic(
      "OBU_RESERVED_BIT_SET", Severity.ERROR, "obu_reserved_1bit must be zero",
      { range: byteRange(obuStart, 1), frameId, obuId },
    ));
    if (typeCode === 0 || (typeCode >= 9 && typeCode <= 14)) onDiagnostic(diagnostic(
      "OBU_RESERVED_TYPE", Severity.WARNING, `OBU type ${typeCode} is reserved`,
      { range: byteRange(obuStart, 1), frameId, obuId },
    ));

    let temporalId = null;
    let spatialId = null;
    let headerLength = 1;
    if (extensionFlag) {
      const extensionBytes = await reader.read(cursor, 1);
      if (extensionBytes.length === 0 || cursor >= end) {
        const record = createObuRecord({
          obuId, frameId, typeCode, forbiddenBit, extensionFlag, hasSizeField,
          reservedBit, temporalId, spatialId, start: obuStart, headerLength,
          sizeFieldStart: cursor, sizeFieldLength: 0, payloadStart: cursor,
          actualPayloadLength: 0, declaredPayloadSize: null, complete: false,
        });
        count += 1;
        state.allComplete = false;
        onDiagnostic(diagnostic(
          "OBU_EXTENSION_TRUNCATED", Severity.ERROR, "OBU extension header is missing",
          { range: byteRange(cursor, 0), frameId, obuId },
        ));
        yield record;
        break;
      }
      const extension = extensionBytes[0];
      temporalId = (extension >> 5) & 0x07;
      spatialId = (extension >> 3) & 0x03;
      cursor += 1;
      headerLength += 1;
      if ((extension & 0x07) !== 0) onDiagnostic(diagnostic(
        "OBU_EXTENSION_RESERVED_BITS_SET", Severity.ERROR,
        "OBU extension reserved bits must be zero",
        { range: byteRange(cursor - 1, 1), frameId, obuId },
      ));
    }

    const sizeFieldStart = cursor;
    if (!hasSizeField) {
      const actualPayloadLength = allowUnsizedFinalObu ? end - cursor : 0;
      const complete = allowUnsizedFinalObu;
      const record = createObuRecord({
        obuId, frameId, typeCode, forbiddenBit, extensionFlag, hasSizeField,
        reservedBit, temporalId, spatialId, start: obuStart, headerLength,
        sizeFieldStart, sizeFieldLength: 0, payloadStart: cursor,
        actualPayloadLength, declaredPayloadSize: null, complete,
      });
      count += 1;
      state.allComplete &&= complete;
      onDiagnostic(diagnostic(
        complete ? "OBU_BOUNDARY_FROM_CONTAINER" : "OBU_SIZE_FIELD_REQUIRED",
        complete ? Severity.INFO : Severity.ERROR,
        complete
          ? "OBU payload consumes the remaining container sample"
          : "A raw low-overhead OBU requires obu_has_size_field to locate its boundary",
        { range: byteRange(obuStart, complete ? end - obuStart : headerLength), frameId, obuId },
      ));
      yield record;
      break;
    }

    const encodedSize = await reader.read(cursor, Math.min(8, end - cursor));
    let size;
    try {
      size = readLeb128(encodedSize, 0, encodedSize.length);
    } catch (error) {
      if (!(error instanceof Leb128Error)) throw error;
      const sizeFieldLength = error.length;
      const payloadStart = Math.min(sizeFieldStart + sizeFieldLength, end);
      const record = createObuRecord({
        obuId, frameId, typeCode, forbiddenBit, extensionFlag, hasSizeField,
        reservedBit, temporalId, spatialId, start: obuStart, headerLength,
        sizeFieldStart, sizeFieldLength, payloadStart, actualPayloadLength: 0,
        declaredPayloadSize: null, complete: false,
      });
      count += 1;
      state.allComplete = false;
      onDiagnostic(diagnostic(error.code, Severity.ERROR, error.message, {
        range: byteRange(sizeFieldStart + error.start, error.length), frameId, obuId,
      }));
      yield record;
      break;
    }
    cursor += size.length;
    const payloadStart = cursor;
    const availablePayloadLength = end - payloadStart;
    const actualPayloadLength = Math.min(size.value, availablePayloadLength);
    const complete = size.value <= availablePayloadLength;
    const record = createObuRecord({
      obuId, frameId, typeCode, forbiddenBit, extensionFlag, hasSizeField,
      reservedBit, temporalId, spatialId, start: obuStart, headerLength,
      sizeFieldStart, sizeFieldLength: size.length, payloadStart,
      actualPayloadLength, declaredPayloadSize: size.value, complete,
    });
    count += 1;
    state.allComplete &&= complete;
    yield record;
    cursor = payloadStart + actualPayloadLength;
    if (!complete) {
      onDiagnostic(diagnostic(
        "OBU_PAYLOAD_TRUNCATED", Severity.ERROR,
        `OBU declares ${size.value} payload bytes but only ${availablePayloadLength} remain`,
        { range: byteRange(payloadStart, availablePayloadLength), frameId, obuId },
      ));
      break;
    }
  }
  state.count = count;
  state.cursor = cursor;
}

function looksLikeContainer(prefix) {
  return (prefix.length >= 4 && prefix.toString("ascii", 0, 4) === "DKIF") ||
    (prefix.length >= 8 && prefix.toString("ascii", 4, 8) === "ftyp") ||
    (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));
}

export async function createRawFileSnapshotInput(
  inputPath,
  { maxObus = 250_000, signal = null, sourceName = path.basename(inputPath) } = {},
) {
  if (!Number.isSafeInteger(maxObus) || maxObus < 1) {
    throw new RangeError("maxObus must be a positive safe integer");
  }
  throwIfFileIndexCancelled(signal);
  const handle = await open(inputPath, "r");
  const metadata = await handle.stat();
  const sourceSize = metadata.size;
  if (!Number.isSafeInteger(sourceSize)) {
    await handle.close();
    throw new RangeError("input file size exceeds the safe integer range");
  }
  const reader = new FileReadWindow(handle, sourceSize, { signal });
  let sourceFingerprint;
  let prefix;
  try {
    sourceFingerprint = await computeSourceFingerprint(inputPath);
    throwIfFileIndexCancelled(signal);
    prefix = await reader.read(0, Math.min(12, sourceSize));
  } catch (error) {
    await handle.close();
    throw error;
  }
  if (looksLikeContainer(prefix)) {
    await handle.close();
    throw new Error("stream index currently supports raw low-overhead OBU input only");
  }

  const state = {
    consumed: false,
    finished: false,
    obuCount: 0,
    allComplete: true,
    diagnostics: [diagnostic(
      "SYNTAX_INDEX_DEFERRED",
      Severity.INFO,
      "Streaming index stores OBU ranges first; payload syntax is parsed on a later deep-analysis path",
    )],
  };

  const pushDiagnostic = (code, severity, message, options = {}) => {
    state.diagnostics.push(diagnostic(code, severity, message, options));
  };

  async function* obus() {
    if (state.consumed) throw new Error("raw OBU file index stream can only be consumed once");
    state.consumed = true;
    let cursor = 0;
    let completedScan = false;
    try {
      if (sourceSize === 0) {
        pushDiagnostic("INPUT_EMPTY", Severity.ERROR, "Input contains no bytes", {
          range: byteRange(0, 0),
        });
      }
      while (cursor < sourceSize) {
        throwIfFileIndexCancelled(signal);
        if (state.obuCount >= maxObus) {
          pushDiagnostic(
            "OBU_RECORD_LIMIT_REACHED",
            Severity.ERROR,
            "OBU indexing stopped because the configured record budget was reached",
            { range: byteRange(cursor, 0) },
          );
          state.allComplete = false;
          break;
        }
        const obuId = state.obuCount;
        const obuStart = cursor;
        const first = (await reader.read(cursor, 1))[0];
        cursor += 1;
        const forbiddenBit = first >> 7;
        const typeCode = (first >> 3) & 0x0f;
        const extensionFlag = (first >> 2) & 1;
        const hasSizeField = (first >> 1) & 1;
        const reservedBit = first & 1;
        if (forbiddenBit !== 0) pushDiagnostic(
          "OBU_FORBIDDEN_BIT_SET", Severity.ERROR, "obu_forbidden_bit must be zero",
          { range: byteRange(obuStart, 1), obuId },
        );
        if (reservedBit !== 0) pushDiagnostic(
          "OBU_RESERVED_BIT_SET", Severity.ERROR, "obu_reserved_1bit must be zero",
          { range: byteRange(obuStart, 1), obuId },
        );
        if (typeCode === 0 || (typeCode >= 9 && typeCode <= 14)) pushDiagnostic(
          "OBU_RESERVED_TYPE", Severity.WARNING, `OBU type ${typeCode} is reserved`,
          { range: byteRange(obuStart, 1), obuId },
        );

        let temporalId = null;
        let spatialId = null;
        let headerLength = 1;
        if (extensionFlag) {
          const extensionBytes = await reader.read(cursor, 1);
          if (extensionBytes.length === 0) {
            const record = createObuRecord({
              obuId, frameId: null, typeCode, forbiddenBit, extensionFlag, hasSizeField,
              reservedBit, temporalId, spatialId, start: obuStart, headerLength,
              sizeFieldStart: cursor, sizeFieldLength: 0, payloadStart: cursor,
              actualPayloadLength: 0, declaredPayloadSize: null, complete: false,
            });
            state.obuCount += 1;
            state.allComplete = false;
            pushDiagnostic("OBU_EXTENSION_TRUNCATED", Severity.ERROR, "OBU extension header is missing", {
              range: byteRange(cursor, 0), obuId,
            });
            yield record;
            break;
          }
          const extension = extensionBytes[0];
          temporalId = (extension >> 5) & 0x07;
          spatialId = (extension >> 3) & 0x03;
          cursor += 1;
          headerLength += 1;
          if ((extension & 0x07) !== 0) pushDiagnostic(
            "OBU_EXTENSION_RESERVED_BITS_SET", Severity.ERROR,
            "OBU extension reserved bits must be zero",
            { range: byteRange(cursor - 1, 1), obuId },
          );
        }

        const sizeFieldStart = cursor;
        if (!hasSizeField) {
          const record = createObuRecord({
            obuId, frameId: null, typeCode, forbiddenBit, extensionFlag, hasSizeField,
            reservedBit, temporalId, spatialId, start: obuStart, headerLength,
            sizeFieldStart, sizeFieldLength: 0, payloadStart: cursor,
            actualPayloadLength: 0, declaredPayloadSize: null, complete: false,
          });
          state.obuCount += 1;
          state.allComplete = false;
          pushDiagnostic(
            "OBU_SIZE_FIELD_REQUIRED", Severity.ERROR,
            "A raw low-overhead OBU requires obu_has_size_field to locate its boundary",
            { range: byteRange(obuStart, headerLength), obuId },
          );
          yield record;
          break;
        }

        const encodedSize = await reader.read(cursor, Math.min(8, sourceSize - cursor));
        let size;
        try {
          size = readLeb128(encodedSize, 0, encodedSize.length);
        } catch (error) {
          if (!(error instanceof Leb128Error)) throw error;
          const sizeFieldLength = error.length;
          const payloadStart = Math.min(sizeFieldStart + sizeFieldLength, sourceSize);
          const record = createObuRecord({
            obuId, frameId: null, typeCode, forbiddenBit, extensionFlag, hasSizeField,
            reservedBit, temporalId, spatialId, start: obuStart, headerLength,
            sizeFieldStart, sizeFieldLength, payloadStart, actualPayloadLength: 0,
            declaredPayloadSize: null, complete: false,
          });
          state.obuCount += 1;
          state.allComplete = false;
          pushDiagnostic(error.code, Severity.ERROR, error.message, {
            range: byteRange(sizeFieldStart + error.start, error.length), obuId,
          });
          yield record;
          break;
        }
        cursor += size.length;
        const payloadStart = cursor;
        const availablePayloadLength = sourceSize - payloadStart;
        const actualPayloadLength = Math.min(size.value, availablePayloadLength);
        const complete = size.value <= availablePayloadLength;
        const record = createObuRecord({
          obuId, frameId: null, typeCode, forbiddenBit, extensionFlag, hasSizeField,
          reservedBit, temporalId, spatialId, start: obuStart, headerLength,
          sizeFieldStart, sizeFieldLength: size.length, payloadStart,
          actualPayloadLength, declaredPayloadSize: size.value, complete,
        });
        state.obuCount += 1;
        state.allComplete &&= complete;
        yield record;
        cursor = payloadStart + actualPayloadLength;
        if (!complete) {
          pushDiagnostic(
            "OBU_PAYLOAD_TRUNCATED", Severity.ERROR,
            `OBU declares ${size.value} payload bytes but only ${availablePayloadLength} remain`,
            { range: byteRange(payloadStart, availablePayloadLength), obuId },
          );
          break;
        }
      }
      completedScan = true;
    } finally {
      state.finished = completedScan;
      await handle.close();
    }
  }

  async function* diagnostics() {
    if (!state.finished) throw new Error("raw OBU records must be consumed before diagnostics");
    yield* state.diagnostics;
  }

  const header = () => {
    if (!state.finished) throw new Error("raw OBU records must be consumed before snapshot header");
    const errorCount = state.diagnostics.filter(
      ({ severity }) => severity === Severity.ERROR || severity === Severity.FATAL,
    ).length;
    const warningCount = state.diagnostics.filter(({ severity }) => severity === Severity.WARNING).length;
    return {
      schemaVersion: SCHEMA_VERSION,
      source: {
        name: sourceName, size: sourceSize,
        format: InputFormat.LOW_OVERHEAD_OBU, fingerprint: sourceFingerprint,
      },
      container: null,
      summary: {
        frameCount: 0,
        obuCount: state.obuCount,
        errorCount,
        warningCount,
        complete: errorCount === 0 && state.allComplete,
      },
      provenance: {
        parser: PARSER_NAME,
        parserVersion: PARSER_VERSION,
        implementation: `${IMPLEMENTATION}-streaming-index`,
      },
    };
  };

  return {
    header,
    collections: { frames: [], obus: obus(), syntaxNodes: [], diagnostics: diagnostics() },
  };
}
