import path from "node:path";

import { probeMediaPackets } from "./media-probe.js";
import { demuxBufferInNativeWorker } from "./native-demux-worker.js";
import { parseMetadata } from "./metadata-parser.js";
import { parseObuSequence } from "./obu-parser.js";
import { parseSequenceHeader } from "./sequence-header-parser.js";
import { parseTileGroup } from "./tile-group-parser.js";
import { validateReportSemantics } from "./validator.js";
import {
  parseFrameHeaderPrefix,
  sequenceContextFromNodes,
} from "./frame-header-parser.js";
import {
  InputFormat,
  SCHEMA_VERSION,
  Severity,
  byteRange,
  diagnostic,
  finalizeReport,
} from "./model.js";

const IVF_SIGNATURE = "DKIF";
const IVF_CODEC = "AV01";
const IVF_MIN_HEADER_LENGTH = 32;
const IVF_FRAME_HEADER_LENGTH = 12;
export const DEFAULT_MAX_OBUS = 250_000;
export const DEFAULT_MAX_SYNTAX_NODES = 500_000;
export const DEFAULT_MAX_FRAMES = 250_000;

function validateAnalysisBudgets(maxObus, maxSyntaxNodes, maxFrames = DEFAULT_MAX_FRAMES) {
  if (!Number.isSafeInteger(maxObus) || maxObus < 1) throw new RangeError("maxObus must be a positive safe integer");
  if (!Number.isSafeInteger(maxSyntaxNodes) || maxSyntaxNodes < 1) throw new RangeError("maxSyntaxNodes must be a positive safe integer");
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1) throw new RangeError("maxFrames must be a positive safe integer");
}

function sourceRecord(buffer, sourceName, format) {
  return {
    name: sourceName,
    size: buffer.length,
    format,
  };
}

