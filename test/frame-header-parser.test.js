import assert from "node:assert/strict";
import test from "node:test";

import { analyzeBuffer } from "../src/analyzer.js";
import { makeIvf } from "./fixtures.js";
import {
  decodeSignedBits,
  inverseRecenter,
  invalidatedSlotsFromOrderHints,
  operatingPointIncludes,
  parseFrameHeaderPrefix,
  recenterSubexpValue,
} from "../src/frame-header-parser.js";

const THREE_FRAME_IVF = Buffer.from(
  "REtJRgAAIABBVjAxQAAkAAMAAAABAAAAAwAAAAAAAABKAQAAAAAAAAAAAAASAAoKAAAAAq/xm18gCDK5AhQAKuAAAJALoNtxwP6QTV7mRbzMRcfEFDk9iHkMkyE3QX6JBldXXIWMD4S0GdzDtDYFKrl5mLYPUmDmXvAs8KHfCgVUZKO8D2bvkdIbLjOl230hCZ6NbNs2VfUM3Lqwm/XOu37vgux7tsdwKAGlP2HoObDk+8k6VL2zvmjikkrXivPuBraLOulu5oezmYF3x0GYo2ntQickWvi0pUK5ZW8KRDrjLAGV6HQLDygoXBG+Mg2ilOkMQ/mbSyDZVMYDjGckqM6DgfMJVTWQL5jv7u1zLjrpyLWRYcYmsk5Fuee7PXdaenk3EwK0JjZTRKwF9sXQ7e35whaiCbLuLAZZK870DJ7UW5oat754NrrvlLOzRKQJVaOeRl7W6ED0B4WQIEuT6HdXAlF6t8kz9qiVGVleyJ5s3X/I5Bw8AAAAAQAAAAAAAAASADI4MgHgQAAAI1/AEEGAEl1xANuHqvQWsA8l3ESaJwkmevZ80GUO9fUZv/ok1n3sq0FrFPRpeztZfUA2AAAAAgAAAAAAAAASADIyMgLgggAAA2AAIIKAFF11AN067TWZhAzW7Wi29EQ/pBdWWTwt9LqR2gYWNHgtMSfCzcM=",
  "base64",
);

const SEGMENTED_IVF = Buffer.from(
  "REtJRgAAIABBVjAxQAAkAAEAAAABAAAAAQAAAAAAAAA1AQAAAAAAAAAAAAASAAoKAAAAAq/xm18gCDKkAhQAMAHwgHrgPpAf2AgABBACDwEMAAAAoACg3F6MNGV1MoGJwRmfWTObN7CrsHJXcOuOx8Tx4CMraAuafqFVVMJZ7DryM+aC/RIMmz6mUHJwzEBN78F9WdQO7T6HJG/0rc0aZU9MZ6rHbW4oc2CaK0uytKmn4o8zizKGi52Yb8L0pn01Uwd6leQZWWed8yfhT5WVwI3XrvkpQvPjbwt4DZre4ox3QLMLNLnMNmOY8faAh3DJHZlUqpawmuC425oPH9byXhvKWIrr1hpAs8b+TFIPseTcVo+TydygtxQB2aPlOGJSuXKtQTAq3HaRC3bXnWqx0hTjQ2c0A4IbN6TbSkFJkFVAZxPIWzgFHpzwi3uY4NgkAkS8YBlVAzSbrhH5qiD0BwQ=",
  "base64",
);

const RESTORATION_IVF = Buffer.from(
  "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",
  "base64",
);

const GLOBAL_MOTION_IVF = Buffer.from(
  "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",
  "base64",
);

