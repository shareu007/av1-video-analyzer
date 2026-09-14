import { motionVectorToPixels } from "./block-renderer.js";

// Fixed AV1 prediction-reference identifiers. These are not the eight physical
// DPB indices: the selected header maps each identifier to one of those slots.
export const REFERENCE_NAMES = Object.freeze(["LAST", "LAST2", "LAST3", "GOLDEN", "BWDREF", "ALTREF2", "ALTREF"]);

// AV1 named reference groups, not the source packet's position on the timeline.
export function referenceDirection(reference) {
  return !Number.isInteger(reference) || reference < 1 || reference > 7 ? null : reference <= 4 ? "forward" : "backward";
}

export function referenceUsageTone(bindings, usage) {
  const directions = new Set((bindings ?? []).filter((entry) => usage?.counts[entry.reference] > 0)
    .map((entry) => referenceDirection(entry.reference)).filter(Boolean));
  return directions.size > 1 ? "mixed" : [...directions][0] ?? null;
}

// A packet may hold both forward- and backward-group source pictures. Keep
// their arrows separate even when they terminate at the same timeline card.
export function referenceTimelineTargets(targets, referenceState, usage) {
  const display = Boolean(referenceState?.summary?.showExistingFrame);
  return targets.flatMap((target) => {
    const bindings = (referenceState?.bindings ?? []).filter((entry) => entry.frameId === target.frameId);
    const groups = display ? ["display"] : [...new Set(bindings.map((entry) => referenceDirection(entry.reference) ?? "unknown"))];
    if (!groups.length) groups.push("unknown");
    return groups.map((direction) => {
      const entries = display ? bindings : bindings.filter((entry) => (referenceDirection(entry.reference) ?? "unknown") === direction);
      return { ...target, direction, bindings: entries,
        used: display || entries.some((entry) => usage?.counts[entry.reference] > 0),
        verified: Boolean(usage && !usage.unknownBlocks && entries.length && entries.every((entry) => referenceDirection(entry.reference))),
      };
    });
  });
}

export function namedReferenceBindings(referenceState) {
  const summary = referenceState?.summary;
  const inactive = summary?.showExistingFrame || ["KEY_FRAME", "INTRA_ONLY_FRAME"].includes(summary?.frameTypeName);
  return REFERENCE_NAMES.map((name, index) => {
    const reference = index + 1;
    const binding = !inactive && referenceState?.bindings?.find((entry) => entry.reference === reference);
    const mapped = Number.isInteger(binding?.slot) && binding.slot >= 0 && binding.slot < 8;
    return { reference, name: `${name}_FRAME`, direction: referenceDirection(reference), slot: mapped ? binding.slot : null,
      picture: mapped ? binding.picture ?? null : null, frameId: mapped ? binding.frameId ?? null : null,
      status: inactive ? "not-applicable" : mapped ? "mapped" : "unavailable" };
  });
}

// Replay coded headers, including hidden pictures in a container packet. A
// picture is identified by its OBU, not just its container frame ID.
export function buildReferenceStateIndex(report) {
  return buildPictureStateIndex(report).frames;
}

