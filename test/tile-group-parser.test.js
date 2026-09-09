import assert from "node:assert/strict";
import test from "node:test";

import { parseTileGroup } from "../src/tile-group-parser.js";

function context(overrides = {}) {
  return {
    sourceObuId: 7,
    nextExpectedTile: 0,
    summary: {
      tileCols: 2,
      tileRows: 2,
      tileColsLog2: 1,
      tileRowsLog2: 1,
      tileSizeBytes: 2,
      ...overrides,
    },
  };
}

function obu(payload, overrides = {}) {
  return {
    obuId: 8,
    frameId: 3,
    payloadRange: { start: 0, length: payload.length },
    ...overrides,
  };
}

test("parses an explicit multi-tile range and little-endian size fields", () => {
  // present=1, start=1, end=3, then three zero alignment bits.
  const payload = Buffer.from([0xb8, 0x01, 0x00, 0xaa, 0xbb, 0x00, 0x00, 0xcc, 0xdd, 0xee, 0xff]);
  const parsed = parseTileGroup(payload, obu(payload), context({}), { expectedTileStart: 1 });

  assert.equal(parsed.status, "complete");
  assert.equal(parsed.diagnostics.length, 0);
  assert.deepEqual(parsed.summary, {
    kind: "tile_group",
    contextFrameHeaderObuId: 7,
    embeddedFrame: false,
    numTiles: 4,
    tileCols: 2,
    tileRows: 2,
    tileSizeBytes: 2,
    tileStartAndEndPresent: true,
    tgStart: 1,
    tgEnd: 3,
    headerByteLength: 1,
    tiles: [
      { tileNum: 1, tileRow: 0, tileCol: 1, tileSize: 2, byteRange: { start: 3, length: 2 }, lastInGroup: false },
      { tileNum: 2, tileRow: 1, tileCol: 0, tileSize: 1, byteRange: { start: 7, length: 1 }, lastInGroup: false },
      { tileNum: 3, tileRow: 1, tileCol: 1, tileSize: 3, byteRange: { start: 8, length: 3 }, lastInGroup: true },
    ],
    completeFrame: true,
    nextExpectedTile: null,
  });
  assert.equal(parsed.parsedBitLength, payload.length * 8);
  const firstSize = parsed.nodes.find(({ path }) => path === "tile_group.tiles[0].tile_size_minus_1");
  assert.equal(firstSize.value, 1);
  assert.equal(firstSize.coding, "le(2)");
  assert.deepEqual(firstSize.bitRange, { startBit: 8, lengthBits: 16 });
  const lastData = parsed.nodes.find(({ path }) => path === "tile_group.tiles[2].coded_tile_data");
  assert.deepEqual(lastData.value, { byteLength: 3 });
  assert.deepEqual(lastData.bitRange, { startBit: 64, lengthBits: 24 });
});

test("implicit range covers the complete frame and a single tile needs no header byte", () => {
  const multi = Buffer.from([0x00, 0x00, 0x00, 0xa1, 0x00, 0x00, 0xa2, 0x00, 0x00, 0xa3, 0xa4, 0xa5]);
  const parsed = parseTileGroup(multi, obu(multi), context());
  assert.equal(parsed.status, "complete");
  assert.deepEqual(parsed.summary.tiles.map(({ tileSize }) => tileSize), [1, 1, 1, 2]);
  assert.equal(parsed.summary.headerByteLength, 1);

  const single = Buffer.from([0xde, 0xad]);
  const one = parseTileGroup(single, obu(single), context({
    tileCols: 1,
    tileRows: 1,
    tileColsLog2: 0,
    tileRowsLog2: 0,
    tileSizeBytes: 0,
  }));
  assert.equal(one.status, "complete");
  assert.equal(one.summary.headerByteLength, 0);
  assert.deepEqual(one.summary.tiles[0].byteRange, { start: 0, length: 2 });
});

test("embedded OBU_FRAME honors both byte-alignment stages", () => {
  // Three already-parsed frame-header bits, five frame alignment zeros, then
  // range flag 0 plus seven tile-group alignment zeros.
  const payload = Buffer.from([0xa0, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x22, 0x00, 0x00, 0x33, 0x44]);
  const parsed = parseTileGroup(payload, obu(payload), context(), {
    startBitOffset: 3,
    embeddedFrame: true,
  });
  assert.equal(parsed.status, "complete");
  assert.equal(parsed.summary.embeddedFrame, true);
  assert.equal(parsed.summary.headerByteLength, 1);
  assert.deepEqual(parsed.summary.tiles.map(({ byteRange }) => byteRange), [
    { start: 4, length: 1 },
    { start: 7, length: 1 },
    { start: 10, length: 1 },
    { start: 11, length: 1 },
  ]);
  assert.equal(parsed.nodes.filter(({ path }) => path.startsWith("frame_obu.byte_alignment")).length, 5);
});

test("diagnoses invalid ranges, discontinuity, truncation, and oversized tiles", () => {
  const reversed = Buffer.from([0xe8]); // present=1, start=3, end=1.
  const badRange = parseTileGroup(reversed, obu(reversed), context());
  assert.equal(badRange.status, "error");
  assert.deepEqual(badRange.diagnostics.map(({ code }) => code), [
    "TILE_GROUP_RANGE_REVERSED",
    "TILE_GROUP_ORDER_DISCONTINUITY",
  ]);

  const discontinuous = Buffer.from([0x98, 0xff]); // present=1, start=0, end=3; truncated first size.
  const truncated = parseTileGroup(discontinuous, obu(discontinuous), context());
  assert.equal(truncated.status, "error");
  assert.equal(truncated.diagnostics.at(-1).code, "TILE_GROUP_TRUNCATED");

  const oversized = Buffer.from([0x00, 0x09, 0x00, 0xaa]);
  const tooLarge = parseTileGroup(oversized, obu(oversized), context());
  assert.equal(tooLarge.status, "error");
  assert.equal(tooLarge.diagnostics.at(-1).code, "TILE_SIZE_EXCEEDS_PAYLOAD");
});

test("requires a validated frame tile layout and enforces OBU_FRAME range rules", () => {
  const payload = Buffer.from([0x00]);
  const missing = parseTileGroup(payload, obu(payload), null);
  assert.equal(missing.status, "error");
  assert.equal(missing.diagnostics[0].code, "TILE_GROUP_FRAME_CONTEXT_MISSING");

  // Embedded group: present=1, start=0, end=3.
  const embedded = Buffer.from([0x00, 0x98, 0x00, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00, 0x03, 0x04]);
  const forbiddenRange = parseTileGroup(embedded, obu(embedded), context(), {
    startBitOffset: 8,
    embeddedFrame: true,
  });
  assert.equal(forbiddenRange.status, "error");
  assert.ok(forbiddenRange.diagnostics.some(({ code }) => code === "FRAME_OBU_TILE_RANGE_FLAG_SET"));
});
