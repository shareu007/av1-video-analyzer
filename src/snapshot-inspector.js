import { parseFrameHeaderPrefix, sequenceContextFromNodes } from "./frame-header-parser.js";
import { parseMetadata } from "./metadata-parser.js";
import { parseSequenceHeader } from "./sequence-header-parser.js";
import { parseTileGroup } from "./tile-group-parser.js";

const INSPECTABLE_TYPES = new Set([1, 3, 4, 5, 6, 7]);

function localObu(record, payloadLength) {
  return {
    ...record,
    byteRange: { start: 0, length: payloadLength },
    headerRange: { start: 0, length: 0 },
    sizeFieldRange: null,
    payloadRange: { start: 0, length: payloadLength },
    complete: true,
    syntaxNodeIds: [],
  };
}

function remapResult(result, record) {
  const bitOffset = record.payloadRange.start * 8;
  const byteOffset = record.payloadRange.start;
  return {
    ...result,
    nodes: result.nodes.map((node) => ({
      ...node,
      bitRange: node.bitRange ? {
        ...node.bitRange,
        startBit: node.bitRange.startBit + bitOffset,
      } : null,
    })),
    diagnostics: result.diagnostics.map((item) => ({
      ...item,
      byteRange: item.byteRange ? {
        ...item.byteRange,
        start: item.byteRange.start + byteOffset,
      } : null,
    })),
  };
}

export function inspectSnapshotObuPayload(
  record,
  payload,
  {
    sequenceRecord = null,
    sequencePayload = null,
    frameHeaderRecord = null,
    frameHeaderPayload = null,
  } = {},
) {
  if (!record || typeof record !== "object") throw new TypeError("snapshot OBU record is required");
  if (!Buffer.isBuffer(payload)) throw new TypeError("snapshot OBU payload must be a Buffer");
  if (!INSPECTABLE_TYPES.has(record.type?.code)) {
    throw new RangeError(`OBU type ${record.type?.code ?? "unknown"} has no supported payload inspector`);
  }
  if (payload.length < 1 || payload.length > record.payloadRange.length) {
    throw new RangeError("snapshot OBU payload prefix length is outside the indexed range");
  }
  if (record.type.code === 4 && payload.length !== record.payloadRange.length) {
    throw new RangeError("Tile Group inspection requires the complete indexed payload");
  }

  let result;
  if (record.type.code === 1) {
    result = parseSequenceHeader(payload, localObu(record, payload.length));
  } else if (record.type.code === 5) {
    result = parseMetadata(payload, localObu(record, payload.length));
  } else {
    let sequenceContext = null;
    if (sequenceRecord || sequencePayload) {
      if (!sequenceRecord || sequenceRecord.type?.code !== 1 || !Buffer.isBuffer(sequencePayload)) {
        throw new TypeError("frame inspection sequence context is invalid");
      }
      if (sequencePayload.length !== sequenceRecord.payloadRange.length) {
        throw new RangeError("sequence payload length does not match the indexed range");
      }
      const sequence = parseSequenceHeader(
        sequencePayload,
        localObu(sequenceRecord, sequencePayload.length),
      );
      if (sequence.status !== "complete") {
        throw new Error("sequence header context is incomplete");
      }
      sequenceContext = sequenceContextFromNodes(sequence.nodes);
    }
    if (record.type.code === 4) {
      if (!frameHeaderRecord || ![3, 7].includes(frameHeaderRecord.type?.code) ||
          !Buffer.isBuffer(frameHeaderPayload)) {
        throw new TypeError("Tile Group inspection requires a Frame Header context");
      }
      if (frameHeaderPayload.length !== frameHeaderRecord.payloadRange.length) {
        throw new RangeError("frame header payload length does not match the indexed range");
      }
      if (!sequenceContext) {
        throw new TypeError("Tile Group inspection requires a Sequence Header context");
      }
      const frameHeader = parseFrameHeaderPrefix(
        frameHeaderPayload,
        localObu(frameHeaderRecord, frameHeaderPayload.length),
        sequenceContext,
        { referenceSlots: Array(8).fill(null) },
      );
      if (!frameHeader.summary || frameHeader.summary.showExistingFrame ||
          !Number.isSafeInteger(frameHeader.summary.tileCols)) {
        throw new Error("Frame Header context did not produce a usable tile layout");
      }
      result = parseTileGroup(
        payload,
        localObu(record, payload.length),
        {
          summary: frameHeader.summary,
          sourceObuId: frameHeaderRecord.obuId,
          nextExpectedTile: null,
        },
        { expectedTileStart: null },
      );
    } else {
      result = parseFrameHeaderPrefix(
        payload,
        localObu(record, payload.length),
        sequenceContext,
        { referenceSlots: Array(8).fill(null) },
      );
    }
    if (record.type.code === 6 && payload.length === record.payloadRange.length &&
        result.summary && !result.summary.showExistingFrame) {
      const tileGroup = parseTileGroup(
        payload,
        localObu(record, payload.length),
        { summary: result.summary, sourceObuId: record.obuId, nextExpectedTile: 0 },
        {
          nextSyntaxNodeId: result.nextSyntaxNodeId,
          startBitOffset: result.parsedBitLength,
          embeddedFrame: true,
          expectedTileStart: 0,
        },
      );
      const frameDiagnostics = result.diagnostics;
      result = {
        ...result,
        nodes: [...result.nodes, ...tileGroup.nodes],
        diagnostics: [...frameDiagnostics, ...tileGroup.diagnostics],
        nextSyntaxNodeId: tileGroup.nextSyntaxNodeId,
        parsedBitLength: tileGroup.parsedBitLength,
        status: frameDiagnostics.length || tileGroup.status === "error" ? "error" : tileGroup.status,
        tileGroupSummary: tileGroup.summary,
      };
    }
  }
  return {
    schemaVersion: 1,
    kind: "av1scope-snapshot-syntax-inspection",
    obuId: record.obuId,
    type: record.type,
    payloadRange: record.payloadRange,
    ...remapResult(result, record),
    inspectedPayloadBytes: payload.length,
  };
}
