import { summarizeMotionVectors } from "./block-renderer.js";

export const BLOCK_COVERAGE_RECORD_LIMIT = 200_000;

function areaOf(block) {
  const area = Number(block.width) * Number(block.height);
  return Number.isFinite(area) && area > 0 ? area : 0;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function categoricalBlockDistribution(blocks, selector) {
  const records = new Map();
  let knownCount = 0;
  let knownArea = 0;
  let missingCount = 0;
  let missingArea = 0;
  for (const block of blocks) {
    const selected = selector(block);
    const values = Array.isArray(selected) ? selected : [selected];
    const present = values.filter((value) => value !== null && value !== undefined && value !== "");
    if (present.length === 0) {
      missingCount += 1;
      missingArea += areaOf(block);
      continue;
    }
    for (const value of present) {
      const label = String(value);
      const current = records.get(label) ?? { label, count: 0, area: 0 };
      current.count += 1;
      current.area += areaOf(block);
      records.set(label, current);
      knownCount += 1;
      knownArea += areaOf(block);
    }
  }
  const items = [...records.values()]
    .sort((left, right) => right.area - left.area || right.count - left.count || left.label.localeCompare(right.label))
    .map((item) => ({
      ...item,
      countRatio: knownCount === 0 ? null : item.count / knownCount,
      areaRatio: knownArea === 0 ? null : item.area / knownArea,
    }));
  return { items, knownCount, knownArea, missingCount, missingArea };
}

export function numericBlockSummary(blocks, selector) {
  const values = [];
  let missingCount = 0;
  let weightedSum = 0;
  let knownArea = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let zeroCount = 0;
  for (const block of blocks) {
    const value = selector(block);
    if (value === null || value === undefined || !Number.isFinite(value)) {
      missingCount += 1;
      continue;
    }
    values.push(value);
    const area = areaOf(block);
    weightedSum += value * area;
    knownArea += area;
    if (value > 0) positiveCount += 1;
    else if (value < 0) negativeCount += 1;
    else zeroCount += 1;
  }
  values.sort((left, right) => left - right);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    knownCount: values.length,
    missingCount,
    minimum: values[0] ?? null,
    maximum: values.at(-1) ?? null,
    mean: values.length === 0 ? null : sum / values.length,
    areaWeightedMean: knownArea === 0 ? null : weightedSum / knownArea,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    sum,
    positiveCount,
    negativeCount,
    zeroCount,
  };
}

export function buildQindexHistogram(blocks, binSize = 16) {
  const size = Number.isInteger(binSize) && binSize > 0 && binSize <= 256 ? binSize : 16;
  const bins = Array.from({ length: Math.ceil(256 / size) }, (_, index) => ({
    minimum: index * size,
    maximum: Math.min(255, (index + 1) * size - 1),
    count: 0,
    area: 0,
  }));
  let missingCount = 0;
  for (const block of blocks) {
    if (!Number.isInteger(block.qindex) || block.qindex < 0 || block.qindex > 255) {
      missingCount += 1;
      continue;
    }
    const bin = bins[Math.floor(block.qindex / size)];
    bin.count += 1;
    bin.area += areaOf(block);
  }
  const knownArea = bins.reduce((sum, bin) => sum + bin.area, 0);
  return {
    bins: bins.map((bin) => ({
      ...bin,
      areaRatio: knownArea === 0 ? null : bin.area / knownArea,
    })),
    knownCount: bins.reduce((sum, bin) => sum + bin.count, 0),
    missingCount,
    knownArea,
  };
}

function validRectangle(block) {
  return Number.isFinite(block.x) && Number.isFinite(block.y) &&
    Number.isFinite(block.width) && Number.isFinite(block.height) &&
    block.width > 0 && block.height > 0;
}