export function buildPictureStateIndex(report) {
  const slots = Array(8).fill(null), states = new Map(), obus = new Map();
  let previewIndex = 0;
  const packetPictures = new Map();
  const headers = (report.obus ?? []).filter((obu) => (obu.frameHeaderSummary || [3, 6].includes(obu.type?.code)) && obu.type?.code !== 7);
  const events = headers.length ? headers : (report.frames ?? []).map((frame) => ({ frameId: frame.frameId, obuId: null, frameHeaderSummary: frame.headerSummary }));
  for (const obu of events) {
    const summary = obu.frameHeaderSummary;
    if (!summary) {
      slots.fill(null);
      // An unparsed coded header may or may not emit a displayed picture.
      // Subsequent output ordinals cannot safely be inferred from packet IDs.
      if (obu.obuId != null) previewIndex = null;
      const unknown = { frameId: obu.frameId, obuId: obu.obuId, summary: {}, before: slots.slice(), after: slots.slice(), bindings: [], picture: null };
      states.set(obu.frameId, unknown);
      if (obu.obuId != null) obus.set(obu.obuId, unknown);
      continue;
    }
    for (const slot of summary.invalidatedReferenceSlots ?? []) if (slot >= 0 && slot < 8) slots[slot] = null;
    const before = slots.slice();
    const ids = summary.referenceFrameIds ?? [], indices = summary.referenceSlotIndices ?? [];
    const bindings = indices.map((slot, index) => ({
      reference: summary.showExistingFrame ? null : indices.length === 7 ? index + 1 : null,
      slot, frameId: ids[index] ?? null,
      picture: before[slot]?.frameId === ids[index] ? before[slot] : null,
    }));
    if (!packetPictures.has(obu.frameId)) packetPictures.set(obu.frameId, []);
    const pictures = packetPictures.get(obu.frameId);
    const picture = summary.showExistingFrame ? before[summary.frameToShowMapIdx] ?? null
      : { frameId: obu.frameId, obuId: obu.obuId, summary, hidden: !summary.showFrame, previewFrameId: summary.showFrame ? obu.frameId : null, previewIndex: summary.showFrame ? previewIndex : null };
    if (picture && !summary.showExistingFrame) {
      if (picture.hidden) picture.hiddenIndex = pictures.filter((entry) => entry.hidden).length + 1;
      pictures.push(picture);
    }
    // A hidden picture may later become viewable via show_existing_frame.
    if (picture && summary.showExistingFrame && picture.previewFrameId == null) {
      picture.previewFrameId = obu.frameId;
      picture.previewIndex = previewIndex;
    }
    if (previewIndex !== null && (summary.showFrame || summary.showExistingFrame)) previewIndex++;
    if (Number.isInteger(summary.refreshFrameFlags)) {
      for (let slot = 0; slot < 8; slot++) if (summary.refreshFrameFlags & (1 << slot)) slots[slot] = picture;
    } else slots.fill(null); // Never claim stale state after an incomplete header.
    const state = { frameId: obu.frameId, obuId: obu.obuId, summary, before, after: slots.slice(), bindings, picture, packetPictures: pictures };
    if (obu.obuId != null) obus.set(obu.obuId, state);
    if (!states.has(obu.frameId) || summary.showFrame || summary.showExistingFrame) states.set(obu.frameId, state);
  }
  // Tile groups and redundant headers inspect the same picture, but never
  // inherit a header from a different packet or across a temporal delimiter.
  let current = null;
  for (const obu of report.obus ?? []) {
    if (current?.frameId !== obu.frameId || obu.type?.code === 2) current = null;
    if (obus.has(obu.obuId)) current = obus.get(obu.obuId);
    else if (current && [4, 7].includes(obu.type?.code)) obus.set(obu.obuId, current);
  }
  return { frames: states, obus };
}

export function pictureLabel(picture, { compact = false, frameId = null } = {}) {
  if (!picture) return frameId == null ? "Unresolved picture" : compact ? `F${frameId}·?` : `Frame ${frameId} · picture unresolved`;
  const hiddenName = picture.hiddenIndex != null ? `hidden picture ${picture.hiddenIndex}` : `hidden picture (header OBU ${picture.obuId ?? "?"})`;
  if (!compact) return `Frame ${picture.frameId} · ${picture.hidden ? hiddenName : "shown picture"}`;
  return `F${picture.frameId}·${picture.hidden ? picture.hiddenIndex != null ? `H${picture.hiddenIndex}` : `OBU${picture.obuId ?? "?"}` : "shown"}`;
}