const FILM_GRAIN_IVF = Buffer.from(
  "REtJRgAAIABBVjAxgABIAAEAAAABAAAAAQAAAAAAAACpBAAAAAAAAAAAAAASAAoKAAAAAzf441fMBjKYCRQAo0AlHN9AAhNiFRHf8dEABH+DoACJsIqId/h3vz4+PsFAwT29uznCQkI+vDMzPsFAvr8zvz6/vz9AP7+9vj0+PkE+vLm2PUDBPz45gD+8Pb2/wT4+vju5vT2/Pbi4tr7CQL63sWmEBgQCAwIBANkfIDn3Id8NIsrR2Ft3e3FuJ7wS2sUDaXJJ8q0wD/HdxzgRPsuWOLWBR2aUlSqMmjsRVl+QnOzOHTOzBA+hFRka6DoiQxeFsTh4PpZVv8Rex0Tlu8lnEp26RuQivlME1tu3FdXxs+jPFTvWhLStEiiHGTrfs2mHpavqvN7BQaQ/SVHzDkEMy/+djjM+nqnsAUUvCVW+mE/dh0q4PKBF4GymgdN9ffeqksWHkyaUPTwrFRfWiLzUBfOaXIeLxPnwM+cY/oSY6ijF581OTfIDbA1y+GbHO0QcoLioK/RGVlB452cyuw8vH7n9rQyQG2pWDbwNZXcuvYYPhEB/EInj9tuBLKJ1XvnCmpjVg/Yox329IEXAsDdilyW5EDMiNeKSGT770ghSedE2pQtJaHgWdhJUjux/HJs7c58hDtVqBRaFosVUXqLmwptXBcU80/LITZcayQZM26vWAgBV4njjGQrtx/Qm2a4/IXUXR3bdnSZRF2uExY7j2MkcKHlDK/O/RRD/pHcJnb9+FfklYtDDQInELnR0yg0WnKTIaJBZt7/M9/ocQFQpB7CLHcUuP5wlfoZ+LENbjvcKE567+x7/4w9xMvIDZXnUzqdWmwq7U8ZpC8eR0XXcLwe7pX5zCLiclo6nivqQgsvlsJGfAnesDNdE+Hl7l6HO1VdhcGd8/17FF6DixbuQjw7xYVRIEj+PE4C3QjirIDpYBaGaLaHX2bSBCKnZla8wKae17bXGF8AZv9zi/TVzKqECDXNjp+y+w2CYVwQtwDGVd6bbiz+Bem49wzusrYz+PQxkiQqBC3wB7EGIX34u9n0GkusPYayp/66m6cacqJ7erOwxweKynQUmmnDm9UNZcUDtkLCkD2AHMtELfDgvTg40dCy6l8qko2V2YbXzr5QXR0SgcNwZ55lzwhF5CFSpqjGDhJ1pF9mxAWK9cwPRFAdZxcRIsqis43zyM1a5qJtLsV+8CFgV4ukiEohNs/7cEcYKWDI8DSR26GCIpjgDPiilj3tE7lSIRNAVkRzGSa3Z2a4Tu11kjvYeJfPcLeGUDpKqSDbVUV/e4Cn1Q+KYm9xCXeI76zH7hIV2VnYXDWkqZAzaX8EhxhlvwGNgI+vb2DUXggcwPPOWhNkK27dh0/gyTINVbmjgote4dUKQ18Feg8BaEk8ibxGeTtXVGcgBbQ2JuCw1MM9ZqG2xFn+Ok150JMSgaxIIlYD00nVzbbQGkEUOzy92QZL2EcwBMSzPAQfrJczX0BXmkpemobJ1426Em6sZc2jeUjYEuTQ3TaSV34DQNC/dsHJc2qcFWoKOyxSDlvWGS22/imzO0KHy9Xupar74QaTImafItLf4Mob0/hvooC0PkGWpaOqbs4zH0Tzlh9cSEVjzCl/6Vmi1VXq3N6JfTflBIDtl90oYipyXig==",
  "base64",
);

