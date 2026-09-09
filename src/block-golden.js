export const BLOCK_GOLDEN_KIND = "av1scope-block-golden-suite";
export const BLOCK_GOLDEN_SCHEMA_VERSION = 1;
export const REQUIRED_BLOCK_GOLDEN_COVERAGE = Object.freeze([
  "compoundReference",
  "compoundType",
  "interMotion",
  "intraPartitions",
  "loopFilters",
  "miCoordinates",
  "quantDelta",
  "segmentationQindex",
  "transformCoefficients",
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const BUILD_ID = /^[0-9a-f]{40}$/u;

function relativeFile(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512
      || value.includes("\\") || value.startsWith("/")
      || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`${name} must be a normalized relative path`);
  }
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function validateBlockGoldenManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== BLOCK_GOLDEN_SCHEMA_VERSION
      || value.kind !== BLOCK_GOLDEN_KIND) {
    throw new TypeError("unsupported Block Golden manifest kind or schemaVersion");
  }
  if (typeof value.buildId !== "string" || !BUILD_ID.test(value.buildId)) {
    throw new TypeError("Block Golden buildId must be a lowercase 40-byte hex ID");
  }
  const coverage = Array.isArray(value.coverage)
    ? [...value.coverage].sort((left, right) => String(left).localeCompare(String(right)))
    : [];
  if (coverage.length !== REQUIRED_BLOCK_GOLDEN_COVERAGE.length
      || new Set(coverage).size !== coverage.length
      || coverage.some((item, index) => item !== REQUIRED_BLOCK_GOLDEN_COVERAGE[index])) {
    throw new TypeError("Block Golden coverage declaration is incomplete");
  }
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 64) {
    throw new TypeError("Block Golden manifest requires 1..64 cases");
  }
  const names = new Set();
  const cases = value.cases.map((item, caseIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(item.name)
        || names.has(item.name)) {
      throw new TypeError(`Block Golden case ${caseIndex} has an invalid or duplicate name`);
    }
    names.add(item.name);
    if (!Number.isSafeInteger(item.width) || item.width < 1 || item.width > 65_536
        || !Number.isSafeInteger(item.height) || item.height < 1 || item.height > 65_536
        || !Array.isArray(item.frames) || item.frames.length < 1 || item.frames.length > 10_000) {
      throw new TypeError(`Block Golden case ${item.name} has invalid dimensions or frames`);
    }
    const frames = item.frames.map((frame, frameId) => {
      const range = frame?.payloadRange;
      if (frame?.frameId !== frameId || !Number.isSafeInteger(range?.start) || range.start < 0
          || !Number.isSafeInteger(range?.length) || range.length < 1) {
        throw new TypeError(`Block Golden case ${item.name} frame ${frameId} is invalid`);
      }
      return { frameId, payloadRange: { start: range.start, length: range.length } };
    });
    return {
      name: item.name,
      sourceLicense: typeof item.sourceLicense === "string"
          && item.sourceLicense.length >= 1 && item.sourceLicense.length <= 128
        ? item.sourceLicense
        : (() => { throw new TypeError(`Block Golden case ${item.name} sourceLicense is invalid`); })(),
      inputFile: relativeFile(item.inputFile, `cases[${caseIndex}].inputFile`),
      inputSha256: digest(item.inputSha256, `cases[${caseIndex}].inputSha256`),
      expectedOverlayFile: relativeFile(
        item.expectedOverlayFile, `cases[${caseIndex}].expectedOverlayFile`,
      ),
      expectedOverlaySha256: digest(
        item.expectedOverlaySha256, `cases[${caseIndex}].expectedOverlaySha256`,
      ),
      width: item.width,
      height: item.height,
      frames,
    };
  });
  return {
    schemaVersion: BLOCK_GOLDEN_SCHEMA_VERSION,
    kind: BLOCK_GOLDEN_KIND,
    buildId: value.buildId,
    coverage,
    cases,
  };
}

export function assertBlockGoldenCoverage(overlays) {
  if (!Array.isArray(overlays) || overlays.length === 0) {
    throw new TypeError("Block Golden coverage requires decoded overlays");
  }
  const blocks = overlays.flatMap(({ frames = [] }) => frames.flatMap(({ blocks: values = [] }) => values));
  const missing = [];
  if (!blocks.some(({ mode, partition }) =>
    mode === "intra" && !["none", "unknown"].includes(partition))) {
    missing.push("intraPartitions");
  }
  if (!blocks.some(({ mode, mv }) => mode === "inter" && Array.isArray(mv) && mv.length > 0)) {
    missing.push("interMotion");
  }
  if (!blocks.some(({ mode, refs }) => mode === "inter" && Array.isArray(refs) && refs.length === 2)) {
    missing.push("compoundReference");
  }
  if (!blocks.some(({ mode, compoundType }) => mode === "inter"
      && compoundType !== null && compoundType !== undefined)) {
    missing.push("compoundType");
  }
  if (!blocks.some(({ miRow, miColumn }) => Number.isInteger(miRow) && Number.isInteger(miColumn))) {
    missing.push("miCoordinates");
  }
  if (!blocks.some(({ quantDelta }) => Number.isInteger(quantDelta) && quantDelta !== 0)) {
    missing.push("quantDelta");
  }
  if (!blocks.some(({ segmentId, qindex }) => segmentId !== null && segmentId !== undefined
      && qindex !== null && qindex !== undefined)
      || !blocks.some(({ qindex }) => qindex === 255)) {
    missing.push("segmentationQindex");
  }
  if (!blocks.some(({ txSize, txType, coeffNonZero }) => txSize !== null && txSize !== undefined
      && txType !== null && txType !== undefined
      && coeffNonZero !== null && coeffNonZero !== undefined)) {
    missing.push("transformCoefficients");
  }
  if (!blocks.some(({ filter }) => filter !== null && filter !== undefined)) {
    missing.push("loopFilters");
  }
  if (missing.length > 0) throw new Error(`Block Golden semantic coverage missing: ${missing.join(", ")}`);
  return { caseCount: overlays.length, blockCount: blocks.length };
}
