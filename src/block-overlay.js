const MODES = new Set(["intra", "inter", "skip", "unknown"]);
const PARTITIONS = new Set([
  "none", "split", "horz", "vert", "horz_a", "horz_b", "vert_a", "vert_b",
  "horz_4", "vert_4", "unknown",
]);
const MAX_BLOCK_RECORDS = 1_000_000;

function optionalInteger(value, { minimum, maximum, label }) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside ${minimum}..${maximum}`);
  }
  return value;
}

function optionalText(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 64) throw new Error(`${label} must be a short string`);
  return value;
}

function normalizeMotionVectors(value, label) {
  if (value === undefined || value === null) return [];
  const vectors = Array.isArray(value) ? value : [value];
  if (vectors.length > 2) throw new Error(`${label} has more than two motion vectors`);
  return vectors.map((vector, index) => {
    if (!vector || !Number.isInteger(vector.x) || !Number.isInteger(vector.y) ||
        Math.abs(vector.x) > 131071 || Math.abs(vector.y) > 131071) {
      throw new Error(`${label}[${index}] has invalid x/y components`);
    }
    return {
      x: vector.x,
      y: vector.y,
      precision: optionalText(vector.precision, `${label}[${index}].precision`),
    };
  });
}

export function validateBlockOverlayDocument(document, report) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new TypeError("block overlay must be a JSON object");
  }
  if (document.schemaVersion !== 1 && document.schemaVersion !== 2) {
    throw new Error("unsupported block overlay schemaVersion");
  }
  if (!Array.isArray(document.frames)) throw new Error("block overlay frames must be an array");
  const reportFrames = new Map(report.frames.map((frame) => [frame.frameId, frame]));
  const normalizedFrames = [];
  for (const item of document.frames) {
    if (!Number.isInteger(item.frameId) || !reportFrames.has(item.frameId)) {
      throw new Error(`block overlay references unknown frameId ${item.frameId}`);
    }
    const frame = reportFrames.get(item.frameId);
    const width = frame.headerSummary?.frameWidth ?? report.container?.width;
    const height = frame.headerSummary?.frameHeight ?? report.container?.height;
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error(`frame ${item.frameId} has no dimensions for overlay validation`);
    }
    if (!Array.isArray(item.blocks)) throw new Error(`frame ${item.frameId} blocks must be an array`);
    if (item.blocks.length > MAX_BLOCK_RECORDS) throw new Error(`frame ${item.frameId} exceeds the ${MAX_BLOCK_RECORDS}-block limit`);
    const blocks = item.blocks.map((block, index) => {
      for (const key of ["x", "y", "width", "height"]) {
        if (!Number.isInteger(block[key])) throw new Error(`frame ${item.frameId} block ${index} ${key} must be an integer`);
      }
      if (block.x < 0 || block.y < 0 || block.width <= 0 || block.height <= 0 ||
          block.x + block.width > width || block.y + block.height > height) {
        throw new Error(`frame ${item.frameId} block ${index} is outside ${width}x${height}`);
      }
      const mode = MODES.has(block.mode) ? block.mode : "unknown";
      const partition = PARTITIONS.has(block.partition) ? block.partition : "unknown";
      const qindex = block.qindex === undefined ? null : block.qindex;
      if (qindex !== null && (!Number.isInteger(qindex) || qindex < 0 || qindex > 255)) {
        throw new Error(`frame ${item.frameId} block ${index} qindex is outside 0..255`);
      }
      const refs = block.refs === undefined || block.refs === null ? [] : block.refs;
      if (!Array.isArray(refs) || refs.length > 2 || refs.some((value) => !Number.isInteger(value) || value < 0 || value > 7)) {
        throw new Error(`frame ${item.frameId} block ${index} refs must contain at most two slots in 0..7`);
      }
      const hasV2Details = ["miRow", "miColumn", "compoundType", "quantDelta"]
        .some((key) => Object.hasOwn(block, key));
      return {
        blockId: index,
        plane: optionalInteger(block.plane, { minimum: 0, maximum: 2, label: `frame ${item.frameId} block ${index} plane` }) ?? 0,
        x: block.x,
        y: block.y,
        width: block.width,
        height: block.height,
        partition,
        segmentId: optionalInteger(block.segmentId, { minimum: 0, maximum: 7, label: `frame ${item.frameId} block ${index} segmentId` }),
        skip: block.skip === undefined ? mode === "skip" : Boolean(block.skip),
        mode,
        intraMode: optionalText(block.intraMode, `frame ${item.frameId} block ${index} intraMode`),
        interMode: optionalText(block.interMode, `frame ${item.frameId} block ${index} interMode`),
        refs: [...refs],
        qindex,
        mv: normalizeMotionVectors(block.mv, `frame ${item.frameId} block ${index} mv`),
        txSize: optionalText(block.txSize, `frame ${item.frameId} block ${index} txSize`),
        txType: optionalText(block.txType, `frame ${item.frameId} block ${index} txType`),
        coeffNonZero: optionalInteger(block.coeffNonZero, { minimum: 0, maximum: 1_048_576, label: `frame ${item.frameId} block ${index} coeffNonZero` }),
        filter: optionalText(block.filter, `frame ${item.frameId} block ${index} filter`),
        ...(hasV2Details ? {
          miRow: optionalInteger(block.miRow, { minimum: 0, maximum: 268_435_455, label: `frame ${item.frameId} block ${index} miRow` }),
          miColumn: optionalInteger(block.miColumn, { minimum: 0, maximum: 268_435_455, label: `frame ${item.frameId} block ${index} miColumn` }),
          compoundType: optionalText(block.compoundType, `frame ${item.frameId} block ${index} compoundType`),
          quantDelta: optionalInteger(block.quantDelta, { minimum: -255, maximum: 255, label: `frame ${item.frameId} block ${index} quantDelta` }),
        } : {}),
      };
    });
    normalizedFrames.push({ frameId: item.frameId, blocks });
  }
  return { schemaVersion: document.schemaVersion, provenance: document.provenance ?? { producer: "external" }, frames: normalizedFrames };
}