test("AV1 su(n) decodes fixed-width two's-complement boundaries", () => {
  assert.equal(decodeSignedBits(0b0000000, 7), 0);
  assert.equal(decodeSignedBits(0b0111111, 7), 63);
  assert.equal(decodeSignedBits(0b1000000, 7), -64);
  assert.equal(decodeSignedBits(0b1111111, 7), -1);
  assert.equal(decodeSignedBits(0b111000111, 9), -57);
  assert.throws(() => decodeSignedBits(0, 0), /bit width/);
});

test("subexponential recenter helpers cover both predictor halves", () => {
  assert.equal(inverseRecenter(4, 0), 4);
  assert.equal(inverseRecenter(4, 1), 3);
  assert.equal(inverseRecenter(4, 2), 5);
  assert.equal(inverseRecenter(2, 5), 5);
  assert.equal(recenterSubexpValue(17, 3, 1), 2);
  assert.equal(recenterSubexpValue(17, 14, 1), 15);
});

test("operating-point layer membership follows temporal and spatial IDC masks", () => {
  assert.equal(operatingPointIncludes(0, 7, 3), true);
  const point = (1 << 2) | (1 << (1 + 8));
  assert.equal(operatingPointIncludes(point, 2, 1), true);
  assert.equal(operatingPointIncludes(point, 1, 1), false);
  assert.equal(operatingPointIncludes(point, 2, 0), false);
});

test("reference order-hint mismatches invalidate only populated slots", () => {
  const slots = [
    { orderHint: 2 }, null, { orderHint: 5 }, { orderHint: 0 },
  ];
  assert.deepEqual(invalidatedSlotsFromOrderHints(slots, [2, 7, 1, 3]), [2, 3]);
  assert.deepEqual(invalidatedSlotsFromOrderHints(slots, [2, 7, 5, 0]), []);
});

test("show-existing frame reads decoder-model presentation time", () => {
  const payload = Buffer.from([0b10110101]); // show_existing=1, slot=3, presentation_time=0101
  const obu = {
    obuId: 9, frameId: 4, temporalId: 0, spatialId: 0,
    payloadRange: { start: 0, length: payload.length },
  };
  const parsed = parseFrameHeaderPrefix(payload, obu, {
    reducedStillPictureHeader: 0,
    decoderModelInfoPresentFlag: 1,
    equalPictureInterval: 0,
    framePresentationTimeLengthMinus1: 3,
    frameIdNumbersPresentFlag: 0,
  });
  assert.equal(parsed.status, "partial");
  assert.equal(parsed.summary.frameToShowMapIdx, 3);
  assert.equal(parsed.summary.framePresentationTime, 5);
  assert.equal(parsed.diagnostics.at(-1).code, "SHOW_EXISTING_REFERENCE_MISSING");
  const time = parsed.nodes.find(({ path }) => path === "frame_header.frame_presentation_time");
  assert.deepEqual(time.bitRange, { startBit: 4, lengthBits: 4 });
});

test("show-existing frame restores reference type, frame id, geometry, and film grain", () => {
  // show_existing=1, slot=3, display_frame_id=5.
  const payload = Buffer.from([0b10111010]);
  const grain = { applyGrain: true, grainSeed: 1234, yPoints: [{ value: 7, scaling: 21 }] };
  const referenceSlots = Array(8).fill(null);
  referenceSlots[3] = {
    frameId: 12, frameType: 0, currentFrameId: 5,
    frameWidth: 1920, frameHeight: 1080, renderWidth: 1920, renderHeight: 1080,
    orderHint: 9, filmGrain: grain,
  };
  const parsed = parseFrameHeaderPrefix(payload, {
    obuId: 11, frameId: 13, header: { temporalId: 0, spatialId: 0 },
    payloadRange: { start: 0, length: payload.length },
  }, {
    reducedStillPictureHeader: 0,
    decoderModelInfoPresentFlag: 0,
    equalPictureInterval: 1,
    frameIdNumbersPresentFlag: 1,
    additionalFrameIdLengthMinus1: 0,
    deltaFrameIdLengthMinus2: 0,
    filmGrainParamsPresent: 1,
  }, { referenceSlots });

  assert.equal(parsed.summary.frameType, 0);
  assert.equal(parsed.summary.referencedFrameTypeName, "KEY_FRAME");
  assert.equal(parsed.summary.displayFrameId, 5);
  assert.equal(parsed.summary.refreshFrameFlags, 0xff);
  assert.equal(parsed.summary.referenceFrameIds[0], 12);
  assert.equal(parsed.summary.frameWidth, 1920);
  assert.equal(parsed.summary.orderHint, 9);
  assert.deepEqual(parsed.summary.filmGrain, grain);
  assert.notEqual(parsed.summary.filmGrain, grain);
  assert.equal(parsed.diagnostics.length, 0);
});

