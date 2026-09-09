export const FRAME_STATISTICS_SCHEMA_VERSION = "av1scope.frame-statistics.v1";

const DEFAULT_MAX_POINTS = 2_048;
const DEFAULT_MAX_GOPS = 4_096;
const DEFAULT_MAX_ANOMALIES = 1_000;
const KEY_FRAME_TYPES = new Set(["KEY", "INTRA_ONLY", "SWITCH"]);

function integerText(value) {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return value;
  return null;
}

function integerTicks(value) {
  const text = integerText(value);
  return text === null ? null : BigInt(text);
}

export function normalizeFrameTimebase(container) {
  const value = container?.timebase;
  let numerator;
  let denominator;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const rate = integerTicks(value.rate);
    const scale = integerTicks(value.scale);
    if (rate !== null && scale !== null && rate > 0n && scale > 0n) {
      numerator = scale;
      denominator = rate;
    }
  } else if (typeof value === "string") {
    const match = /^(\d+)\/(\d+)$/u.exec(value);
    if (match) {
      numerator = BigInt(match[1]);
      denominator = BigInt(match[2]);
    }
  }
  if (numerator === undefined || denominator === undefined
      || numerator <= 0n || denominator <= 0n) return null;
  const secondsPerTick = Number(numerator) / Number(denominator);
  if (!Number.isFinite(secondsPerTick) || secondsPerTick <= 0) return null;
  return {
    numerator: numerator.toString(10),
    denominator: denominator.toString(10),
    secondsPerTick,
  };
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  return sorted[Math.floor((sorted.length - 1) * quantile)];
}

function frameType(frame) {
  return frame?.headerSummary?.frameTypeName ?? (frame?.keyframe === true ? "KEY" : "UNKNOWN");
}

function keyframeState(frame, index) {
  const type = frameType(frame);
  if (frame?.keyframe === true) return { keyframe: true, source: "container", type };
  if (KEY_FRAME_TYPES.has(type)) return { keyframe: true, source: "frame-header", type };
  if (index === 0) return { keyframe: true, source: "assumed-first", type };
  return { keyframe: false, source: frame?.keyframe === false ? "container" : "unknown", type };
}

function requireLimit(value, fallback, name) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return normalized;
}

function safeRate(bytes, seconds) {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return null;
  const value = bytes * 8 / seconds;
  return Number.isFinite(value) ? value : null;
}