function parseSyntaxPayloads(buffer, obus, diagnostics, frames = [], maxSyntaxNodes = DEFAULT_MAX_SYNTAX_NODES) {
  const syntaxNodes = [];
  let nextSyntaxNodeId = 0;
  let sequenceContext = null;
  const referenceSlots = Array(8).fill(null);
  const tileContexts = new Map();
  const layerKey = (obu) => `${obu.header.temporalId ?? 0}:${obu.header.spatialId ?? 0}`;
  for (const obu of obus) {
    if (!obu.complete) continue;
    if ([1, 3, 4, 5, 6, 7].includes(obu.type.code) && syntaxNodes.length >= maxSyntaxNodes) {
      diagnostics.push(diagnostic(
        "SYNTAX_NODE_LIMIT_REACHED",
        Severity.ERROR,
        "Syntax parsing stopped because the configured syntax-node budget was reached",
        { range: byteRange(obu.payloadRange.start, 0), frameId: obu.frameId, obuId: obu.obuId },
      ));
      break;
    }
    let parsed = null;
    if (obu.type.code === 1) {
      parsed = parseSequenceHeader(buffer, obu, { nextSyntaxNodeId });
      if (parsed.status === "complete") {
        sequenceContext = sequenceContextFromNodes(parsed.nodes);
        tileContexts.clear();
      }
    } else if ([3, 6, 7].includes(obu.type.code)) {
      const frameHeader = parseFrameHeaderPrefix(buffer, obu, sequenceContext, {
        nextSyntaxNodeId,
        referenceSlots,
      });
      parsed = frameHeader;
      if (frameHeader.summary && !frameHeader.summary.showExistingFrame) {
        const key = layerKey(obu);
        const tileContext = {
          summary: frameHeader.summary,
          nextExpectedTile: 0,
          sourceObuId: obu.obuId,
          extensionFlag: obu.header.extensionFlag,
          frameId: obu.frameId,
        };
        if (obu.type.code === 3 || (obu.type.code === 7 && !tileContexts.has(key))) {
          tileContexts.set(key, tileContext);
        } else if (obu.type.code === 6) {
          const tileGroup = parseTileGroup(buffer, obu, tileContext, {
            nextSyntaxNodeId: frameHeader.nextSyntaxNodeId,
            startBitOffset: frameHeader.parsedBitLength,
            embeddedFrame: true,
            expectedTileStart: 0,
          });
          const hasFrameErrors = frameHeader.diagnostics.some(({ severity }) =>
            severity === Severity.ERROR || severity === Severity.FATAL);
          parsed = {
            ...frameHeader,
            nodes: [...frameHeader.nodes, ...tileGroup.nodes],
            diagnostics: [...frameHeader.diagnostics, ...tileGroup.diagnostics],
            nextSyntaxNodeId: tileGroup.nextSyntaxNodeId,
            parsedBitLength: tileGroup.parsedBitLength,
            status: hasFrameErrors || tileGroup.status === "error" ? "error" : tileGroup.status,
            tileGroupSummary: tileGroup.summary,
          };
        }
      }
    } else if (obu.type.code === 4) {
      const key = layerKey(obu);
      const tileContext = tileContexts.get(key) ?? null;
      parsed = parseTileGroup(buffer, obu, tileContext, {
        nextSyntaxNodeId,
        expectedTileStart: tileContext?.nextExpectedTile ?? 0,
      });
      if (tileContext && tileContext.extensionFlag !== obu.header.extensionFlag) {
        parsed.diagnostics.push(diagnostic(
          "TILE_GROUP_EXTENSION_MISMATCH",
          Severity.ERROR,
          "Frame Header and Tile Group must use the same obu_extension_flag",
          { range: obu.headerRange, frameId: obu.frameId, obuId: obu.obuId },
        ));
        parsed.status = "error";
      }
      if (tileContext && parsed.summary) {
        if (parsed.summary.completeFrame) tileContexts.delete(key);
        else if (Number.isSafeInteger(parsed.summary.nextExpectedTile)) {
          tileContext.nextExpectedTile = parsed.summary.nextExpectedTile;
        }
      }
    } else if (obu.type.code === 5) {
      parsed = parseMetadata(buffer, obu, { nextSyntaxNodeId });
    }
    if (parsed && syntaxNodes.length + parsed.nodes.length > maxSyntaxNodes) {
      diagnostics.push(diagnostic(
        "SYNTAX_NODE_LIMIT_REACHED",
        Severity.ERROR,
        "Syntax parsing stopped before an OBU that would exceed the configured syntax-node budget",
        { range: byteRange(obu.payloadRange.start, 0), frameId: obu.frameId, obuId: obu.obuId },
      ));
      break;
    }
    if (parsed) {
      nextSyntaxNodeId = parsed.nextSyntaxNodeId;
      obu.syntaxNodeIds.push(...parsed.nodes.map(({ nodeId }) => nodeId));
      obu.syntaxStatus = parsed.status;
      obu.parsedPayloadBitLength = parsed.parsedBitLength;
      if (parsed.summary || parsed.tileGroupSummary) {
        if (parsed.summary?.metadataType !== undefined) obu.metadataSummary = parsed.summary;
        const tileGroupSummary = parsed.tileGroupSummary ??
          (parsed.summary?.kind === "tile_group" ? parsed.summary : null);
        if (tileGroupSummary) obu.tileGroupSummary = tileGroupSummary;
        const isFrameHeader = parsed.summary?.frameTypeName !== undefined;
        if (isFrameHeader) obu.frameHeaderSummary = parsed.summary;
        const frame = frames.find(({ frameId }) => frameId === obu.frameId);
        if (isFrameHeader && frame && !frame.headerSummary) frame.headerSummary = parsed.summary;
        if (isFrameHeader) {
          for (const slot of parsed.summary.invalidatedReferenceSlots ?? []) referenceSlots[slot] = null;
        }
        if (isFrameHeader && obu.frameId !== null && parsed.summary.refreshFrameFlags !== undefined) {
          const sourceSlot = parsed.summary.showExistingFrame
            ? referenceSlots[parsed.summary.frameToShowMapIdx]
            : null;
          const refreshedFrameId = parsed.summary.showExistingFrame
            ? parsed.summary.referenceFrameIds?.[0] ?? obu.frameId
            : obu.frameId;
          for (let slot = 0; slot < referenceSlots.length; slot += 1) {
            if ((parsed.summary.refreshFrameFlags & (1 << slot)) !== 0) {
              referenceSlots[slot] = {
                frameId: refreshedFrameId,
                frameType: parsed.summary.frameType,
                showableFrame: parsed.summary.showableFrame,
                currentFrameId: parsed.summary.showExistingFrame
                  ? sourceSlot?.currentFrameId
                  : parsed.summary.currentFrameId,
                frameWidth: parsed.summary.frameWidth,
                frameHeight: parsed.summary.frameHeight,
                renderWidth: parsed.summary.renderWidth,
                renderHeight: parsed.summary.renderHeight,
                segmentation: parsed.summary.segmentation,
                orderHint: parsed.summary.orderHint,
                globalMotionTypes: parsed.summary.globalMotionTypes,
                globalMotionParams: parsed.summary.globalMotionParams,
                filmGrain: parsed.summary.filmGrain,
              };
            }
          }
        }
      }
      syntaxNodes.push(...parsed.nodes);
      diagnostics.push(...parsed.diagnostics);
    }
  }
  return syntaxNodes;
}