test("show-existing diagnoses forbidden frame OBU use and a non-showable slot", () => {
  const payload = Buffer.from([0b10000000]); // show_existing=1, slot=0
  const referenceSlots = [{ frameId: 4, frameType: 1, showableFrame: false }];
  const parsed = parseFrameHeaderPrefix(payload, {
    obuId: 12, frameId: 5, type: { code: 6 },
    payloadRange: { start: 0, length: payload.length },
  }, {
    reducedStillPictureHeader: 0,
    decoderModelInfoPresentFlag: 0,
    equalPictureInterval: 1,
    frameIdNumbersPresentFlag: 0,
    filmGrainParamsPresent: 0,
  }, { referenceSlots });

  assert.deepEqual(parsed.diagnostics.map(({ code }) => code), [
    "SHOW_EXISTING_IN_FRAME_OBU",
    "SHOW_EXISTING_REFERENCE_NOT_SHOWABLE",
  ]);
  assert.equal(parsed.summary.refreshFrameFlags, 0);
});

test("buffer-removal times include only matching extension layers", () => {
  // reduced header: disable_cdf=0, removal_present=1, op0=010, op2=110; the rest is intentionally truncated.
  const payload = Buffer.from([0b01010110, 0b00000000]);
  const obu = {
    obuId: 10, frameId: 5, header: { temporalId: 2, spatialId: 1 },
    payloadRange: { start: 0, length: payload.length },
  };
  const matchingIdc = (1 << 2) | (1 << 9);
  const parsed = parseFrameHeaderPrefix(payload, obu, {
    reducedStillPictureHeader: 1,
    decoderModelInfoPresentFlag: 1,
    equalPictureInterval: 1,
    bufferRemovalTimeLengthMinus1: 2,
    framePresentationTimeLengthMinus1: 0,
    operatingPoints: [
      { operatingPointIdc: 0, decoderModelPresent: true },
      { operatingPointIdc: 1 << 1, decoderModelPresent: true },
      { operatingPointIdc: matchingIdc, decoderModelPresent: true },
    ],
    frameIdNumbersPresentFlag: 0,
    frameWidthBitsMinus1: 0,
    frameHeightBitsMinus1: 0,
    maxFrameWidthMinus1: 0,
    maxFrameHeightMinus1: 0,
    enableOrderHint: 0,
    orderHintBitsMinus1: -1,
    enableSuperres: 0,
    use128x128Superblock: 0,
    enableWarpedMotion: 0,
    enableRefFrameMvs: 0,
    enableCdef: 0,
    enableRestoration: 0,
    filmGrainParamsPresent: 0,
    numPlanes: 1,
    subsamplingX: 1,
    subsamplingY: 1,
    separateUvDeltaQ: 0,
    seqForceScreenContentTools: 0,
    seqForceIntegerMv: 0,
  });
  assert.equal(parsed.status, "error");
  const times = parsed.nodes.filter(({ path }) => path.startsWith("frame_header.buffer_removal_time["));
  assert.deepEqual(times.map(({ path, value }) => [path, value]), [
    ["frame_header.buffer_removal_time[0]", 2],
    ["frame_header.buffer_removal_time[2]", 6],
  ]);
  assert.ok(times.every(({ bitRange }) => bitRange.lengthBits === 3));
});

