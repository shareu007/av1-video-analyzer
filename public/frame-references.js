/**
 * Resolve the frame references carried by a frame header summary.
 *
 * Reference frame IDs and slot indices are parallel arrays.  A frame can be
 * referenced by more than one slot, so duplicate IDs are represented once and
 * retain all of their slot indices.  IDs which cannot be resolved in the
 * report are returned separately for diagnostics.
 */
export function frameReferenceTargets(report, frame, summary = frame?.headerSummary ?? {}) {
  const frames = Array.isArray(report?.frames) ? report.frames : [];
  const frameById = new Map(frames.map((candidate) => [candidate?.frameId, candidate]));
  const ids = Array.isArray(summary?.referenceFrameIds) ? summary.referenceFrameIds : [];
  const slots = Array.isArray(summary?.referenceSlotIndices) ? summary.referenceSlotIndices : [];
  const targets = [];
  const targetById = new Map();
  const unresolvedSlots = [];

  for (let index = 0; index < ids.length; index += 1) {
    const frameId = ids[index];
    if (!Number.isInteger(frameId)) {
      if (Number.isInteger(slots[index])) unresolvedSlots.push({ frameId: null, slotIndex: slots[index] });
      continue;
    }
    const slotIndex = slots[index];
    const target = frameById.get(frameId);
    if (!target) {
      unresolvedSlots.push({ frameId, slotIndex: Number.isInteger(slotIndex) ? slotIndex : null });
      continue;
    }
    let entry = targetById.get(frameId);
    if (!entry) {
      entry = { frameId, frame: target, slotIndices: [] };
      targetById.set(frameId, entry);
      targets.push(entry);
    }
    if (Number.isInteger(slotIndex) && !entry.slotIndices.includes(slotIndex)) {
      entry.slotIndices.push(slotIndex);
    }
  }

  return { targets, unresolvedSlots };
}
