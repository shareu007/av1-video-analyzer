import { analyzeFrameStatistics } from "./frame-statistics.js";

export const SCHEMA_VERSION = 1;
export const PARSER_NAME = "av1scope-structural-parser";
export const PARSER_VERSION = "0.1.0";
export const IMPLEMENTATION = "av1scope-m0-node-reference";

export const InputFormat = Object.freeze({
  IVF: "ivf",
  ISOBMFF: "isobmff",
  MATROSKA: "matroska_webm",
  LOW_OVERHEAD_OBU: "low_overhead_obu",
});

export const Severity = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
  FATAL: "fatal",
});

const OBU_TYPE_NAMES = Object.freeze({
  0: "reserved",
  1: "sequence_header",
  2: "temporal_delimiter",
  3: "frame_header",
  4: "tile_group",
  5: "metadata",
  6: "frame",
  7: "redundant_frame_header",
  8: "tile_list",
  15: "padding",
});

export function obuType(code) {
  return {
    code,
    name: OBU_TYPE_NAMES[code] ?? "reserved",
  };
}

export function byteRange(start, length) {
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new RangeError(`invalid byte range start: ${start}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError(`invalid byte range length: ${length}`);
  }
  return { start, length };
}

export function diagnostic(
  code,
  severity,
  message,
  { range = null, frameId = null, obuId = null } = {},
) {
  return {
    schemaVersion: SCHEMA_VERSION,
    code,
    severity,
    message,
    byteRange: range,
    frameId,
    obuId,
  };
}

export function finalizeReport({
  source,
  container,
  frames,
  obus,
  syntaxNodes = [],
  diagnostics,
}) {
  const errorCount = diagnostics.filter(
    ({ severity }) => severity === Severity.ERROR || severity === Severity.FATAL,
  ).length;
  const warningCount = diagnostics.filter(
    ({ severity }) => severity === Severity.WARNING,
  ).length;

  return {
    schemaVersion: SCHEMA_VERSION,
    source,
    container,
    frames,
    obus,
    syntaxNodes,
    diagnostics,
    frameStatistics: analyzeFrameStatistics(frames, container),
    summary: {
      frameCount: frames.length,
      obuCount: obus.length,
      errorCount,
      warningCount,
      complete:
        errorCount === 0 &&
        frames.every(({ complete }) => complete) &&
        obus.every(({ complete }) => complete),
    },
    provenance: {
      parser: PARSER_NAME,
      parserVersion: PARSER_VERSION,
      implementation: IMPLEMENTATION,
    },
  };
}
