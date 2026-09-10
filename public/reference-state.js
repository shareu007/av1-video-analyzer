import { motionVectorToPixels } from "./block-renderer.js";

// Replay coded headers, including hidden pictures in a container packet. A
// picture is identified by its OBU, not just its container frame ID.
export function buildReferenceStateIndex(report) {
  const slots = Array(8).fill(null), states = new Map();
  const headers = (report.obus ?? []).filter((obu) => (obu.frameHeaderSummary || [3, 6].includes(obu.type?.code)) && obu.type?.code !== 7);
  const events = headers.length ? headers : (report.frames ?? []).map((frame) => ({ frameId: frame.frameId, obuId: null, frameHeaderSummary: frame.headerSummary }));
  for (const obu of events) {
    const summary = obu.frameHeaderSummary;
    if (!summary) {
      slots.fill(null);
      states.set(obu.frameId, { frameId: obu.frameId, obuId: obu.obuId, summary: {}, before: slots.slice(), after: slots.slice(), bindings: [], picture: null });
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
    const picture = summary.showExistingFrame ? before[summary.frameToShowMapIdx] ?? null
      : { frameId: obu.frameId, obuId: obu.obuId, summary, hidden: !summary.showFrame, previewFrameId: summary.showFrame ? obu.frameId : null };
    // A hidden picture may later become viewable via show_existing_frame.
    if (picture && summary.showExistingFrame && picture.previewFrameId == null) picture.previewFrameId = obu.frameId;
    if (Number.isInteger(summary.refreshFrameFlags)) {
      for (let slot = 0; slot < 8; slot++) if (summary.refreshFrameFlags & (1 << slot)) slots[slot] = picture;
    } else slots.fill(null); // Never claim stale state after an incomplete header.
    const state = { frameId: obu.frameId, obuId: obu.obuId, summary, before, after: slots.slice(), bindings, picture };
    if (!states.has(obu.frameId) || summary.showFrame || summary.showExistingFrame) states.set(obu.frameId, state);
  }
  return states;
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
