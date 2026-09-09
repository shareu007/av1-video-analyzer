import assert from "node:assert/strict";
import test from "node:test";

import { csvCell, csvRow, timelineCsvRows } from "../public/csv.js";

test("GUI CSV escapes RFC 4180 delimiter, quote and line-break characters", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell(null), "");
  assert.equal(csvRow([1, "P,FRAME", 'ref "LAST"']), '1,"P,FRAME","ref ""LAST"""');
});

test("GUI timeline CSV exports timing, bitrate and GOP columns", () => {
  const rows = timelineCsvRows([{
    frameId: 0,
    decodeIndex: 0,
    timestamp: "7",
    pts: "7",
    dts: "6",
    declaredSize: 120,
    obuIds: [1, 2],
    headerSummary: { frameTypeName: "KEY", baseQIdx: 96, referenceFrameIds: [] },
  }], {
    points: [{
      frameId: 0,
      durationTicks: "1",
      durationSeconds: 1 / 30,
      durationSource: "explicit",
      bitrateBitsPerSecond: 28_800,
      keyframe: true,
      gopIndex: 0,
      gopFrameIndex: 0,
      frameType: "KEY",
    }],
  });

  assert.match(rows[0], /duration_seconds/);
  assert.match(rows[0], /frame_bitrate_bps/);
  assert.match(rows[0], /gop_frame_index/);
  assert.equal(rows.length, 2);
  assert.match(rows[1], /7,6,1,0\.03333333333333333,explicit,28800,true,0,0,KEY,120,2,96/);
});
