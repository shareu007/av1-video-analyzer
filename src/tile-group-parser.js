import { BitReader } from "./bit-reader.js";
import { SCHEMA_VERSION, Severity, byteRange, diagnostic } from "./model.js";

function tileLayout(frameContext) {
  const summary = frameContext?.summary ?? frameContext;
  const tileCols = summary?.tileCols ?? summary?.tileWidthsSb?.length;
  const tileRows = summary?.tileRows ?? summary?.tileHeightsSb?.length;
  const tileColsLog2 = summary?.tileColsLog2;
  const tileRowsLog2 = summary?.tileRowsLog2;
  const tileSizeBytes = summary?.tileSizeBytes;
  if (![tileCols, tileRows, tileColsLog2, tileRowsLog2].every(Number.isSafeInteger) ||
      tileCols < 1 || tileRows < 1 || tileCols > 64 || tileRows > 64 ||
      tileColsLog2 < 0 || tileRowsLog2 < 0 || tileColsLog2 > 6 || tileRowsLog2 > 6) {
    return null;
  }
  const numTiles = tileCols * tileRows;
  if (numTiles > 1 && (!Number.isSafeInteger(tileSizeBytes) || tileSizeBytes < 1 || tileSizeBytes > 4)) {
    return null;
  }
  return {
    summary,
    tileCols,
    tileRows,
    tileColsLog2,
    tileRowsLog2,
    tileSizeBytes: numTiles > 1 ? tileSizeBytes : 0,
    numTiles,
  };
}

/**
 * Parse the byte-level structure of an AV1 tile_group_obu.
 *
 * Coded tile entropy is deliberately kept opaque. The parser validates and
 * exposes the group header, size fields, and absolute tile byte ranges.
 */