export function createFrameStatisticsAccumulator({
  container = null,
  totalFrameCount = null,
  maxPoints = DEFAULT_MAX_POINTS,
  maxGops = DEFAULT_MAX_GOPS,
  maxAnomalies = DEFAULT_MAX_ANOMALIES,
} = {}) {
  maxPoints = requireLimit(maxPoints, DEFAULT_MAX_POINTS, "maxPoints");
  maxGops = requireLimit(maxGops, DEFAULT_MAX_GOPS, "maxGops");
  maxAnomalies = requireLimit(maxAnomalies, DEFAULT_MAX_ANOMALIES, "maxAnomalies");
  if (totalFrameCount !== null
      && (!Number.isSafeInteger(totalFrameCount) || totalFrameCount < 0)) {
    throw new RangeError("totalFrameCount must be null or a non-negative safe integer");
  }
  const timebase = normalizeFrameTimebase(container);
  const tickNumerator = timebase === null ? null : BigInt(timebase.numerator);
  const tickDenominator = timebase === null ? null : BigInt(timebase.denominator);
  const sizes = [];
  const samples = [];
  const pointBuckets = new Map();
  const directPoints = [];
  const gops = [];
  const gopLengths = [];
  const anomalies = [];
  const anomalyCounts = Object.create(null);
  let unknownFirstPoint = null;
  let unknownLastPoint = null;
  let unknownMinimumPoint = null;
  let unknownMaximumPoint = null;
  let anomalyCount = 0;
  let frameCount = 0;
  let totalBytes = 0;
  let totalDurationSeconds = 0;
  let timedFrameCount = 0;
  let explicitDurationCount = 0;
  let inferredDurationCount = 0;
  let defaultDurationCount = 0;
  let lastPositiveDuration = null;
  let pending = null;
  let currentGop = null;
  let gopCount = 0;
  let finished = null;
  let peakFrameBitrate = null;
  let peakFrameId = null;

  const recordAnomaly = (code, frameId, message) => {
    anomalyCount += 1;
    anomalyCounts[code] = (anomalyCounts[code] ?? 0) + 1;
    if (anomalies.length < maxAnomalies) anomalies.push({ code, frameId, message });
  };

  const pointBucket = (point, index) => {
    if (totalFrameCount === null || totalFrameCount === 0) {
      unknownFirstPoint ??= point;
      unknownLastPoint = point;
      if (unknownMinimumPoint === null || point.sizeBytes < unknownMinimumPoint.sizeBytes) {
        unknownMinimumPoint = point;
      }
      if (unknownMaximumPoint === null || point.sizeBytes > unknownMaximumPoint.sizeBytes) {
        unknownMaximumPoint = point;
      }
      if (directPoints.length < maxPoints) directPoints.push(point);
      else if (maxPoints === 1) directPoints[0] = point;
      else directPoints[1 + (index % (maxPoints - 1))] = point;
      return;
    }
    if (totalFrameCount !== null && totalFrameCount > 0 && totalFrameCount <= maxPoints) {
      directPoints.push(point);
      return;
    }
    const bucketIndex = Math.min(
      maxPoints - 1,
      Math.floor(index * maxPoints / Math.max(1, totalFrameCount)),
    );
    const bucket = pointBuckets.get(bucketIndex) ?? {
      first: point, last: point, minimum: point, maximum: point,
    };
    bucket.last = point;
    if (point.sizeBytes < bucket.minimum.sizeBytes) bucket.minimum = point;
    if (point.sizeBytes > bucket.maximum.sizeBytes) bucket.maximum = point;
    pointBuckets.set(bucketIndex, bucket);
  };

  const closeGop = () => {
    if (currentGop === null) return;
    currentGop.averageBitrateBitsPerSecond = safeRate(
      currentGop.sizeBytes, currentGop.durationSeconds,
    );
    gopLengths.push(currentGop.length);
    if (gops.length < maxGops) gops.push(currentGop);
    gopCount += 1;
    currentGop = null;
  };

  const ticksToSeconds = (ticks) => {
    if (ticks === null || tickNumerator === null) return null;
    const seconds = Number(ticks * tickNumerator) / Number(tickDenominator);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  };

  const finalizePending = (nextClock) => {
    if (pending === null) return;
    if (pending.clock !== null && nextClock !== null && nextClock <= pending.clock) {
      recordAnomaly(
        "FRAME_CLOCK_NON_MONOTONIC", pending.frameId,
        `Decode clock did not advance after frame ${pending.frameId}`,
      );
    }
    let duration = pending.explicitDuration;
    let durationSource = "explicit";
    if (duration === null || duration <= 0n) {
      if (pending.explicitDuration !== null) {
        recordAnomaly(
          "FRAME_DURATION_NON_POSITIVE", pending.frameId,
          `Frame duration ${pending.explicitDuration} is not positive`,
        );
      }
      const difference = pending.clock !== null && nextClock !== null
        ? nextClock - pending.clock : null;
      if (difference !== null && difference > 0n) {
        duration = difference;
        durationSource = "timestamp-delta";
      } else if (lastPositiveDuration !== null) {
        duration = lastPositiveDuration;
        durationSource = "previous-delta";
      } else {
        duration = 1n;
        durationSource = "default-tick";
        recordAnomaly(
          "FRAME_DURATION_DEFAULTED", pending.frameId,
          "No positive packet duration or adjacent timestamp delta was available",
        );
      }
    }
    if (duration > 0n) lastPositiveDuration = duration;
    if (durationSource === "explicit") explicitDurationCount += 1;
    else if (durationSource === "default-tick") defaultDurationCount += 1;
    else inferredDurationCount += 1;
    const durationSeconds = ticksToSeconds(duration);
    const bitrate = safeRate(pending.sizeBytes, durationSeconds);
    if (durationSeconds !== null) {
      totalDurationSeconds += durationSeconds;
      timedFrameCount += 1;
      samples.push({ bytes: pending.sizeBytes, durationSeconds });
      pending.gop.durationSeconds += durationSeconds;
    }
    if (bitrate !== null && (peakFrameBitrate === null || bitrate > peakFrameBitrate)) {
      peakFrameBitrate = bitrate;
      peakFrameId = pending.frameId;
    }
    const point = {
      frameId: pending.frameId,
      decodeIndex: pending.decodeIndex,
      timestamp: pending.timestamp,
      pts: pending.pts,
      dts: pending.dts,
      durationTicks: duration.toString(10),
      durationSeconds,
      durationSource,
      sizeBytes: pending.sizeBytes,
      bitrateBitsPerSecond: bitrate,
      keyframe: pending.keyframe,
      keyframeSource: pending.keyframeSource,
      frameType: pending.type,
      gopIndex: pending.gop.index,
      gopFrameIndex: pending.gopFrameIndex,
    };
    pointBucket(point, pending.index);
    pending = null;
  };

  const add = (frame) => {
    if (finished !== null) throw new Error("frame statistics accumulator is already finished");
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      throw new TypeError("frame statistics requires frame objects");
    }
    const sizeBytes = frame.declaredSize;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new RangeError("frame declaredSize must be a non-negative safe integer");
    }
    const index = frameCount;
    const frameId = Number.isSafeInteger(frame.frameId) ? frame.frameId : index;
    if (frameId !== index) recordAnomaly(
      "FRAME_ID_DISCONTINUITY", frameId,
      `Expected frameId ${index}, received ${frameId}`,
    );
    const pts = integerText(frame.pts ?? frame.timestamp);
    const dts = integerText(frame.dts);
    const clock = integerTicks(frame.dts ?? frame.timestamp);
    const explicitDuration = integerTicks(frame.duration);
    finalizePending(clock);
    const key = keyframeState(frame, index);
    if (currentGop !== null && key.keyframe) closeGop();
    if (currentGop === null) {
      currentGop = {
        index: gopCount,
        startFrameId: frameId,
        endFrameId: frameId,
        length: 0,
        sizeBytes: 0,
        durationSeconds: 0,
        averageBitrateBitsPerSecond: null,
        startsWithKeyframe: key.keyframe,
        keyframeSource: key.source,
        frameType: key.type,
      };
    }
    const gopFrameIndex = currentGop.length;
    currentGop.endFrameId = frameId;
    currentGop.length += 1;
    currentGop.sizeBytes += sizeBytes;
    sizes.push(sizeBytes);
    totalBytes += sizeBytes;
    pending = {
      index, frameId,
      decodeIndex: Number.isSafeInteger(frame.decodeIndex) ? frame.decodeIndex : index,
      timestamp: integerText(frame.timestamp), pts, dts, clock, explicitDuration,
      sizeBytes, keyframe: key.keyframe, keyframeSource: key.source, type: key.type,
      gop: currentGop, gopFrameIndex,
    };
    frameCount += 1;
  };

  const finish = () => {
    if (finished !== null) return finished;
    finalizePending(null);
    closeGop();
    const sortedSizes = [...sizes].sort((left, right) => left - right);
    let rollingStart = 0;
    let rollingBytes = 0;
    let rollingSeconds = 0;
    let peakRollingBitrate = null;
    const rollingTargetSeconds = Math.min(1, totalDurationSeconds);
    for (let end = 0; end < samples.length; end += 1) {
      rollingBytes += samples[end].bytes;
      rollingSeconds += samples[end].durationSeconds;
      while (rollingStart < end
          && rollingSeconds - samples[rollingStart].durationSeconds >= rollingTargetSeconds) {
        rollingBytes -= samples[rollingStart].bytes;
        rollingSeconds -= samples[rollingStart].durationSeconds;
        rollingStart += 1;
      }
      if (rollingTargetSeconds > 0 && rollingSeconds >= rollingTargetSeconds * 0.9) {
        const rate = safeRate(rollingBytes, rollingSeconds);
        if (rate !== null && (peakRollingBitrate === null || rate > peakRollingBitrate)) {
          peakRollingBitrate = rate;
        }
      }
    }
    const sampledPoints = directPoints.length > 0
      ? [
        ...directPoints,
        unknownFirstPoint, unknownMinimumPoint, unknownMaximumPoint, unknownLastPoint,
      ].filter(Boolean)
      : [...pointBuckets.values()]
        .flatMap(({ first, minimum, maximum, last }) => [first, minimum, maximum, last]);
    const points = [...new Map(sampledPoints.map((point) => [point.frameId, point])).values()]
      .sort((left, right) => left.frameId - right.frameId);
    const averageSize = frameCount === 0 ? null : totalBytes / frameCount;
    const averageGopLength = gopCount === 0
      ? null : gopLengths.reduce((sum, value) => sum + value, 0) / gopCount;
    const timingMode = timebase === null || timedFrameCount === 0 ? "unavailable"
      : defaultDurationCount > 0 ? "partially-defaulted"
        : inferredDurationCount > 0 ? "inferred" : "explicit";
    finished = {
      schemaVersion: FRAME_STATISTICS_SCHEMA_VERSION,
      timebase,
      timingMode,
      frameCount,
      timedFrameCount,
      totalBytes,
      durationSeconds: timedFrameCount === 0 ? null : totalDurationSeconds,
      averageFrameRate: timedFrameCount === 0 ? null : timedFrameCount / totalDurationSeconds,
      averageBitrateBitsPerSecond: safeRate(totalBytes, totalDurationSeconds),
      peakFrameBitrateBitsPerSecond: peakFrameBitrate,
      peakFrameId,
      peakRollingBitrateBitsPerSecond: peakRollingBitrate,
      rollingWindowSeconds: rollingTargetSeconds > 0 ? rollingTargetSeconds : null,
      durationSources: {
        explicit: explicitDurationCount,
        inferred: inferredDurationCount,
        defaulted: defaultDurationCount,
      },
      frameSizeBytes: {
        minimum: sortedSizes[0] ?? null,
        maximum: sortedSizes.at(-1) ?? null,
        average: averageSize,
        p50: percentile(sortedSizes, 0.5),
        p95: percentile(sortedSizes, 0.95),
      },
      gop: {
        count: gopCount,
        minimumLength: gopLengths.length === 0
          ? null : gopLengths.reduce((minimum, value) => Math.min(minimum, value), Infinity),
        maximumLength: gopLengths.length === 0
          ? null : gopLengths.reduce((maximum, value) => Math.max(maximum, value), -Infinity),
        averageLength: averageGopLength,
        records: gops,
        recordsTruncated: Math.max(0, gopCount - gops.length),
      },
      points,
      pointsDownsampled: points.length < frameCount,
      anomalies,
      anomalyCount,
      anomalyCounts: { ...anomalyCounts },
      anomaliesTruncated: Math.max(0, anomalyCount - anomalies.length),
    };
    return finished;
  };

  return { add, finish };
}

export function analyzeFrameStatistics(frames, container, options = {}) {
  if (!Array.isArray(frames)) throw new TypeError("frames must be an array");
  const accumulator = createFrameStatisticsAccumulator({
    container,
    totalFrameCount: frames.length,
    ...options,
  });
  for (const frame of frames) accumulator.add(frame);
  return accumulator.finish();
}