export function calculateRectangleCoverage(blocks, {
  frameWidth = null,
  frameHeight = null,
  recordLimit = BLOCK_COVERAGE_RECORD_LIMIT,
} = {}) {
  const rectangles = blocks.filter(validRectangle);
  const invalidRecordCount = blocks.length - rectangles.length;
  const sumArea = rectangles.reduce((sum, block) => sum + areaOf(block), 0);
  const frameArea = Number.isFinite(frameWidth) && frameWidth > 0 &&
    Number.isFinite(frameHeight) && frameHeight > 0 ? frameWidth * frameHeight : null;
  if (rectangles.length > recordLimit) {
    return {
      status: "record-budget-exceeded",
      recordCount: rectangles.length,
      invalidRecordCount,
      recordLimit,
      frameArea,
      sumArea,
      coveredArea: null,
      overlapArea: null,
      duplicateArea: null,
      coverageRatio: null,
    };
  }
  if (rectangles.length === 0) {
    return {
      status: "exact",
      recordCount: 0,
      invalidRecordCount,
      recordLimit,
      frameArea,
      sumArea: 0,
      coveredArea: 0,
      overlapArea: 0,
      duplicateArea: 0,
      coverageRatio: frameArea === null ? null : 0,
    };
  }

  const coordinates = [...new Set(rectangles.flatMap((block) => [block.x, block.x + block.width]))]
    .sort((left, right) => left - right);
  const coordinateIndex = new Map(coordinates.map((value, index) => [value, index]));
  const events = rectangles.flatMap((block) => [
    { y: block.y, left: coordinateIndex.get(block.x), right: coordinateIndex.get(block.x + block.width), delta: 1 },
    { y: block.y + block.height, left: coordinateIndex.get(block.x), right: coordinateIndex.get(block.x + block.width), delta: -1 },
  ]).sort((left, right) => left.y - right.y || right.delta - left.delta);
  const segmentCount = coordinates.length - 1;
  const treeSize = Math.max(4, segmentCount * 4 + 8);
  const cover = new Int32Array(treeSize);
  const coveredLength = new Float64Array(treeSize);
  const overlapLength = new Float64Array(treeSize);

  const pull = (node, left, right) => {
    const span = coordinates[right + 1] - coordinates[left];
    if (cover[node] >= 2) {
      coveredLength[node] = span;
      overlapLength[node] = span;
    } else if (left === right) {
      coveredLength[node] = cover[node] === 1 ? span : 0;
      overlapLength[node] = 0;
    } else {
      const childCovered = coveredLength[node * 2] + coveredLength[node * 2 + 1];
      coveredLength[node] = cover[node] === 1 ? span : childCovered;
      overlapLength[node] = cover[node] === 1
        ? childCovered
        : overlapLength[node * 2] + overlapLength[node * 2 + 1];
    }
  };
  const update = (node, left, right, updateLeft, updateRight, delta) => {
    if (updateLeft <= left && right <= updateRight) {
      cover[node] += delta;
      pull(node, left, right);
      return;
    }
    const middle = Math.floor((left + right) / 2);
    if (updateLeft <= middle) update(node * 2, left, middle, updateLeft, updateRight, delta);
    if (updateRight > middle) update(node * 2 + 1, middle + 1, right, updateLeft, updateRight, delta);
    pull(node, left, right);
  };

  let coveredArea = 0;
  let overlapArea = 0;
  let previousY = events[0].y;
  for (let index = 0; index < events.length;) {
    const y = events[index].y;
    const height = y - previousY;
    coveredArea += coveredLength[1] * height;
    overlapArea += overlapLength[1] * height;
    while (index < events.length && events[index].y === y) {
      const event = events[index];
      if (event.left < event.right) update(1, 0, segmentCount - 1, event.left, event.right - 1, event.delta);
      index += 1;
    }
    previousY = y;
  }
  return {
    status: "exact",
    recordCount: rectangles.length,
    invalidRecordCount,
    recordLimit,
    frameArea,
    sumArea,
    coveredArea,
    overlapArea,
    duplicateArea: sumArea - coveredArea,
    coverageRatio: frameArea === null ? null : coveredArea / frameArea,
  };
}

export function filterBlockRecords(blocks, filter = "all") {
  return blocks.filter((block) => {
    const luma = (block.plane ?? 0) === 0;
    if (filter === "all-planes") return true;
    if (!luma) return false;
    if (filter === "intra") return block.mode === "intra";
    if (filter === "inter") return block.mode === "inter";
    if (filter === "skip") return Boolean(block.skip) || block.mode === "skip";
    if (filter === "compound") return (block.refs?.length ?? 0) > 1 ||
      (block.mv?.length ?? 0) > 1 || (block.compoundType !== null && block.compoundType !== undefined);
    if (filter === "motion") return (block.mv?.length ?? 0) > 0;
    if (filter === "coeff") return Number.isFinite(block.coeffNonZero) && block.coeffNonZero > 0;
    return true;
  });
}

export function summarizeBlockStatistics(blocks, { frameWidth = null, frameHeight = null } = {}) {
  const lumaBlocks = blocks.filter((block) => (block.plane ?? 0) === 0);
  const interBlocks = lumaBlocks.filter((block) => block.mode === "inter");
  const intraBlocks = lumaBlocks.filter((block) => block.mode === "intra");
  const qindex = numericBlockSummary(lumaBlocks, (block) => block.qindex);
  const quantDelta = numericBlockSummary(lumaBlocks, (block) => block.quantDelta);
  const coefficients = numericBlockSummary(lumaBlocks, (block) => block.coeffNonZero);
  return {
    recordCount: blocks.length,
    lumaRecordCount: lumaBlocks.length,
    nonLumaRecordCount: blocks.length - lumaBlocks.length,
    lumaRecordArea: lumaBlocks.reduce((sum, block) => sum + areaOf(block), 0),
    coverage: calculateRectangleCoverage(lumaBlocks, { frameWidth, frameHeight }),
    distributions: {
      mode: categoricalBlockDistribution(lumaBlocks, (block) => block.mode),
      partition: categoricalBlockDistribution(lumaBlocks, (block) => block.partition),
      blockSize: categoricalBlockDistribution(lumaBlocks, (block) => `${block.width}×${block.height}`),
      segment: categoricalBlockDistribution(lumaBlocks, (block) => block.segmentId),
      transformSize: categoricalBlockDistribution(lumaBlocks, (block) => block.txSize),
      intraMode: categoricalBlockDistribution(intraBlocks, (block) => block.intraMode),
      interMode: categoricalBlockDistribution(interBlocks, (block) => block.interMode),
      referenceSlot: categoricalBlockDistribution(interBlocks, (block) => block.refs),
      compoundType: categoricalBlockDistribution(interBlocks, (block) => block.compoundType),
      filter: categoricalBlockDistribution(lumaBlocks, (block) => block.filter),
    },
    qindex,
    qindexHistogram: buildQindexHistogram(lumaBlocks),
    quantDelta,
    coefficients,
    skipCount: lumaBlocks.filter((block) => Boolean(block.skip) || block.mode === "skip").length,
    motion: summarizeMotionVectors(lumaBlocks),
    filterCounts: Object.fromEntries(
      ["all", "intra", "inter", "skip", "compound", "motion", "coeff", "all-planes"]
        .map((filter) => [filter, filterBlockRecords(blocks, filter).length]),
    ),
  };
}
