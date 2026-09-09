import { open } from "node:fs/promises";
import path from "node:path";

import { probeMediaFilePackets } from "./media-probe.js";
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

async function readMatroskaVint(reader, offset, { signed = false } = {}) {
  const firstBytes = await reader.read(offset, 1);
  if (firstBytes.length === 0) throw new RangeError("Matroska VINT is truncated");
  const first = firstBytes[0];
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8) throw new RangeError("Matroska VINT is invalid");
  const encoded = await reader.read(offset, length);
  if (encoded.length < length) throw new RangeError("Matroska VINT is truncated");
  let value = first & (0xff >> length);
  for (let index = 1; index < length; index += 1) value = value * 256 + encoded[index];
  if (!Number.isSafeInteger(value)) throw new RangeError("Matroska VINT exceeds safe integer precision");
  if (signed) value -= 2 ** (7 * length - 1) - 1;
  return { value, length };
}

async function matroskaLaceLayout(reader, sourceSize, packets) {
  const blockStart = Number(packets[0]?.pos);
  if (!Number.isSafeInteger(blockStart) || blockStart < 0 || blockStart >= sourceSize) {
    throw new RangeError("Matroska Block position is invalid");
  }
  const track = await readMatroskaVint(reader, blockStart);
  const flagsOffset = blockStart + track.length + 2;
  const flagBytes = await reader.read(flagsOffset, 1);
  if (flagBytes.length === 0) throw new RangeError("Matroska Block header is truncated");
  const mode = (flagBytes[0] & 0x06) >> 1;
  if (mode === 0) {
    if (packets.length !== 1) throw new RangeError("non-laced Matroska Block maps to multiple packets");
    return [{ start: flagsOffset + 1, length: Number(packets[0].size) }];
  }
  let cursor = flagsOffset + 1;
  const laceCountBytes = await reader.read(cursor, 1);
  if (laceCountBytes.length === 0) throw new RangeError("Matroska lace count is truncated");
  const laceCount = laceCountBytes[0] + 1;
  cursor += 1;
  if (packets.length !== laceCount) {
    throw new RangeError(`Matroska Block declares ${laceCount} laces but ffprobe exposed ${packets.length} packets`);
  }
  const packetSizes = packets.map(({ size }, index) => {
    const value = Number(size);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Matroska lace packet ${index} has invalid size`);
    }
    return value;
  });
  const encodedSizes = [];
  let lacing;
  if (mode === 1) {
    lacing = "xiph";
    for (let lace = 0; lace < laceCount - 1; lace += 1) {
      let size = 0;
      let part;
      do {
        const bytes = await reader.read(cursor, 1);
        if (bytes.length === 0) throw new RangeError("Xiph lace size is truncated");
        part = bytes[0];
        cursor += 1;
        size += part;
      } while (part === 255);
      encodedSizes.push(size);
    }
  } else if (mode === 2) {
    lacing = "fixed";
    if (packetSizes.some((size) => size !== packetSizes[0])) {
      throw new RangeError("fixed-size Matroska laces have unequal ffprobe packet sizes");
    }
  } else {
    lacing = "ebml";
    const firstSize = await readMatroskaVint(reader, cursor);
    cursor += firstSize.length;
    encodedSizes.push(firstSize.value);
    for (let lace = 1; lace < laceCount - 1; lace += 1) {
      const difference = await readMatroskaVint(reader, cursor, { signed: true });
      cursor += difference.length;
      encodedSizes.push(encodedSizes.at(-1) + difference.value);
    }
  }
  if (encodedSizes.some((size, index) => size !== packetSizes[index])) {
    throw new RangeError(`${lacing} Matroska lace sizes disagree with ffprobe packet sizes`);
  }
  const ranges = [];
  for (const length of packetSizes) {
    if (cursor + length > sourceSize) throw new RangeError("Matroska lace payload is truncated");
    ranges.push({ start: cursor, length });
    cursor += length;
  }
  return ranges;
}

async function adjustMatroskaPackets(inputPath, sourceSize, packets, diagnostics, signal) {
  const handle = await open(inputPath, "r");
  const reader = new FileReadWindow(handle, sourceSize, { signal });
  const groups = new Map();
  for (const packet of packets) {
    const key = String(packet.pos);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(packet);
  }
  const adjusted = [];
  let frameId = 0;
  try {
    for (const group of groups.values()) {
      throwIfFileIndexCancelled(signal);
      try {
        const ranges = await matroskaLaceLayout(reader, sourceSize, group);
        for (let index = 0; index < group.length; index += 1) {
          adjusted.push({
            ...group[index],
            pos: String(ranges[index].start),
            size: String(ranges[index].length),
          });
          frameId += 1;
        }
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        diagnostics.push(diagnostic(
          "MATROSKA_BLOCK_HEADER_INVALID", Severity.ERROR,
          `Packet group at ${group[0]?.pos ?? "unknown"} is not indexable: ${error.message}`,
          { frameId },
        ));
        frameId += group.length;
      }
    }
  } finally {
    await handle.close();
  }
  return adjusted;
}

export async function createContainerFileSnapshotInput(
  inputPath,
  format,
  {
    maxFrames = 250_000,
    maxObus = 250_000,
    probe = probeMediaFilePackets,
    ffprobePath = "ffprobe",
    signal = null,
    sourceName = path.basename(inputPath),
  } = {},
) {
  if (![InputFormat.ISOBMFF, InputFormat.MATROSKA].includes(format)) {
    throw new RangeError("container file indexer requires ISOBMFF or Matroska format");
  }
  throwIfFileIndexCancelled(signal);
  const handle = await open(inputPath, "r");
  const sourceSize = (await handle.stat()).size;
  await handle.close();
  if (!Number.isSafeInteger(sourceSize)) throw new RangeError("input file size exceeds the safe integer range");
  const sourceFingerprint = await computeSourceFingerprint(inputPath);
  throwIfFileIndexCancelled(signal);
  const metadata = await probe(inputPath, { signal, ffprobePath });
  const diagnostics = [diagnostic(
    "SYNTAX_INDEX_DEFERRED", Severity.INFO,
    "Streaming index stores packet and OBU ranges first; payload syntax is parsed later",
  )];
  const stream = metadata.streams?.[0] ?? null;
  if (!stream) diagnostics.push(diagnostic(
    "ISOBMFF_VIDEO_STREAM_MISSING", Severity.FATAL,
    "No video stream was found in the container input",
  ));
  else if (stream.codec_name !== "av1") diagnostics.push(diagnostic(
    "ISOBMFF_CODEC_NOT_AV1", Severity.FATAL,
    `Video codec is ${stream.codec_name ?? "unknown"}, expected av1`,
  ));
  const selected = stream?.codec_name === "av1"
    ? (metadata.packets ?? []).filter(
      ({ stream_index: index }) => index === undefined || index === stream.index,
    )
    : [];
  const packets = format === InputFormat.MATROSKA
    ? await adjustMatroskaPackets(inputPath, sourceSize, selected, diagnostics, signal)
    : selected;
  const state = {
    frameScanFinished: false,
    obuScanFinished: false,
    frameCount: 0,
    obuCount: 0,
    allFramesComplete: true,
    allObusComplete: true,
  };
  const statisticsContainer = stream ? {
    timebase: stream.time_base ?? null,
  } : null;
  const frameStatistics = createFrameStatisticsAccumulator({
    container: statisticsContainer,
    totalFrameCount: Math.min(packets.length, maxFrames),
  });

  async function* frames() {
    const file = await open(inputPath, "r");
    const reader = new FileReadWindow(file, sourceSize, { signal });
    let nextObuId = 0;
    try {
      for (const packet of packets) {
        throwIfFileIndexCancelled(signal);
        if (state.frameCount >= maxFrames) {
          diagnostics.push(diagnostic(
            "FRAME_RECORD_LIMIT_REACHED", Severity.ERROR,
            "Frame indexing stopped because the configured frame-record budget was reached",
            { frameId: state.frameCount },
          ));
          break;
        }
        const start = Number(packet.pos);
        const declaredSize = Number(packet.size);
        const frameId = state.frameCount;
        if (!Number.isSafeInteger(start) || start < 0 ||
            !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
          diagnostics.push(diagnostic(
            "ISOBMFF_PACKET_RANGE_INVALID", Severity.ERROR,
            `Packet ${frameId} has invalid pos/size metadata`, { frameId },
          ));
          continue;
        }
        const available = Math.max(0, sourceSize - start);
        const actualSize = Math.min(declaredSize, available);
        const complete = start <= sourceSize && actualSize === declaredSize;
        const obuIds = [];
        const scanState = {};
        for await (const obu of scanObuFileRange(reader, {
          start: Math.min(start, sourceSize),
          end: Math.min(start + actualSize, sourceSize),
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
          timestamp: String(packet.pts ?? packet.dts ?? frameId),
          pts: packet.pts === undefined || packet.pts === null ? null : String(packet.pts),
          dts: packet.dts === undefined || packet.dts === null ? null : String(packet.dts),
          duration: packet.duration === undefined || packet.duration === null
            ? null : String(packet.duration),
          sampleRange: byteRange(Math.min(start, sourceSize), actualSize),
          payloadRange: byteRange(Math.min(start, sourceSize), actualSize),
          declaredSize,
          complete,
          keyframe: String(packet.flags ?? "").startsWith("K"),
          obuIds,
        };
        frameStatistics.add(record);
        yield record;
        if (!complete) diagnostics.push(diagnostic(
          "ISOBMFF_PACKET_TRUNCATED", Severity.ERROR,
          `Packet declares ${declaredSize} bytes but only ${actualSize} are available`,
          { range: byteRange(Math.min(start, sourceSize), actualSize), frameId },
        ));
        if (!complete || scanState.limitReached) break;
      }
      state.frameScanFinished = true;
    } finally {
      await file.close();
    }
  }

  async function* obus() {
    if (!state.frameScanFinished) throw new Error("container frame records must be consumed before OBU records");
    const file = await open(inputPath, "r");
    const reader = new FileReadWindow(file, sourceSize, { signal });
    let nextObuId = 0;
    let frameId = 0;
    try {
      for (const packet of packets) {
        throwIfFileIndexCancelled(signal);
        if (frameId >= state.frameCount) break;
        const start = Number(packet.pos);
        const declaredSize = Number(packet.size);
        if (!Number.isSafeInteger(start) || start < 0 ||
            !Number.isSafeInteger(declaredSize) || declaredSize < 0) continue;
        const actualSize = Math.min(declaredSize, Math.max(0, sourceSize - start));
        const scanState = {};
        for await (const obu of scanObuFileRange(reader, {
          start: Math.min(start, sourceSize),
          end: Math.min(start + actualSize, sourceSize),
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
        frameId += 1;
        if (declaredSize > actualSize || scanState.limitReached) break;
      }
      state.obuScanFinished = true;
    } finally {
      await file.close();
    }
  }

  async function* diagnosticRecords() {
    if (!state.obuScanFinished) throw new Error("container OBU records must be consumed before diagnostics");
    yield* diagnostics;
  }

  const header = () => {
    if (!state.obuScanFinished) throw new Error("container OBU records must be consumed before snapshot header");
    const errorCount = diagnostics.filter(
      ({ severity }) => severity === Severity.ERROR || severity === Severity.FATAL,
    ).length;
    const warningCount = diagnostics.filter(({ severity }) => severity === Severity.WARNING).length;
    return {
      schemaVersion: SCHEMA_VERSION,
      source: {
        name: sourceName, size: sourceSize,
        format, fingerprint: sourceFingerprint,
      },
      container: stream ? {
        type: format,
        codec: stream.codec_name,
        width: stream.width ?? null,
        height: stream.height ?? null,
        timebase: stream.time_base ?? null,
        streamIndex: stream.index ?? 0,
      } : null,
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
      frames: frames(), obus: obus(), syntaxNodes: [], diagnostics: diagnosticRecords(),
    },
  };
}