test("real adaptive-quantization stream exposes complete segmentation features", () => {
  const report = analyzeBuffer(SEGMENTED_IVF, { sourceName: "segmented.ivf" });
  const summary = report.frames[0].headerSummary;
  assert.equal(report.diagnostics.length, 0);
  assert.equal(summary.segmentationEnabled, 1);
  assert.equal(summary.segmentationUpdateMap, 1);
  assert.equal(summary.segmentationUpdateData, 1);
  assert.deepEqual(summary.segmentation.map((features) => features[0].value), [-62, -41, -23, -5, 0, 8, 15, 24]);
  assert.equal(summary.segmentation[0][0].enabled, true);
  assert.equal(summary.segmentation[0][1].enabled, false);
  assert.equal(summary.allLossless, false);

  const values = report.syntaxNodes.filter(({ path }) => path.endsWith("alt_q.feature_value"));
  assert.deepEqual(values.map(({ value }) => value), [-62, -41, -23, -5, 0, 8, 15, 24]);
  assert.ok(values.every(({ coding, bitRange }) => coding === "su(9)" && bitRange.lengthBits === 9));
});

test("non-uniform one-by-one tile syntax continues into quantization fields", () => {
  const original = analyzeBuffer(THREE_FRAME_IVF);
  const uniform = original.syntaxNodes.find(
    ({ path, obuId }) => path === "frame_header.tile_info.uniform_tile_spacing_flag" &&
      obuId === original.frames[0].obuIds.at(-1),
  );
  assert.equal(uniform.value, 1);
  const mutated = Buffer.from(THREE_FRAME_IVF);
  const byte = Math.floor(uniform.bitRange.startBit / 8);
  const bitInByte = uniform.bitRange.startBit % 8;
  mutated[byte] &= ~(1 << (7 - bitInByte));

  const report = analyzeBuffer(mutated, { sourceName: "non-uniform-one-tile.ivf" });
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.frames[0].headerSummary.baseQIdx, 87);
  assert.deepEqual(report.frames[0].headerSummary.tileWidthsSb, [1]);
  assert.deepEqual(report.frames[0].headerSummary.tileHeightsSb, [1]);
  const nodes = report.syntaxNodes.filter(({ obuId }) => obuId === report.frames[0].obuIds.at(-1));
  assert.equal(nodes.find(({ path }) => path === "frame_header.tile_info.uniform_tile_spacing_flag").value, 0);
  const width = nodes.find(({ path }) => path === "frame_header.tile_info.width_in_sbs_minus_1[0]");
  assert.equal(width.value, 0);
  assert.equal(width.coding, "ns(1)");
  assert.equal(width.bitRange.lengthBits, 0);
});

test("real libaom stream exposes loop restoration types and unit size", () => {
  const report = analyzeBuffer(RESTORATION_IVF, { sourceName: "restoration.ivf" });
  const summary = report.frames[0].headerSummary;
  assert.equal(report.diagnostics.length, 0);
  assert.deepEqual(summary.restorationTypes, ["RESTORE_SGRPROJ", "RESTORE_NONE", "RESTORE_NONE"]);
  assert.equal(summary.usesLoopRestoration, true);
  assert.equal(summary.lrUnitShift, 2);
  assert.equal(summary.lrUvShift, 0);
  assert.deepEqual(summary.loopRestorationSizes, [256, 256, 256]);
  const nodes = report.syntaxNodes.filter(({ path }) => path.startsWith("frame_header.loop_restoration"));
  assert.deepEqual(nodes.slice(0, 3).map(({ value }) => value), [3, 0, 0]);
  assert.equal(nodes.find(({ path }) => path.endsWith("lr_unit_extra_shift")).value, 1);
});