export function currentPictureDescription(referenceState) {
  if (!referenceState?.picture) return "Current coded picture is unresolved.";
  const current = pictureLabel(referenceState.picture);
  if (referenceState.summary?.showExistingFrame) return `Frame ${referenceState.frameId} displays ${current} from the reference cache; no new picture is coded.`;
  const hiddenCount = referenceState.packetPictures?.filter((picture) => picture.hidden).length ?? 0;
  return `Viewing ${current}.${hiddenCount ? ` This packet ${referenceState.picture.hidden ? "contains" : "also contains"} ${hiddenCount} hidden reference picture${hiddenCount === 1 ? "" : "s"}.` : ""}`;
}

export function samePacketReference(picture, referenceState) {
  return Boolean(picture && referenceState?.picture && picture.frameId === referenceState.frameId
    && picture.obuId != null && referenceState.picture.obuId != null && picture.obuId !== referenceState.picture.obuId);
}

// Header reference choices need not all be used by blocks. Count each luma
// block once per reference, including both predictors for compound blocks.
export function referenceBlockUsage(blocks) {
  const luma = blocks?.filter((block) => (block.plane ?? 0) === 0) ?? [];
  if (!luma.length) return null;
  const counts = Array(8).fill(0);
  let unknownBlocks = 0, interBlocks = 0;
  for (const block of luma) {
    if (block.intraMode != null || block.mode === "intra") continue;
    if (block.interMode == null && block.mode !== "inter") { unknownBlocks++; continue; }
    interBlocks++;
    const signalled = [...new Set(block.refs ?? [])];
    const refs = signalled.filter((ref) => Number.isInteger(ref) && ref >= 1 && ref <= 7);
    if (!refs.length || refs.length !== signalled.length) unknownBlocks++;
    for (const ref of refs) counts[ref]++;
  }
  return { counts, totalBlocks: luma.length, interBlocks, unknownBlocks };
}

export function blockPredictionSources(block, referenceState, overlay) {
  if (!block || block.intraMode != null || block.mode === "intra") return [];
  return (block.mv ?? []).map((raw, index) => {
    const reference = block.refs?.[index], mv = motionVectorToPixels(raw);
    const binding = referenceState?.bindings.find((entry) => entry.reference === reference);
    const picture = binding?.picture;
    const current = referenceState?.summary;
    const width = picture?.summary.frameWidth, height = picture?.summary.frameHeight;
    const sameSize = width > 0 && height > 0 && width === current?.frameWidth && height === current?.frameHeight;
    const region = mv && sameSize ? { x: block.x + mv.x, y: block.y + mv.y, width: block.width, height: block.height } : null;
    const blocks = picture && !picture.hidden ? overlay?.frames?.find((frame) => frame.frameId === picture.frameId)?.blocks ?? [] : [];
    const overlaps = region ? blocks.filter((candidate) => (candidate.plane ?? 0) === (block.plane ?? 0)
      && candidate.x < region.x + region.width && candidate.x + candidate.width > region.x
      && candidate.y < region.y + region.height && candidate.y + candidate.height > region.y) : [];
    return { index, reference, slot: binding?.slot ?? null, frameId: binding?.frameId ?? null, picture, mv, region, overlaps,
      reason: !binding ? "Reference mapping unavailable" : !picture ? "Referenced picture not resolved" : !mv ? "MV pixel precision unavailable" : !sameSize ? "Reference rescaling is not represented" : null };
  });
}

// Arcs share the same measured x coordinates as the frame cards. Targets outside
// the viewport remain clickable at the edge rather than silently disappearing.
export function timelineReferenceArcs(sourceX, targets, width) {
  if (!Number.isFinite(sourceX) || !(width > 0)) return [];
  const clamp = (x) => Math.max(10, Math.min(width - 10, x));
  return targets.map((target, index) => {
    const start = clamp(sourceX), end = clamp(target.x), lane = 18 + index * 8;
    const self = Math.abs(start - end) < 2;
    return { ...target, end, outside: target.x < 0 || target.x > width,
      path: self ? `M ${start} 2 C ${start - 24} ${lane + 15}, ${start + 24} ${lane + 15}, ${end} 2`
        : `M ${start} 2 L ${start} ${lane} L ${end} ${lane} L ${end} 2` };
  });
}