function analyzeRawObu(buffer, sourceName, maxObus, maxSyntaxNodes) {
  const parsed = parseObuSequence(buffer, {
    start: 0,
    end: buffer.length,
    allowUnsizedFinalObu: false,
    maxObus,
  });
  const diagnostics = [...parsed.diagnostics];
  if (buffer.length === 0) {
    diagnostics.push(
      diagnostic("INPUT_EMPTY", Severity.ERROR, "Input contains no bytes", {
        range: byteRange(0, 0),
      }),
    );
  }
  const syntaxNodes = parseSyntaxPayloads(
    buffer,
    parsed.obus,
    diagnostics,
    [],
    maxSyntaxNodes,
  );
  diagnostics.push(...validateReportSemantics({ container: null, frames: [], obus: parsed.obus }));
  return finalizeReport({
    source: sourceRecord(buffer, sourceName, InputFormat.LOW_OVERHEAD_OBU),
    container: null,
    frames: [],
    obus: parsed.obus,
    syntaxNodes,
    diagnostics,
  });
}

function truncatedIvfReport(buffer, sourceName) {
  return finalizeReport({
    source: sourceRecord(buffer, sourceName, InputFormat.IVF),
    container: null,
    frames: [],
    obus: [],
    syntaxNodes: [],
    diagnostics: [
      diagnostic(
        "IVF_HEADER_TRUNCATED",
        Severity.FATAL,
        `IVF header requires ${IVF_MIN_HEADER_LENGTH} bytes`,
        { range: byteRange(0, buffer.length) },
      ),
    ],
  });
}

