import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFrameTableRows,
  filterFrameTableRows,
  frameTableCsvRows,
  pageFrameTableRows,
  sortFrameTableRows,
} from "../public/frame-table.js";

const frames = [
  {
    frameId: 0, decodeIndex: 0, timestamp: "90071992547409930", pts: "90071992547409930",
    dts: "0", declaredSize: 1_200, obuIds: [0, 1],
    headerSummary: { frameTypeName: "KEY_FRAME", baseQIdx: 80, referenceFrameIds: [] },
  },
  {
    frameId: 1, decodeIndex: 1, timestamp: "90071992547409931", pts: "90071992547409931",
    dts: "1", declaredSize: 320, obuIds: [2],
    headerSummary: { frameTypeName: "INTER_FRAME", baseQIdx: 120, referenceFrameIds: [0, 0, null] },
  },
  {
    frameId: 2, decodeIndex: 2, timestamp: "90071992547409932", pts: "90071992547409932",
    dts: "2", declaredSize: 640, obuIds: [3],
    headerSummary: { frameTypeName: "INTER_FRAME", baseQIdx: 96, referenceFrameIds: [0, 1] },
  },
];

const statistics = {
  points: [
    { frameId: 0, durationTicks: "1", durationSeconds: 1 / 30, durationSource: "explicit", bitrateBitsPerSecond: 288_000, keyframe: true, gopIndex: 0, gopFrameIndex: 0 },
    { frameId: 1, durationTicks: "1", durationSeconds: 1 / 30, durationSource: "explicit", bitrateBitsPerSecond: 76_800, keyframe: false, gopIndex: 0, gopFrameIndex: 1 },
  ],
};

test("frame table joins exact frame, sampled statistics and diagnostics without inventing values", () => {
  const rows = buildFrameTableRows(frames, statistics, [
    { frameId: 1, severity: "warning" },
    { frameId: 1, severity: "error" },
    { frameId: null, severity: "warning" },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].references, [0]);
  assert.equal(rows[1].diagnosticCount, 2);
  assert.equal(rows[1].hasDiagnostic, true);
  assert.equal(rows[2].bitrateBitsPerSecond, null);
  assert.equal(rows[2].gopIndex, null);
});

test("frame table combines range, type, GOP, diagnostic and Q filters", () => {
  const rows = buildFrameTableRows(frames, statistics, [{ frameId: 1 }]);
  assert.deepEqual(filterFrameTableRows(rows, {
    frameIdMin: "1",
    frameIdMax: "2",
    frameType: "INTER_FRAME",
    gopIndex: "0",
    diagnostic: "with",
    qindexMin: "100",
    qindexMax: "130",
    sizeMin: "300",
    sizeMax: "400",
    bitrateMin: "70000",
    bitrateMax: "80000",
  }).map(({ frameId }) => frameId), [1]);
  assert.deepEqual(filterFrameTableRows(rows, { diagnostic: "without" }).map(({ frameId }) => frameId), [0, 2]);
});

test("frame table sorting is stable, keeps missing values last and preserves large timestamps", () => {
  const rows = buildFrameTableRows(frames, statistics);
  assert.deepEqual(sortFrameTableRows(rows, { key: "sizeBytes", direction: "descending" }).map(({ frameId }) => frameId), [0, 2, 1]);
  assert.deepEqual(sortFrameTableRows(rows, { key: "bitrateBitsPerSecond", direction: "ascending" }).map(({ frameId }) => frameId), [1, 0, 2]);
  assert.deepEqual(sortFrameTableRows([...rows].reverse(), { key: "pts", direction: "ascending" }).map(({ frameId }) => frameId), [0, 1, 2]);
});

test("frame table pagination clamps pages and bounds DOM-sized results", () => {
  const rows = Array.from({ length: 251 }, (_, frameId) => ({ frameId }));
  const second = pageFrameTableRows(rows, { page: 1 });
  assert.equal(second.rows.length, 100);
  assert.equal(second.start, 100);
  assert.equal(second.end, 200);
  assert.equal(second.pageCount, 3);
  const clamped = pageFrameTableRows(rows, { page: 99 });
  assert.equal(clamped.page, 2);
  assert.equal(clamped.rows.length, 51);
});

test("frame table CSV contains filtered-workbench columns", () => {
  const [header, row] = frameTableCsvRows(buildFrameTableRows(frames.slice(0, 1), statistics));
  assert.match(header, /frame_bitrate_bps/);
  assert.match(header, /diagnostic_count/);
  assert.match(row, /KEY_FRAME/);
  assert.match(row, /288000/);
});
