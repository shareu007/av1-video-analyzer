import { open } from "node:fs/promises";
import path from "node:path";

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
import {
  FileReadWindow,
  scanObuFileRange,
  throwIfFileIndexCancelled,
} from "./raw-file-indexer.js";
import { computeSourceFingerprint } from "./source-fingerprint.js";
import { createFrameStatisticsAccumulator } from "./frame-statistics.js";

const IVF_HEADER_LENGTH = 32;
const IVF_FRAME_HEADER_LENGTH = 12;

export async function createIvfFileSnapshotInput(
  inputPath,
  {
    maxFrames = 250_000,
    maxObus = 250_000,
    signal = null,
    sourceName = path.basename(inputPath),
  } = {},
) {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 ||
      !Number.isSafeInteger(maxObus) || maxObus < 1) {
    throw new RangeError("maxFrames and maxObus must be positive safe integers");
  }
  throwIfFileIndexCancelled(signal);
  const preflightHandle = await open(inputPath, "r");
  const metadata = await preflightHandle.stat();
  const sourceSize = metadata.size;
  if (!Number.isSafeInteger(sourceSize)) {
    await preflightHandle.close();
    throw new RangeError("input file size exceeds the safe integer range");
  }
  const preflightReader = new FileReadWindow(preflightHandle, sourceSize, { signal });
  const fileHeader = Buffer.from(await preflightReader.read(0, Math.min(IVF_HEADER_LENGTH, sourceSize)));
  await preflightHandle.close();
  const sourceFingerprint = await computeSourceFingerprint(inputPath);
  throwIfFileIndexCancelled(signal);
  if (fileHeader.length < 4 || fileHeader.toString("ascii", 0, 4) !== "DKIF") {
    throw new Error("streaming IVF index requires a DKIF input");
  }

  const diagnostics = [diagnostic(
    "SYNTAX_INDEX_DEFERRED",
    Severity.INFO,
    "Streaming index stores frame and OBU ranges first; payload syntax is parsed later",
  )];
  let container = null;
  let validHeader = fileHeader.length >= IVF_HEADER_LENGTH;
  let headerLength = IVF_HEADER_LENGTH;
  let declaredFrameCount = 0;
  if (!validHeader) {
    diagnostics.push(diagnostic(
      "IVF_HEADER_TRUNCATED", Severity.FATAL,
      `IVF header requires ${IVF_HEADER_LENGTH} bytes`,
      { range: byteRange(0, fileHeader.length) },
    ));
  } else {
    const version = fileHeader.readUInt16LE(4);
    headerLength = fileHeader.readUInt16LE(6);
    const codec = fileHeader.toString("ascii", 8, 12);
    const width = fileHeader.readUInt16LE(12);
    const height = fileHeader.readUInt16LE(14);
    const timebaseRate = fileHeader.readUInt32LE(16);
    const timebaseScale = fileHeader.readUInt32LE(20);
    declaredFrameCount = fileHeader.readUInt32LE(24);
    if (version !== 0) diagnostics.push(diagnostic(
      "IVF_VERSION_UNSUPPORTED", Severity.WARNING,
      `IVF version ${version} is not the expected version 0`,
      { range: byteRange(4, 2) },
    ));
    if (headerLength < IVF_HEADER_LENGTH) {
      diagnostics.push(diagnostic(
        "IVF_HEADER_LENGTH_INVALID", Severity.FATAL,
        `IVF header length ${headerLength} is smaller than 32`,
        { range: byteRange(6, 2) },
      ));
      validHeader = false;
    } else if (headerLength > sourceSize) {
      diagnostics.push(diagnostic(
        "IVF_HEADER_TRUNCATED", Severity.FATAL,
        `IVF declares a ${headerLength}-byte header but the file has ${sourceSize} bytes`,
        { range: byteRange(0, sourceSize) },
      ));
      validHeader = false;
    }
    if (codec !== "AV01") diagnostics.push(diagnostic(
      "IVF_CODEC_NOT_AV1", Severity.ERROR,
      `IVF codec is ${JSON.stringify(codec)}, expected AV01`,
      { range: byteRange(8, 4) },
    ));
    if (width === 0 || height === 0) diagnostics.push(diagnostic(
      "IVF_DIMENSIONS_ZERO", Severity.WARNING,
      `IVF dimensions are ${width}x${height}`,
      { range: byteRange(12, 4) },
    ));
    if (timebaseRate === 0 || timebaseScale === 0) diagnostics.push(diagnostic(
      "IVF_TIMEBASE_INVALID", Severity.WARNING,
      `IVF timebase rate/scale is ${timebaseRate}/${timebaseScale}`,
      { range: byteRange(16, 8) },
    ));
    if (validHeader) container = {
      type: InputFormat.IVF,
      version,
      headerLength,
      codec,
      width,
      height,
      timebase: { rate: timebaseRate, scale: timebaseScale },
      declaredFrameCount,
    };
  }

  const state = {
    frameScanFinished: false,
    obuScanFinished: false,
    frameCount: 0,
    obuCount: 0,
    allFramesComplete: true,
    allObusComplete: true,
  };
  const frameStatistics = createFrameStatisticsAccumulator({
    container,
    // The declared IVF count is advisory, so use the bounded unknown-length sampler.
    totalFrameCount: validHeader ? null : 0,
  });

  async function* frames() {
    if (!validHeader) {
      state.frameScanFinished = true;
      return;
    }
    const handle = await open(inputPath, "r");
    const reader = new FileReadWindow(handle, sourceSize, { signal });
    let cursor = headerLength;
    let nextObuId = 0;
    try {
      while (cursor < sourceSize) {
        throwIfFileIndexCancelled(signal);
        if (state.frameCount >= maxFrames) {
          diagnostics.push(diagnostic(
            "FRAME_RECORD_LIMIT_REACHED", Severity.ERROR,
            "Frame indexing stopped because the configured frame-record budget was reached",
            { range: byteRange(cursor, 0), frameId: state.frameCount },
          ));
          break;
        }
        const frameId = state.frameCount;
        const frameHeader = await reader.read(cursor, IVF_FRAME_HEADER_LENGTH);
        if (frameHeader.length < IVF_FRAME_HEADER_LENGTH) {
          diagnostics.push(diagnostic(
            "IVF_FRAME_HEADER_TRUNCATED", Severity.ERROR,
            `Only ${frameHeader.length} bytes remain for an IVF frame header`,
            { range: byteRange(cursor, frameHeader.length), frameId },
          ));
          break;
        }
        const frameStart = cursor;
        const declaredSize = frameHeader.readUInt32LE(0);
        const timestamp = frameHeader.readBigUInt64LE(4).toString(10);
        const payloadStart = cursor + IVF_FRAME_HEADER_LENGTH;
        const available = sourceSize - payloadStart;
        const actualSize = Math.min(declaredSize, available);
        const complete = declaredSize <= available;
        const obuIds = [];
        const scanState = {};
        for await (const obu of scanObuFileRange(reader, {
          start: payloadStart,
          end: payloadStart + actualSize,
          frameId,
          allowUnsizedFinalObu: true,
          maxObus: Math.max(0, maxObus - nextObuId),
          nextObuId,
          state: scanState,
        })) obuIds.push(obu.obuId);
        nextObuId = scanState.nextObuId;
        state.frameCount += 1;
        state.allFramesComplete &&= complete;
        const record = {
          schemaVersion: SCHEMA_VERSION,
          frameId,
          decodeIndex: frameId,
          timestamp,
          pts: timestamp,
          dts: timestamp,
          duration: null,
          sampleRange: byteRange(frameStart, IVF_FRAME_HEADER_LENGTH + actualSize),
          payloadRange: byteRange(payloadStart, actualSize),
          declaredSize,
          complete,
          obuIds,
        };
        frameStatistics.add(record);
        yield record;
        cursor = payloadStart + actualSize;
        if (!complete) {
          diagnostics.push(diagnostic(
            "IVF_FRAME_PAYLOAD_TRUNCATED", Severity.ERROR,
            `Frame declares ${declaredSize} bytes but only ${available} remain`,
            { range: byteRange(payloadStart, available), frameId },
          ));
          break;
        }
        if (scanState.limitReached) break;
      }
      if (declaredFrameCount !== state.frameCount) diagnostics.push(diagnostic(
        "IVF_FRAME_COUNT_MISMATCH", Severity.WARNING,
        `IVF declares ${declaredFrameCount} frames but ${state.frameCount} were indexed`,
        { range: byteRange(24, 4) },
      ));
      state.frameScanFinished = true;
    } finally {
      await handle.close();
    }
  }

  async function* obus() {
    if (!state.frameScanFinished) throw new Error("IVF frame records must be consumed before OBU records");
    if (!validHeader) {
      state.obuScanFinished = true;
      return;
    }
    const handle = await open(inputPath, "r");
    const reader = new FileReadWindow(handle, sourceSize, { signal });
    let cursor = headerLength;
    let frameId = 0;
    let nextObuId = 0;
    try {
      while (cursor < sourceSize && frameId < state.frameCount) {
        throwIfFileIndexCancelled(signal);
        const frameHeader = await reader.read(cursor, IVF_FRAME_HEADER_LENGTH);
        if (frameHeader.length < IVF_FRAME_HEADER_LENGTH) break;
        const declaredSize = frameHeader.readUInt32LE(0);
        const payloadStart = cursor + IVF_FRAME_HEADER_LENGTH;
        const actualSize = Math.min(declaredSize, sourceSize - payloadStart);
        const scanState = {};
        for await (const obu of scanObuFileRange(reader, {
          start: payloadStart,
          end: payloadStart + actualSize,
          frameId,
          allowUnsizedFinalObu: true,
          maxObus: Math.max(0, maxObus - nextObuId),
          nextObuId,
          state: scanState,
          onDiagnostic: (item) => diagnostics.push(item),
        })) {
          state.obuCount += 1;
          state.allObusComplete &&= obu.complete;
          yield obu;
        }
        nextObuId = scanState.nextObuId;
        cursor = payloadStart + actualSize;
        frameId += 1;
        if (declaredSize > actualSize || scanState.limitReached) break;
      }
      state.obuScanFinished = true;
    } finally {
      await handle.close();
    }
  }

  async function* diagnosticRecords() {
    if (!state.obuScanFinished) throw new Error("IVF OBU records must be consumed before diagnostics");
    yield* diagnostics;
  }

  const header = () => {
    if (!state.obuScanFinished) throw new Error("IVF OBU records must be consumed before snapshot header");
    const errorCount = diagnostics.filter(
      ({ severity }) => severity === Severity.ERROR || severity === Severity.FATAL,
    ).length;
    const warningCount = diagnostics.filter(({ severity }) => severity === Severity.WARNING).length;
    return {
      schemaVersion: SCHEMA_VERSION,
      source: {
        name: sourceName, size: sourceSize,
        format: InputFormat.IVF, fingerprint: sourceFingerprint,
      },
      container,
      summary: {
        frameCount: state.frameCount,
        obuCount: state.obuCount,
        errorCount,
        warningCount,
        complete: errorCount === 0 && state.allFramesComplete && state.allObusComplete,
      },
      frameStatistics: frameStatistics.finish(),
      provenance: {
        parser: PARSER_NAME,
        parserVersion: PARSER_VERSION,
        implementation: `${IMPLEMENTATION}-streaming-index`,
      },
    };
  };

  return {
    header,
    collections: {
      frames: frames(),
      obus: obus(),
      syntaxNodes: [],
      diagnostics: diagnosticRecords(),
    },
  };
}