test("real panning stream decodes ROTZOOM subexp codes and matrix", () => {
  const report = analyzeBuffer(GLOBAL_MOTION_IVF, { sourceName: "global-motion.ivf" });
  const summary = report.frames[1].headerSummary;
  assert.equal(report.diagnostics.length, 0);
  assert.equal(summary.globalMotionTypes[0], "ROTZOOM");
  assert.deepEqual(summary.globalMotionTypes.slice(1), Array(6).fill("IDENTITY"));
  assert.deepEqual(summary.globalMotionParams[0], [142336, 157696, 65724, 334, -334, 65724]);
  const obu = report.obus.find(({ frameId, frameHeaderSummary }) => frameId === 1 && frameHeaderSummary);
  const codes = report.syntaxNodes.filter(
    ({ obuId, path }) => obuId === obu.obuId && path.endsWith(".subexp_code"),
  );
  assert.deepEqual(codes.map(({ value }) => value), [188, 334, 278, 308]);
  assert.deepEqual(codes.map(({ bitRange }) => bitRange.startBit - obu.byteRange.start * 8), [154, 167, 182, 197]);
});

test("real SVT-AV1 stream exposes complete film grain parameters", () => {
  const report = analyzeBuffer(FILM_GRAIN_IVF, { sourceName: "film-grain.ivf" });
  const grain = report.frames[0].headerSummary.filmGrain;
  assert.equal(report.diagnostics.length, 0);
  assert.equal(grain.applyGrain, true);
  assert.equal(grain.grainSeed, 7391);
  assert.equal(grain.updateGrain, true);
  assert.deepEqual(grain.yPoints, [
    { value: 0, scaling: 33 }, { value: 54, scaling: 33 },
    { value: 81, scaling: 29 }, { value: 255, scaling: 29 },
  ]);
  assert.deepEqual(grain.cbPoints, [{ value: 0, scaling: 8 }, { value: 255, scaling: 7 }]);
  assert.equal(grain.crPoints.length, 4);
  assert.equal(grain.arCoeffLag, 3);
  assert.equal(grain.arCoefficientsY.length, 24);
  assert.equal(grain.arCoefficientsCb.length, 25);
  assert.equal(grain.arCoefficientsCr.length, 25);
  assert.deepEqual(
    [grain.cbMult, grain.cbLumaMult, grain.cbOffset, grain.crMult, grain.crLumaMult, grain.crOffset],
    [128, 192, 256, 128, 192, 256],
  );
  assert.equal(grain.overlapFlag, true);
  assert.equal(grain.clipToRestrictedRange, false);
});

test("real three-frame stream exposes KEY/INTER/INTER timeline summaries", () => {
  const report = analyzeBuffer(THREE_FRAME_IVF, { sourceName: "three-frame.ivf" });
  assert.deepEqual(
    report.frames.map(({ headerSummary }) => headerSummary.frameTypeName),
    ["KEY_FRAME", "INTER_FRAME", "INTER_FRAME"],
  );
  assert.deepEqual(
    report.frames.map(({ headerSummary }) => [headerSummary.frameWidth, headerSummary.frameHeight]),
    [[64, 36], [64, 36], [64, 36]],
  );
  assert.deepEqual(
    report.frames.map(({ headerSummary }) => headerSummary.showFrame),
    [1, 1, 1],
  );
  assert.equal(report.diagnostics.length, 0);
  assert.equal(report.summary.complete, true);
  assert.equal(report.frames[0].headerSummary.refreshFrameFlags, 0xff);
  assert.deepEqual(report.frames[1].headerSummary.referenceFrameIds, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(report.frames[2].headerSummary.referenceSlotIndices, [1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(report.frames[2].headerSummary.referenceFrameIds, [1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    report.frames.map(({ headerSummary }) => headerSummary.baseQIdx),
    [87, 127, 128],
  );
  assert.deepEqual(
    report.frames.map(({ headerSummary }) => headerSummary.loopFilterLevels),
    [[0, 0, 0, 0], [4, 4, 6, 0], [8, 8, 10, 0]],
  );
  assert.deepEqual(
    report.frames.map(({ headerSummary }) => [headerSummary.tileColsLog2, headerSummary.tileRowsLog2]),
    [[0, 0], [0, 0], [0, 0]],
  );
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.orderHint), [0, 1, 2]);
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.invalidatedReferenceSlots), [[], [], []]);
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.txMode), ["TX_MODE_SELECT", "TX_MODE_LARGEST", "TX_MODE_SELECT"]);
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.referenceSelect), [0, 0, 0]);
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.allowWarpedMotion), [0, 1, 1]);
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.reducedTxSet), [0, 0, 0]);
  assert.deepEqual(report.frames.map(({ headerSummary }) => headerSummary.filmGrain), [
    { applyGrain: false }, { applyGrain: false }, { applyGrain: false },
  ]);
  assert.deepEqual(report.frames.slice(1).map(({ headerSummary }) => headerSummary.globalMotionTypes), [
    Array(7).fill("IDENTITY"),
    Array(7).fill("IDENTITY"),
  ]);
  for (const frame of report.frames.slice(1)) {
    const obu = report.obus.find(({ obuId, frameHeaderSummary }) => frame.obuIds.includes(obuId) && frameHeaderSummary);
    const referenceSelect = report.syntaxNodes.find(
      ({ obuId, path }) => obuId === obu.obuId && path === "frame_header.reference_select",
    );
    assert.equal(referenceSelect.bitRange.startBit - obu.byteRange.start * 8, 134);
  }
});

