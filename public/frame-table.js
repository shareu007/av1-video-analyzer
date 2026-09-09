import { csvRow } from "./csv.js";

export const FRAME_TABLE_PAGE_SIZE = 100;

export const DEFAULT_FRAME_TABLE_FILTERS = Object.freeze({
  frameIdMin: "",
  frameIdMax: "",
  frameType: "all",
  gopIndex: "",
  diagnostic: "all",
  qindexMin: "",
  qindexMax: "",
  sizeMin: "",
  sizeMax: "",
  bitrateMin: "",
  bitrateMax: "",
});

const NUMERIC_SORT_KEYS = new Set([
  "frameId", "decodeIndex", "durationSeconds", "sizeBytes",
  "bitrateBitsPerSecond", "qindex", "gopIndex", "diagnosticCount",
]);
const INTEGER_STRING_SORT_KEYS = new Set(["pts", "dts"]);

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueReferences(summary) {
  return [...new Set(
    (summary.referenceFrameIds ?? []).filter((value) => value !== null && value !== undefined),
  )];
}

export function buildFrameTableRows(frames, frameStatistics = null, diagnostics = []) {
  const points = new Map(
    (frameStatistics?.points ?? []).map((point) => [point.frameId, point]),
  );
  const diagnosticCounts = new Map();
  for (const diagnostic of diagnostics) {
    if (diagnostic.frameId === null || diagnostic.frameId === undefined) continue;
    diagnosticCounts.set(
      diagnostic.frameId,
      (diagnosticCounts.get(diagnostic.frameId) ?? 0) + 1,
    );
  }
  return frames.map((frame) => {
    const point = points.get(frame.frameId) ?? null;
    const summary = frame.headerSummary ?? {};
    const diagnosticCount = diagnosticCounts.get(frame.frameId) ?? 0;
    return {
      frameId: frame.frameId,
      decodeIndex: frame.decodeIndex,
      frameType: summary.frameTypeName ?? point?.frameType ?? "UNKNOWN",
      pts: frame.pts ?? frame.timestamp ?? null,
      dts: frame.dts ?? null,
      durationTicks: point?.durationTicks ?? null,
      durationSeconds: point?.durationSeconds ?? null,
      durationSource: point?.durationSource ?? null,
      sizeBytes: frame.declaredSize ?? point?.sizeBytes ?? null,
      bitrateBitsPerSecond: point?.bitrateBitsPerSecond ?? null,
      keyframe: point?.keyframe ?? ["KEY", "KEY_FRAME", "INTRA_ONLY"].includes(summary.frameTypeName),
      gopIndex: point?.gopIndex ?? null,
      gopFrameIndex: point?.gopFrameIndex ?? null,
      qindex: summary.baseQIdx ?? null,
      references: uniqueReferences(summary),
      obuCount: frame.obuIds?.length ?? 0,
      diagnosticCount,
      hasDiagnostic: diagnosticCount > 0,
    };
  });
}

function matchesRange(value, minimum, maximum) {
  const numericValue = finiteNumber(value);
  const numericMinimum = finiteNumber(minimum);
  const numericMaximum = finiteNumber(maximum);
  if (numericMinimum !== null && (numericValue === null || numericValue < numericMinimum)) return false;
  if (numericMaximum !== null && (numericValue === null || numericValue > numericMaximum)) return false;
  return true;
}

export function filterFrameTableRows(rows, filters = DEFAULT_FRAME_TABLE_FILTERS) {
  const frameType = filters.frameType ?? "all";
  const diagnostic = filters.diagnostic ?? "all";
  return rows.filter((row) => {
    if (!matchesRange(row.frameId, filters.frameIdMin, filters.frameIdMax)) return false;
    if (frameType !== "all" && row.frameType !== frameType) return false;
    if (filters.gopIndex !== "" && filters.gopIndex !== null && filters.gopIndex !== undefined &&
        finiteNumber(row.gopIndex) !== finiteNumber(filters.gopIndex)) return false;
    if (diagnostic === "with" && !row.hasDiagnostic) return false;
    if (diagnostic === "without" && row.hasDiagnostic) return false;
    if (!matchesRange(row.qindex, filters.qindexMin, filters.qindexMax)) return false;
    if (!matchesRange(row.sizeBytes, filters.sizeMin, filters.sizeMax)) return false;
    if (!matchesRange(row.bitrateBitsPerSecond, filters.bitrateMin, filters.bitrateMax)) return false;
    return true;
  });
}

function comparePresentValues(left, right, key) {
  if (INTEGER_STRING_SORT_KEYS.has(key) && /^-?\d+$/.test(String(left)) && /^-?\d+$/.test(String(right))) {
    const leftInteger = BigInt(left);
    const rightInteger = BigInt(right);
    return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
  }
  if (NUMERIC_SORT_KEYS.has(key)) return Number(left) - Number(right);
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

export function sortFrameTableRows(rows, { key = "frameId", direction = "ascending" } = {}) {
  const multiplier = direction === "descending" ? -1 : 1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftValue = left.row[key];
    const rightValue = right.row[key];
    const leftMissing = leftValue === null || leftValue === undefined || leftValue === "";
    const rightMissing = rightValue === null || rightValue === undefined || rightValue === "";
    if (leftMissing || rightMissing) {
      if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    } else {
      const comparison = comparePresentValues(leftValue, rightValue, key);
      if (comparison !== 0) return comparison * multiplier;
    }
    return left.index - right.index;
  }).map(({ row }) => row);
}

export function pageFrameTableRows(rows, { page = 0, pageSize = FRAME_TABLE_PAGE_SIZE } = {}) {
  const boundedPageSize = Math.max(1, Math.floor(finiteNumber(pageSize) ?? FRAME_TABLE_PAGE_SIZE));
  const pageCount = Math.max(1, Math.ceil(rows.length / boundedPageSize));
  const boundedPage = Math.min(Math.max(0, Math.floor(finiteNumber(page) ?? 0)), pageCount - 1);
  const start = boundedPage * boundedPageSize;
  const end = Math.min(rows.length, start + boundedPageSize);
  return {
    rows: rows.slice(start, end),
    total: rows.length,
    page: boundedPage,
    pageCount,
    pageSize: boundedPageSize,
    start,
    end,
  };
}

export function frameTableCsvRows(rows) {
  const output = [csvRow([
    "frame_id", "decode_index", "frame_type", "pts", "dts", "duration_ticks",
    "duration_seconds", "duration_source", "size_bytes", "frame_bitrate_bps",
    "keyframe", "gop_index", "gop_frame_index", "base_q_idx", "reference_frames",
    "obu_count", "diagnostic_count",
  ])];
  for (const row of rows) {
    output.push(csvRow([
      row.frameId,
      row.decodeIndex,
      row.frameType,
      row.pts,
      row.dts,
      row.durationTicks,
      row.durationSeconds,
      row.durationSource,
      row.sizeBytes,
      row.bitrateBitsPerSecond,
      row.keyframe,
      row.gopIndex,
      row.gopFrameIndex,
      row.qindex,
      row.references.join("|"),
      row.obuCount,
      row.diagnosticCount,
    ]));
  }
  return output;
}