function analyzeIvf(buffer, sourceName, maxObus, maxSyntaxNodes, maxFrames) {
  if (buffer.length < IVF_MIN_HEADER_LENGTH) {
    return truncatedIvfReport(buffer, sourceName);
  }

  const diagnostics = [];
  const frames = [];
  const obus = [];
  const version = buffer.readUInt16LE(4);
  const headerLength = buffer.readUInt16LE(6);
  const codec = buffer.toString("ascii", 8, 12);
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const timebaseRate = buffer.readUInt32LE(16);
  const timebaseScale = buffer.readUInt32LE(20);
  const declaredFrameCount = buffer.readUInt32LE(24);

  if (version !== 0) {
    diagnostics.push(
      diagnostic(
        "IVF_VERSION_UNSUPPORTED",
        Severity.WARNING,
        `IVF version ${version} is not the expected version 0`,
        { range: byteRange(4, 2) },
      ),
    );
  }
  if (headerLength < IVF_MIN_HEADER_LENGTH) {
    diagnostics.push(
      diagnostic(
        "IVF_HEADER_LENGTH_INVALID",
        Severity.FATAL,
        `IVF header length ${headerLength} is smaller than 32`,
        { range: byteRange(6, 2) },
      ),
    );
    return finalizeReport({
      source: sourceRecord(buffer, sourceName, InputFormat.IVF),
      container: null,
      frames,
      obus,
      syntaxNodes: [],
      diagnostics,
    });
  }
  if (headerLength > buffer.length) {
    diagnostics.push(
      diagnostic(
        "IVF_HEADER_TRUNCATED",
        Severity.FATAL,
        `IVF declares a ${headerLength}-byte header but the file has ${buffer.length} bytes`,
        { range: byteRange(0, buffer.length) },
      ),
    );
    return finalizeReport({
      source: sourceRecord(buffer, sourceName, InputFormat.IVF),
      container: null,
      frames,
      obus,
      syntaxNodes: [],
      diagnostics,
    });
  }
  if (codec !== IVF_CODEC) {
    diagnostics.push(
      diagnostic(
        "IVF_CODEC_NOT_AV1",
        Severity.ERROR,
        `IVF codec is ${JSON.stringify(codec)}, expected ${IVF_CODEC}`,
        { range: byteRange(8, 4) },
      ),
    );
  }
  if (width === 0 || height === 0) {
    diagnostics.push(
      diagnostic(
        "IVF_DIMENSIONS_ZERO",
        Severity.WARNING,
        `IVF dimensions are ${width}x${height}`,
        { range: byteRange(12, 4) },
      ),
    );
  }
  if (timebaseRate === 0 || timebaseScale === 0) {
    diagnostics.push(
      diagnostic(
        "IVF_TIMEBASE_INVALID",
        Severity.WARNING,
        `IVF timebase rate/scale is ${timebaseRate}/${timebaseScale}`,
        { range: byteRange(16, 8) },
      ),
    );
  }

  const container = {
    type: InputFormat.IVF,
    version,
    headerLength,
    codec,
    width,
    height,
    timebase: {
      rate: timebaseRate,
      scale: timebaseScale,
    },
    declaredFrameCount,
  };

  let cursor = headerLength;
  let nextObuId = 0;
  while (cursor < buffer.length) {
    if (frames.length >= maxFrames) {
      diagnostics.push(diagnostic(
        "FRAME_RECORD_LIMIT_REACHED", Severity.ERROR,
        "Frame indexing stopped because the configured frame-record budget was reached",
        { range: byteRange(cursor, 0), frameId: frames.length },
      ));
      break;
    }
    const frameId = frames.length;
    const remaining = buffer.length - cursor;
    if (remaining < IVF_FRAME_HEADER_LENGTH) {
      diagnostics.push(
        diagnostic(
          "IVF_FRAME_HEADER_TRUNCATED",
          Severity.ERROR,
          `Only ${remaining} bytes remain for an IVF frame header`,
          { range: byteRange(cursor, remaining), frameId },
        ),
      );
      break;
    }

    const frameStart = cursor;
    const declaredSize = buffer.readUInt32LE(cursor);
    const timestamp = buffer.readBigUInt64LE(cursor + 4).toString(10);
    const payloadStart = cursor + IVF_FRAME_HEADER_LENGTH;
    const available = buffer.length - payloadStart;
    const actualSize = Math.min(declaredSize, available);
    const complete = declaredSize <= available;
    const frame = {
      schemaVersion: SCHEMA_VERSION,
      frameId,
      decodeIndex: frameId,
      timestamp,
      pts: timestamp,
      dts: timestamp,
      duration: null,
      sampleRange: byteRange(
        frameStart,
        IVF_FRAME_HEADER_LENGTH + actualSize,
      ),
      payloadRange: byteRange(payloadStart, actualSize),
      declaredSize,
      complete,
      obuIds: [],
    };

    const parsed = parseObuSequence(buffer, {
      start: payloadStart,
      end: payloadStart + actualSize,
      frameId,
      allowUnsizedFinalObu: true,
      nextObuId,
      maxObus: Math.max(0, maxObus - obus.length),
    });
    nextObuId = parsed.nextObuId;
    frame.obuIds.push(...parsed.obus.map(({ obuId }) => obuId));
    frames.push(frame);
    obus.push(...parsed.obus);
    diagnostics.push(...parsed.diagnostics);

    if (parsed.limitReached) break;

    cursor = payloadStart + actualSize;
    if (!complete) {
      diagnostics.push(
        diagnostic(
          "IVF_FRAME_PAYLOAD_TRUNCATED",
          Severity.ERROR,
          `Frame declares ${declaredSize} bytes but only ${available} remain`,
          { range: byteRange(payloadStart, available), frameId },
        ),
      );
      break;
    }
  }

  if (declaredFrameCount !== frames.length) {
    diagnostics.push(
      diagnostic(
        "IVF_FRAME_COUNT_MISMATCH",
        Severity.WARNING,
        `IVF declares ${declaredFrameCount} frames but ${frames.length} were indexed`,
        { range: byteRange(24, 4) },
      ),
    );
  }

  const syntaxNodes = parseSyntaxPayloads(buffer, obus, diagnostics, frames, maxSyntaxNodes);
  diagnostics.push(...validateReportSemantics({ container, frames, obus }));

  return finalizeReport({
    source: sourceRecord(buffer, sourceName, InputFormat.IVF),
    container,
    frames,
    obus,
    syntaxNodes,
    diagnostics,
  });
}

