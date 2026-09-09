// A container sample can carry several hidden coded frames before its displayed
// frame. The preview must use the displayed header, not the first packet header.
export function displayedFrameSummary(report, frame) {
  const ids = new Set(frame?.obuIds ?? []);
  let displayed = null;
  for (const obu of report?.obus ?? []) {
    if (!ids.has(obu.obuId)) continue;
    const summary = obu.frameHeaderSummary;
    if (summary?.showExistingFrame || summary?.showFrame) displayed = summary;
  }
  return displayed ?? frame?.headerSummary ?? {};
}

export function sourcePointFromClient(bounds, clientX, clientY, width, height) {
  if (!(bounds.width > 0 && bounds.height > 0)) return null;
  const x = (clientX - bounds.left) / bounds.width * width;
  const y = (clientY - bounds.top) / bounds.height * height;
  return x >= 0 && x < width && y >= 0 && y < height ? { x, y } : null;
}
