function addUnique(map, ambiguous, key, value) {
  if (!key || typeof value !== "number" || !Number.isFinite(value) || ambiguous.has(key)) return;
  if (map.has(key)) {
    map.delete(key);
    ambiguous.add(key);
  } else {
    map.set(key, value);
  }
}

export function buildNativeTraceFieldMap(nodes) {
  const fields = new Map();
  const ambiguous = new Set();
  for (const { path, value } of nodes) {
    if (!path.startsWith("frame_header.")) continue;
    const leaf = path.split(".").at(-1);
    addUnique(fields, ambiguous, leaf, value);
    const globalMotion = path.match(/\.gm_params\[(\d+)\]\[(\d+)\]\.subexp_code$/);
    if (globalMotion) addUnique(fields, ambiguous, `gm_params[${globalMotion[1]}][${globalMotion[2]}]`, value);
    const segment = path.match(/\.segment\[(\d+)\]\.([a-z0-9_]+)\.(feature_enabled|feature_value)$/);
    if (segment) {
      const featureNames = ["alt_q", "alt_lf_y_v", "alt_lf_y_h", "alt_lf_u", "alt_lf_v", "ref_frame", "skip", "globalmv"];
      const feature = featureNames.indexOf(segment[2]);
      if (feature >= 0) addUnique(fields, ambiguous, `${segment[3]}[${segment[1]}][${feature}]`, value);
    }
  }
  return fields;
}

export function compareTraceEntry(fields, entry) {
  const nativeValue = fields.get(entry.name);
  if (nativeValue === undefined) return { comparable: false, match: false, nativeValue: null };
  return { comparable: true, match: nativeValue === entry.value, nativeValue };
}