export function analyzeIsoBmffPackets(buffer, probe, sourceName = "<memory>", {
  maxObus = DEFAULT_MAX_OBUS,
  maxSyntaxNodes = DEFAULT_MAX_SYNTAX_NODES,
  maxFrames = DEFAULT_MAX_FRAMES,
} = {}) {
  validateAnalysisBudgets(maxObus, maxSyntaxNodes, maxFrames);
  const diagnostics = [];
  const frames = [];
  const obus = [];
  const stream = probe.streams?.[0] ?? null;
  if (!stream) {
    diagnostics.push(diagnostic("ISOBMFF_VIDEO_STREAM_MISSING", Severity.FATAL, "No video stream was found in the ISO BMFF input"));
  } else if (stream.codec_name !== "av1") {
    diagnostics.push(diagnostic("ISOBMFF_CODEC_NOT_AV1", Severity.FATAL, `Video codec is ${stream.codec_name ?? "unknown"}, expected av1`));
  }

  let nextObuId = 0;
  if (stream?.codec_name === "av1") {
    const packets = (probe.packets ?? []).filter(
      ({ stream_index: index }) => index === undefined || index === stream.index,
    );
    for (const packet of packets) {
      if (frames.length >= maxFrames) {
        diagnostics.push(diagnostic(
          "FRAME_RECORD_LIMIT_REACHED", Severity.ERROR,
          "Frame indexing stopped because the configured frame-record budget was reached",
          { frameId: frames.length },
        ));
        break;
      }
      const frameId = frames.length;
      const start = Number(packet.pos);
      const declaredSize = Number(packet.size);
      if (!Number.isSafeInteger(start) || start < 0 ||
          !Number.isSafeInteger(declaredSize) || declaredSize < 0) {
        diagnostics.push(diagnostic(
          "ISOBMFF_PACKET_RANGE_INVALID",
          Severity.ERROR,
          `Packet ${frameId} has invalid pos/size metadata`,
          { frameId },
        ));
        continue;
      }
      const available = Math.max(0, buffer.length - start);
      const actualSize = Math.min(declaredSize, available);
      const complete = start <= buffer.length && actualSize === declaredSize;
      const frame = {
        schemaVersion: SCHEMA_VERSION,
        frameId,
        decodeIndex: frameId,
        timestamp: String(packet.pts ?? packet.dts ?? frameId),
        pts: packet.pts === undefined || packet.pts === null ? null : String(packet.pts),
        dts: packet.dts === undefined || packet.dts === null ? null : String(packet.dts),
        duration: packet.duration === undefined || packet.duration === null
          ? null : String(packet.duration),
        sampleRange: byteRange(Math.min(start, buffer.length), actualSize),
        payloadRange: byteRange(Math.min(start, buffer.length), actualSize),
        declaredSize,
        complete,
        keyframe: String(packet.flags ?? "").startsWith("K"),
        obuIds: [],
      };
      const parsed = parseObuSequence(buffer, {
        start: Math.min(start, buffer.length),
        end: Math.min(start + actualSize, buffer.length),
        frameId,
        allowUnsizedFinalObu: true,
        nextObuId,
        maxObus: Math.max(0, maxObus - obus.length),
      });
      nextObuId = parsed.nextObuId;
      frame.obuIds.push(...parsed.obus.map(({ obuId }) => obuId));
      frames.push(frame);
      obus.push(...parsed.obus);
      diagnostics.push(...parsed.diagnostics);
      if (parsed.limitReached) break;
      if (!complete) {
        diagnostics.push(diagnostic(
          "ISOBMFF_PACKET_TRUNCATED",
          Severity.ERROR,
          `Packet declares ${declaredSize} bytes but only ${actualSize} are available`,
          { range: frame.payloadRange, frameId },
        ));
      }
    }
  }
  const syntaxNodes = parseSyntaxPayloads(buffer, obus, diagnostics, frames, maxSyntaxNodes);
  diagnostics.push(...validateReportSemantics({ container: stream ? {
    width: stream.width ?? null,
    height: stream.height ?? null,
  } : null, frames, obus }));
  return finalizeReport({
    source: sourceRecord(buffer, sourceName, InputFormat.ISOBMFF),
    container: stream ? {
      type: InputFormat.ISOBMFF,
      codec: stream.codec_name,
      width: stream.width ?? null,
      height: stream.height ?? null,
      timebase: stream.time_base ?? null,
      streamIndex: stream.index ?? 0,
    } : null,
    frames,
    obus,
    syntaxNodes,
    diagnostics,
  });
}