export function parseTileGroup(
  buffer,
  obu,
  frameContext,
  {
    nextSyntaxNodeId = 0,
    startBitOffset = 0,
    embeddedFrame = false,
    expectedTileStart = frameContext?.nextExpectedTile ?? 0,
  } = {},
) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("parseTileGroup expects a Buffer");
  if (!obu?.payloadRange) throw new TypeError("parseTileGroup requires an OBU payload range");
  if (!Number.isSafeInteger(startBitOffset) || startBitOffset < 0) {
    throw new RangeError("tile group start bit offset must be a non-negative safe integer");
  }

  const nodes = [];
  const diagnostics = [];
  const { start, length } = obu.payloadRange;
  const baseBit = start * 8;
  const reader = new BitReader(buffer, { startByte: start, lengthBytes: length });
  const layout = tileLayout(frameContext);

  const addNode = (path, value, coding, bitRange, presence = "true") => {
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path,
      value,
      coding,
      presence,
      bitRange,
      specAnchor: "AV1 §5.11.1 General tile group OBU syntax",
    });
    return value;
  };
  const inferred = (path, value, presence) => addNode(path, value, "inferred", null, presence);
  const coded = (path, width, presence = "true") => {
    const relativeStart = reader.position;
    return addNode(path, reader.readBits(width), `f(${width})`, {
      startBit: baseBit + relativeStart,
      lengthBits: width,
    }, presence);
  };
  const alignment = (prefix) => {
    let index = 0;
    while (reader.position % 8 !== 0) {
      const value = coded(`${prefix}.zero_bit[${index}]`, 1, "not byte aligned");
      if (value !== 0) {
        diagnostics.push(diagnostic(
          "TILE_GROUP_ALIGNMENT_BIT_SET",
          Severity.ERROR,
          `${prefix} zero_bit must be zero`,
          {
            range: byteRange(start + Math.floor((reader.position - 1) / 8), 1),
            frameId: obu.frameId,
            obuId: obu.obuId,
          },
        ));
      }
      index += 1;
    }
  };
  const result = (status, parsedBitLength, summary = undefined) => ({
    nodes,
    diagnostics,
    nextSyntaxNodeId,
    parsedBitLength,
    status,
    ...(summary ? { summary } : {}),
  });

  if (!layout) {
    diagnostics.push(diagnostic(
      "TILE_GROUP_FRAME_CONTEXT_MISSING",
      Severity.ERROR,
      "Tile Group requires a complete Frame Header tile layout",
      { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
    ));
    return result("error", 0);
  }
  if (startBitOffset > reader.remaining) {
    diagnostics.push(diagnostic(
      "TILE_GROUP_START_OUTSIDE_PAYLOAD",
      Severity.ERROR,
      `Tile Group starts at bit ${startBitOffset}, beyond the ${length * 8}-bit payload`,
      { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
    ));
    return result("error", 0);
  }

  try {
    reader.skipBits(startBitOffset);
    if (embeddedFrame) alignment("frame_obu.byte_alignment");
    const groupStartBit = reader.position;
    const { numTiles, tileCols, tileRows, tileColsLog2, tileRowsLog2, tileSizeBytes } = layout;
    inferred("tile_group.num_tiles", numTiles, "TileCols * TileRows");
    let tileStartAndEndPresent = 0;
    if (numTiles > 1) {
      tileStartAndEndPresent = coded(
        "tile_group.tile_start_and_end_present_flag",
        1,
        "NumTiles > 1",
      );
    } else {
      inferred("tile_group.tile_start_and_end_present_flag", 0, "NumTiles == 1");
    }

    let tgStart;
    let tgEnd;
    if (numTiles === 1 || !tileStartAndEndPresent) {
      tgStart = inferred("tile_group.tg_start", 0, "single tile or range flag absent");
      tgEnd = inferred("tile_group.tg_end", numTiles - 1, "single tile or range flag absent");
    } else {
      const tileBits = tileColsLog2 + tileRowsLog2;
      tgStart = coded("tile_group.tg_start", tileBits, "tile_start_and_end_present_flag == 1");
      tgEnd = coded("tile_group.tg_end", tileBits, "tile_start_and_end_present_flag == 1");
    }
    alignment("tile_group.byte_alignment");
    const headerByteLength = (reader.position - groupStartBit) / 8;
    inferred("tile_group.header_byte_length", headerByteLength, "after byte_alignment()");

    if (embeddedFrame && tileStartAndEndPresent !== 0) {
      diagnostics.push(diagnostic(
        "FRAME_OBU_TILE_RANGE_FLAG_SET",
        Severity.ERROR,
        "tile_start_and_end_present_flag must be zero inside an OBU_FRAME",
        { range: byteRange(start + Math.floor(groupStartBit / 8), 1), frameId: obu.frameId, obuId: obu.obuId },
      ));
    }
    if (tgStart >= numTiles || tgEnd >= numTiles) {
      diagnostics.push(diagnostic(
        "TILE_GROUP_RANGE_OUT_OF_BOUNDS",
        Severity.ERROR,
        `Tile Group range ${tgStart}..${tgEnd} exceeds tile count ${numTiles}`,
        { range: byteRange(start + Math.floor(groupStartBit / 8), headerByteLength), frameId: obu.frameId, obuId: obu.obuId },
      ));
    }
    if (tgEnd < tgStart) {
      diagnostics.push(diagnostic(
        "TILE_GROUP_RANGE_REVERSED",
        Severity.ERROR,
        `Tile Group end ${tgEnd} precedes start ${tgStart}`,
        { range: byteRange(start + Math.floor(groupStartBit / 8), headerByteLength), frameId: obu.frameId, obuId: obu.obuId },
      ));
    }
    if (Number.isSafeInteger(expectedTileStart) && tgStart !== expectedTileStart) {
      diagnostics.push(diagnostic(
        "TILE_GROUP_ORDER_DISCONTINUITY",
        Severity.ERROR,
        `Tile Group starts at tile ${tgStart}; expected tile ${expectedTileStart}`,
        { range: byteRange(start + Math.floor(groupStartBit / 8), headerByteLength), frameId: obu.frameId, obuId: obu.obuId },
      ));
    }

    const tiles = [];
    const validRange = tgStart < numTiles && tgEnd < numTiles && tgEnd >= tgStart;
    if (validRange) {
      for (let tileNum = tgStart; tileNum <= tgEnd; tileNum += 1) {
        const index = tileNum - tgStart;
        const lastTile = tileNum === tgEnd;
        inferred(`tile_group.tiles[${index}].tile_num`, tileNum, "tile scan order");
        inferred(`tile_group.tiles[${index}].tile_row`, Math.floor(tileNum / tileCols), "TileNum / TileCols");
        inferred(`tile_group.tiles[${index}].tile_col`, tileNum % tileCols, "TileNum % TileCols");
        let tileSize;
        if (lastTile) {
          tileSize = Math.floor(reader.remaining / 8);
          inferred(`tile_group.tiles[${index}].tile_size`, tileSize, "last tile consumes remaining bytes");
        } else {
          const sizeStart = reader.position;
          let tileSizeMinus1 = 0;
          let multiplier = 1;
          for (let byte = 0; byte < tileSizeBytes; byte += 1) {
            tileSizeMinus1 += reader.readBits(8) * multiplier;
            multiplier *= 256;
          }
          addNode(
            `tile_group.tiles[${index}].tile_size_minus_1`,
            tileSizeMinus1,
            `le(${tileSizeBytes})`,
            { startBit: baseBit + sizeStart, lengthBits: tileSizeBytes * 8 },
            "TileNum != tg_end",
          );
          tileSize = tileSizeMinus1 + 1;
          inferred(`tile_group.tiles[${index}].tile_size`, tileSize, "tile_size_minus_1 + 1");
        }

        const tileDataStartBit = reader.position;
        if (tileSize * 8 > reader.remaining) {
          diagnostics.push(diagnostic(
            "TILE_SIZE_EXCEEDS_PAYLOAD",
            Severity.ERROR,
            `Tile ${tileNum} declares ${tileSize} bytes but only ${Math.floor(reader.remaining / 8)} remain`,
            {
              range: byteRange(start + Math.floor(tileDataStartBit / 8), Math.floor(reader.remaining / 8)),
              frameId: obu.frameId,
              obuId: obu.obuId,
            },
          ));
          const summary = {
            kind: "tile_group",
            contextFrameHeaderObuId: frameContext?.sourceObuId ?? null,
            embeddedFrame,
            numTiles,
            tileCols,
            tileRows,
            tileSizeBytes,
            tileStartAndEndPresent: Boolean(tileStartAndEndPresent),
            tgStart,
            tgEnd,
            headerByteLength,
            tiles,
            completeFrame: false,
            nextExpectedTile: tgStart,
          };
          return result("error", reader.position, summary);
        }
        const tileRange = byteRange(start + tileDataStartBit / 8, tileSize);
        addNode(
          `tile_group.tiles[${index}].coded_tile_data`,
          { byteLength: tileSize },
          `bytes(${tileSize})`,
          { startBit: baseBit + tileDataStartBit, lengthBits: tileSize * 8 },
          "tile payload",
        );
        tiles.push({
          tileNum,
          tileRow: Math.floor(tileNum / tileCols),
          tileCol: tileNum % tileCols,
          tileSize,
          byteRange: tileRange,
          lastInGroup: lastTile,
        });
        reader.skipBits(tileSize * 8);
      }
    }

    const completeFrame = validRange && tgEnd === numTiles - 1;
    const summary = {
      kind: "tile_group",
      contextFrameHeaderObuId: frameContext?.sourceObuId ?? null,
      embeddedFrame,
      numTiles,
      tileCols,
      tileRows,
      tileSizeBytes,
      tileStartAndEndPresent: Boolean(tileStartAndEndPresent),
      tgStart,
      tgEnd,
      headerByteLength,
      tiles,
      completeFrame,
      nextExpectedTile: validRange && !completeFrame ? tgEnd + 1 : null,
    };
    const hasErrors = diagnostics.some(({ severity }) =>
      severity === Severity.ERROR || severity === Severity.FATAL);
    return result(hasErrors ? "error" : "complete", reader.position, summary);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    diagnostics.push(diagnostic(
      "TILE_GROUP_TRUNCATED",
      Severity.ERROR,
      `Tile Group ended before its structure was complete: ${error.message}`,
      {
        range: byteRange(start, Math.min(length, Math.ceil(reader.position / 8))),
        frameId: obu.frameId,
        obuId: obu.obuId,
      },
    ));
    return result("error", reader.position);
  }
}