test("a repeated Sequence Header preserves reference state within the coded sequence", () => {
  const original = analyzeBuffer(THREE_FRAME_IVF);
  const sequence = original.obus.find(({ type }) => type.code === 1);
  const sequenceBytes = THREE_FRAME_IVF.subarray(sequence.byteRange.start, sequence.byteRange.start + sequence.byteRange.length);
  const framePayloads = original.frames.map(({ payloadRange }) =>
    THREE_FRAME_IVF.subarray(payloadRange.start, payloadRange.start + payloadRange.length),
  );
  const restarted = makeIvf([
    { payload: framePayloads[0], timestamp: 0n },
    { payload: framePayloads[1], timestamp: 1n },
    { payload: Buffer.concat([sequenceBytes, framePayloads[2]]), timestamp: 2n },
  ], { width: 64, height: 36 });
  const report = analyzeBuffer(restarted, { sourceName: "sequence-reset.ivf" });

  assert.deepEqual(report.frames[1].headerSummary.referenceFrameIds, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(report.frames[2].headerSummary.referenceFrameIds, [1, 0, 0, 0, 0, 0, 0]);
});

test("coded Frame Header fields keep absolute bit ranges and inferred fields do not fake them", () => {
  const report = analyzeBuffer(THREE_FRAME_IVF);
  const keyFrameObu = report.obus.find(({ frameHeaderSummary }) => frameHeaderSummary?.frameTypeName === "KEY_FRAME");
  const nodes = report.syntaxNodes.filter(({ obuId }) => obuId === keyFrameObu.obuId);
  const frameType = nodes.find(({ path }) => path === "frame_header.frame_type");
  const disableCdf = nodes.find(({ path }) => path === "frame_header.disable_cdf_update");
  assert.equal(frameType.coding, "f(2)");
  assert.ok(frameType.bitRange.startBit >= keyFrameObu.payloadRange.start * 8);
  assert.equal(disableCdf.coding, "f(1)");

  const primaryRef = nodes.find(({ path }) => path === "frame_header.primary_ref_frame");
  assert.equal(primaryRef.coding, "inferred");
  assert.equal(primaryRef.bitRange, null);

  const baseQ = nodes.find(({ path }) => path === "frame_header.quantization.base_q_idx");
  assert.equal(baseQ.value, 87);
  assert.equal(baseQ.coding, "f(8)");
  assert.equal(baseQ.bitRange.startBit, keyFrameObu.payloadRange.start * 8 + 19);
});