export function matroskaPacketPayloadRange(buffer, packet) {
  const blockStart = Number(packet.pos);
  const payloadSize = Number(packet.size);
  if (!Number.isSafeInteger(blockStart) || blockStart < 0 || blockStart >= buffer.length ||
      !Number.isSafeInteger(payloadSize) || payloadSize < 0) return null;
  const first = buffer[blockStart];
  let trackNumberLength = 1;
  while (trackNumberLength <= 8 && (first & (0x80 >> (trackNumberLength - 1))) === 0) {
    trackNumberLength += 1;
  }
  if (trackNumberLength > 8) return null;
  const flagsOffset = blockStart + trackNumberLength + 2;
  if (flagsOffset >= buffer.length) return null;
  const flags = buffer[flagsOffset];
  if ((flags & 0x06) !== 0) return { laced: true, start: flagsOffset + 1, length: payloadSize };
  return { laced: false, start: flagsOffset + 1, length: payloadSize };
}

function readMatroskaVint(buffer, offset, { signed = false } = {}) {
  if (offset >= buffer.length) throw new RangeError("Matroska VINT is truncated");
  const first = buffer[offset];
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8 || offset + length > buffer.length) throw new RangeError("Matroska VINT is invalid or truncated");
  let value = first & (0xff >> length);
  for (let index = 1; index < length; index += 1) value = value * 256 + buffer[offset + index];
  if (!Number.isSafeInteger(value)) throw new RangeError("Matroska VINT exceeds safe integer precision");
  if (signed) value -= 2 ** (7 * length - 1) - 1;
  return { value, length };
}

