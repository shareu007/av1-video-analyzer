import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeFrameStatistics,
  createFrameStatisticsAccumulator,
  normalizeFrameTimebase,
} from "../src/frame-statistics.js";

const frame = (frameId, timestamp, declaredSize, type, extra = {}) => ({
  frameId,
  decodeIndex: frameId,
  timestamp: String(timestamp),
  declaredSize,
  headerSummary: { frameTypeName: type },
  ...extra,
});

test("normalizes IVF and rational packet timebases without losing integer ticks", () => {
  assert.deepEqual(normalizeFrameTimebase({ timebase: { rate: 30, scale: 1 } }), {
    numerator: "1", denominator: "30", secondsPerTick: 1 / 30,
  });
  assert.deepEqual(normalizeFrameTimebase({ timebase: "1/90000" }), {
    numerator: "1", denominator: "90000", secondsPerTick: 1 / 90_000,
  });
  assert.equal(normalizeFrameTimebase({ timebase: "0/0" }), null);
});

test("computes exact IVF bitrate, frame-size percentiles and GOP boundaries", () => {
  const result = analyzeFrameStatistics([
    frame(0, 0, 100, "KEY"),
    frame(1, 1, 50, "INTER"),
    frame(2, 2, 60, "INTER"),
    frame(3, 3, 200, "KEY"),
  ], { timebase: { rate: 30, scale: 1 } });
  assert.equal(result.schemaVersion, "av1scope.frame-statistics.v1");
  assert.equal(result.timingMode, "inferred");
  assert.equal(result.frameCount, 4);
  assert.equal(result.totalBytes, 410);
  assert.ok(Math.abs(result.durationSeconds - 4 / 30) < 1e-12);
  assert.ok(Math.abs(result.averageFrameRate - 30) < 1e-12);
  assert.ok(Math.abs(result.averageBitrateBitsPerSecond - 24_600) < 1e-9);
  assert.equal(result.peakFrameBitrateBitsPerSecond, 48_000);
  assert.equal(result.peakFrameId, 3);
  assert.deepEqual(result.frameSizeBytes, {
    minimum: 50, maximum: 200, average: 102.5, p50: 60, p95: 100,
  });
  assert.deepEqual(result.gop.records.map(({ startFrameId, endFrameId, length }) => ({
    startFrameId, endFrameId, length,
  })), [
    { startFrameId: 0, endFrameId: 2, length: 3 },
    { startFrameId: 3, endFrameId: 3, length: 1 },
  ]);
  assert.equal(result.gop.averageLength, 2);
  assert.equal(result.points[1].gopFrameIndex, 1);
});

test("prefers packet duration, keeps negative DTS, and reports clock discontinuity", () => {
  const result = analyzeFrameStatistics([
    frame(0, 0, 1_000, "KEY", { pts: "0", dts: "-1", duration: "40", keyframe: true }),
    frame(1, 40, 500, "INTER", { pts: "40", dts: "-1", duration: "40", keyframe: false }),
  ], { timebase: "1/1000" });
  assert.equal(result.timingMode, "explicit");
  assert.equal(result.durationSources.explicit, 2);
  assert.equal(result.points[0].dts, "-1");
  assert.equal(result.points[0].bitrateBitsPerSecond, 200_000);
  assert.equal(result.anomalyCounts.FRAME_CLOCK_NON_MONOTONIC, 1);
});

test("does not invent seconds or bitrate when the container timebase is unavailable", () => {
  const result = analyzeFrameStatistics([frame(0, 0, 100, "UNKNOWN")], null);
  assert.equal(result.timingMode, "unavailable");
  assert.equal(result.durationSeconds, null);
  assert.equal(result.averageBitrateBitsPerSecond, null);
  assert.equal(result.points[0].durationSeconds, null);
  assert.equal(result.points[0].keyframeSource, "assumed-first");
});

test("incremental statistics bound chart points while retaining min/max samples", () => {
  const accumulator = createFrameStatisticsAccumulator({
    container: { timebase: "1/1000" }, totalFrameCount: 10_000, maxPoints: 100,
  });
  for (let index = 0; index < 10_000; index += 1) {
    accumulator.add(frame(index, index, index === 5_555 ? 1_000_000 : 100 + index % 10, "INTER"));
  }
  const result = accumulator.finish();
  assert.equal(result.frameCount, 10_000);
  assert.equal(result.pointsDownsampled, true);
  assert.ok(result.points.length <= 400);
  assert.ok(result.points.some(({ frameId }) => frameId === 5_555));
  assert.equal(accumulator.finish(), result);
});

test("unknown frame count keeps chart storage bounded and retains late peaks", () => {
  const accumulator = createFrameStatisticsAccumulator({
    container: { timebase: "1/1000" }, totalFrameCount: null, maxPoints: 100,
  });
  for (let index = 0; index < 10_000; index += 1) {
    accumulator.add(frame(index, index, index === 9_999 ? 1_000_000 : 100, "INTER"));
  }
  const result = accumulator.finish();
  assert.ok(result.points.length <= 104);
  assert.ok(result.points.some(({ frameId }) => frameId === 9_999));
});
