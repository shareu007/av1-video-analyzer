export function csvCell(value) {
  const encoded = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(encoded)
    ? `"${encoded.replaceAll('"', '""')}"`
    : encoded;
}

export function csvRow(values) {
  return values.map(csvCell).join(",");
}

export function timelineCsvRows(frames, frameStatistics = null) {
  const points = new Map(
    (frameStatistics?.points ?? []).map((point) => [point.frameId, point]),
  );
  const rows = [csvRow([
    "frame_id", "decode_index", "timestamp", "pts", "dts",
    "duration_ticks", "duration_seconds", "duration_source", "frame_bitrate_bps",
    "keyframe", "gop_index", "gop_frame_index", "frame_type", "declared_size",
    "obu_count", "base_q_idx", "reference_frames",
  ])];
  for (const frame of frames) {
    const summary = frame.headerSummary ?? {};
    const point = points.get(frame.frameId);
    const refs = [...new Set(
      summary.referenceFrameIds?.filter((id) => id !== null) ?? [],
    )].join("|");
    rows.push(csvRow([
      frame.frameId,
      frame.decodeIndex,
      frame.timestamp,
      frame.pts,
      frame.dts,
      point?.durationTicks,
      point?.durationSeconds,
      point?.durationSource,
      point?.bitrateBitsPerSecond,
      point?.keyframe,
      point?.gopIndex,
      point?.gopFrameIndex,
      summary.frameTypeName ?? point?.frameType,
      frame.declaredSize,
      frame.obuIds.length,
      summary.baseQIdx,
      refs,
    ]));
  }
  return rows;
}