function matroskaLaceLayout(buffer, packets) {
  const blockStart = Number(packets[0]?.pos);
  if (!Number.isSafeInteger(blockStart) || blockStart < 0 || blockStart >= buffer.length) {
    throw new RangeError("Matroska Block position is invalid");
  }
  const track = readMatroskaVint(buffer, blockStart);
  const flagsOffset = blockStart + track.length + 2;
  if (flagsOffset >= buffer.length) throw new RangeError("Matroska Block header is truncated");
  const mode = (buffer[flagsOffset] & 0x06) >> 1;
  if (mode === 0) {
    if (packets.length !== 1) throw new RangeError("non-laced Matroska Block maps to multiple packets");
    return [{ start: flagsOffset + 1, length: Number(packets[0].size), lacing: "none" }];
  }
  let cursor = flagsOffset + 1;
  if (cursor >= buffer.length) throw new RangeError("Matroska lace count is truncated");
  const laceCount = buffer[cursor] + 1;
  cursor += 1;
  if (packets.length !== laceCount) {
    throw new RangeError(`Matroska Block declares ${laceCount} laces but ffprobe exposed ${packets.length} packets`);
  }
  const packetSizes = packets.map(({ size }, index) => {
    const value = Number(size);
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Matroska lace packet ${index} has invalid size`);
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
        if (cursor >= buffer.length) throw new RangeError("Xiph lace size is truncated");
        part = buffer[cursor++];
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
    const firstSize = readMatroskaVint(buffer, cursor);
    cursor += firstSize.length;
    encodedSizes.push(firstSize.value);
    for (let lace = 1; lace < laceCount - 1; lace += 1) {
      const difference = readMatroskaVint(buffer, cursor, { signed: true });
      cursor += difference.length;
      encodedSizes.push(encodedSizes.at(-1) + difference.value);
    }
  }
  if (encodedSizes.some((size, index) => size !== packetSizes[index])) {
    throw new RangeError(`${lacing} Matroska lace sizes disagree with ffprobe packet sizes`);
  }
  const ranges = [];
  for (const length of packetSizes) {
    if (cursor + length > buffer.length) throw new RangeError("Matroska lace payload is truncated");
    ranges.push({ start: cursor, length, laced: true, lacing });
    cursor += length;
  }
  return ranges;
}

export function analyzeMatroskaPackets(buffer, probe, sourceName = "<memory>", {
  maxObus = DEFAULT_MAX_OBUS,
  maxSyntaxNodes = DEFAULT_MAX_SYNTAX_NODES,
  maxFrames = DEFAULT_MAX_FRAMES,
} = {}) {
  validateAnalysisBudgets(maxObus, maxSyntaxNodes, maxFrames);
  const adjustedProbe = {
    ...probe,
    packets: [],
  };
  const preflightDiagnostics = [];
  const stream = probe.streams?.[0] ?? null;
  const packets = (probe.packets ?? []).filter(
    ({ stream_index: index }) => index === undefined || index === stream?.index,
  );
  const groups = new Map();
  for (const packet of packets) {
    const key = String(packet.pos);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(packet);
  }
  let frameId = 0;
  groupLoop: for (const group of groups.values()) {
    try {
      const ranges = matroskaLaceLayout(buffer, group);
      for (let index = 0; index < group.length; index += 1) {
        if (adjustedProbe.packets.length >= maxFrames) {
          preflightDiagnostics.push(diagnostic(
            "FRAME_RECORD_LIMIT_REACHED", Severity.ERROR,
            "Frame indexing stopped because the configured frame-record budget was reached",
            { frameId: adjustedProbe.packets.length },
          ));
          break groupLoop;
        }
        adjustedProbe.packets.push({ ...group[index], pos: String(ranges[index].start), size: String(ranges[index].length) });
        frameId += 1;
      }
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      preflightDiagnostics.push(diagnostic(
        "MATROSKA_BLOCK_HEADER_INVALID",
        Severity.ERROR,
        `Packet group at ${group[0]?.pos ?? "unknown"} is not indexable: ${error.message}`,
        { frameId },
      ));
      frameId += group.length;
    }
  }
  const report = analyzeIsoBmffPackets(buffer, adjustedProbe, sourceName, { maxObus, maxSyntaxNodes, maxFrames });
  report.source.format = InputFormat.MATROSKA;
  if (report.container) report.container.type = InputFormat.MATROSKA;
  report.diagnostics.unshift(...preflightDiagnostics);
  report.summary.errorCount += preflightDiagnostics.length;
  report.summary.complete = report.summary.complete && preflightDiagnostics.length === 0;
  return report;
}

export function detectInputFormat(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("detectInputFormat expects a Buffer");
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === IVF_SIGNATURE) {
    return InputFormat.IVF;
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return InputFormat.ISOBMFF;
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return InputFormat.MATROSKA;
  }
  return InputFormat.LOW_OVERHEAD_OBU;
}

export function analyzeBuffer(
  buffer,
  {
    sourceName = "<memory>",
    maxObus = DEFAULT_MAX_OBUS,
    maxSyntaxNodes = DEFAULT_MAX_SYNTAX_NODES,
    maxFrames = DEFAULT_MAX_FRAMES,
  } = {},
) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("analyzeBuffer expects a Buffer");
  }
  const normalizedSourceName =
    sourceName === "<memory>" ? sourceName : path.basename(sourceName);
  const format = detectInputFormat(buffer);
  validateAnalysisBudgets(maxObus, maxSyntaxNodes, maxFrames);
  if (format === InputFormat.IVF) return analyzeIvf(buffer, normalizedSourceName, maxObus, maxSyntaxNodes, maxFrames);
  if (format === InputFormat.LOW_OVERHEAD_OBU) return analyzeRawObu(buffer, normalizedSourceName, maxObus, maxSyntaxNodes);
  return finalizeReport({
    source: sourceRecord(buffer, normalizedSourceName, format),
    container: null,
    frames: [],
    obus: [],
    syntaxNodes: [],
    diagnostics: [diagnostic(
      "CONTAINER_PROBE_REQUIRED",
      Severity.FATAL,
      "MP4/WebM input requires asynchronous ffprobe packet indexing",
    )],
  });
}

export async function analyzeMediaBuffer(
  buffer,
  {
    sourceName = "<memory>", probe = probeMediaPackets,
    maxObus = DEFAULT_MAX_OBUS, maxSyntaxNodes = DEFAULT_MAX_SYNTAX_NODES,
    maxFrames = DEFAULT_MAX_FRAMES, signal = null,
    ffprobePath = "ffprobe",
    nativeDemuxWorkerExecutable = null,
    nativeDemuxWorker = demuxBufferInNativeWorker,
  } = {},
) {
  validateAnalysisBudgets(maxObus, maxSyntaxNodes, maxFrames);
  const normalizedSourceName = sourceName === "<memory>" ? sourceName : path.basename(sourceName);
  const format = detectInputFormat(buffer);
  if (![InputFormat.ISOBMFF, InputFormat.MATROSKA].includes(format)) {
    return analyzeBuffer(buffer, { sourceName: normalizedSourceName, maxObus, maxSyntaxNodes, maxFrames });
  }
  const usesNativeDemux = nativeDemuxWorkerExecutable !== null;
  const metadata = !usesNativeDemux
    ? await probe(buffer, { signal, ffprobePath })
    : nativeDemuxResultToProbe(await nativeDemuxWorker(buffer, {
      executable: nativeDemuxWorkerExecutable,
      signal,
      maximumRecords: Math.min(maxFrames, 250_000),
    }));
  const report = format === InputFormat.ISOBMFF
    ? analyzeIsoBmffPackets(buffer, metadata, normalizedSourceName, { maxObus, maxSyntaxNodes, maxFrames })
    : analyzeMatroskaPackets(buffer, metadata, normalizedSourceName, { maxObus, maxSyntaxNodes, maxFrames });
  report.provenance.demux = usesNativeDemux
    ? {
      implementation: "av1scope-native-demux-worker-v1",
      adapter: "av1scope-libavformat",
      adapterVersion: metadata.nativeAdapterVersion,
      featureFlags: metadata.nativeAdapterFeatureFlags,
      workerSandboxFlags: metadata.nativeWorkerSandboxFlags,
      workerExecutable: metadata.nativeWorkerExecutable,
    }
    : { implementation: "ffprobe-reference" };
  return report;
}

export function nativeDemuxResultToProbe(result) {
  if (!result || result.protocol !== "av1scope.native-demux-worker.v1"
      || !result.stream || !Array.isArray(result.samples)) {
    throw new TypeError("invalid native demux worker result");
  }
  const stream = result.stream;
  return {
    streams: [{
      index: stream.trackId,
      codec_name: "av1",
      width: stream.width,
      height: stream.height,
      time_base: `${stream.timeBaseNum}/${stream.timeBaseDen}`,
    }],
    packets: result.samples.map((sample) => ({
      stream_index: sample.trackId,
      dts: String(sample.dts),
      pts: String(sample.pts),
      duration: String(sample.duration),
      pos: String(sample.sourceStart),
      size: String(sample.sourceLength),
      flags: (sample.flags & 1) !== 0 ? "K_" : "__",
    })),
    nativeAdapterVersion: stream.adapterVersion,
    nativeAdapterFeatureFlags: stream.adapterFeatureFlags,
    nativeWorkerSandboxFlags: stream.workerSandboxFlags,
    nativeWorkerExecutable: result.workerExecutable ?? null,
  };
}
