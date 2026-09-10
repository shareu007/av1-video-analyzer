import { coefficientDensity, intraPredictionName, motionVectorToPixels } from "./block-renderer.js";

const signed = (value) => `${value > 0 ? "+" : ""}${Number(value.toFixed(3))}`;
const reference = (block, index) => Number.isInteger(block.refs?.[index]) ? `R${block.refs[index]}` : "R?";

// These are base-direction symbols, not angle-delta-adjusted prediction rays.
const INTRA_SYMBOLS = { Vertical: "↕", Horizontal: "↔", D45: "╱", D135: "╲", D113: "╲", D157: "╲", D203: "╱", D67: "╱" };

export function blockAnnotationContent(block, layer, options = {}) {
  if (layer === "mode") {
    const intra = block.intraMode != null || block.mode === "intra";
    if (!intra && block.interMode == null && block.mode !== "inter") return { tone: "unknown", compact: "?", lines: ["Prediction ?", block.skip ? "Transform skipped" : "Not available"], detail: ["Prediction mode unavailable", ...(block.skip ? ["Transform skipped"] : [])] };
    const name = intra ? intraPredictionName(block.intraMode) : block.interMode ?? "Inter";
    const short = { Vertical: "V", Horizontal: "H", "Smooth V": "SM-V", "Smooth H": "SM-H", Smooth: "SM", Paeth: "PTH", Unavailable: "?" }[name] ?? name;
    const refs = (block.refs ?? []).map((id, index) => {
      const binding = options.referenceState?.bindings.find((entry) => entry.reference === id);
      return `${reference(block, index)}${binding?.frameId != null ? `→F${binding.frameId}` : ""}`;
    }).join(" + ");
    return {
      tone: intra ? "intra" : "inter",
      compact: intra ? short : block.refs?.length > 1 ? "BI" : refs || "INTER",
      lines: intra ? [`INTRA ${INTRA_SYMBOLS[name] ?? ""} ${name}`.replace(/ +/g, " "), block.skip ? "Transform skipped" : "Spatial prediction"]
        : [block.refs?.length > 1 ? `COMPOUND ${refs}` : `INTER ${refs}`.trim(), `${name}${block.skip ? " · TX skip" : ""}`],
      detail: intra ? [`Base mode: ${name}`, "Uses same-picture neighbours", ...(INTRA_SYMBOLS[name] ? ["Symbol indicates base direction; angle delta unavailable"] : []), ...(block.skip ? ["Transform skipped (not a prediction mode)"] : [])]
        : [`Prediction: ${name}`, `Reference identifiers: ${refs || "unavailable"}`, ...(block.skip ? ["Transform skipped"] : [])],
    };
  }
  if (layer === "coefficients") {
    const density = coefficientDensity(block);
    if (density === null) return { tone: "unknown", compact: "?", lines: ["NZ ?", "Not available"], detail: ["Coefficient data unavailable; not equivalent to zero"] };
    const percent = `${(density * 100).toFixed(1)}%`;
    return {
      tone: density === 0 ? "zero" : "residual",
      compact: `${block.coeffNonZero}`,
      lines: [`NZ ${block.coeffNonZero}`, density === 0 ? "Zero coefficients" : `${percent} of block area`],
      // Same logarithmic scale as the heatmap, not residual amplitude.
      bar: Math.log2(1 + 255 * Math.min(1, density)) / 8,
      detail: [`Non-zero coefficients: ${block.coeffNonZero}`, `Count / block area: ${percent}`, ...(block.txSize ? [`Transform: ${block.txSize}`] : []), "Coefficient activity, not signed residual pixels"],
    };
  }
  if (layer === "motion") {
    const component = options.component ?? "all";
    const minimum = Number.isFinite(options.minimumMagnitudePixels) ? Math.max(0, options.minimumMagnitudePixels) : 0;
    const vectors = (block.mv ?? []).flatMap((raw, index) => {
      if (component === "primary" && index !== 0 || component === "secondary" && index !== 1) return [];
      const mv = motionVectorToPixels(raw);
      return [{ raw, mv, index }];
    });
    const prefix = ({ index }) => `MV${index + 1} ${reference(block, index)}`;
    const detail = vectors.map((entry) => {
      const { mv, raw } = entry;
      return mv ? `${prefix(entry)}: Δx ${signed(mv.x)}, Δy ${signed(mv.y)} px · |MV| ${Number(mv.magnitude.toFixed(3))} px`
        : `${prefix(entry)}: raw (${raw.x}, ${raw.y}); pixel precision unavailable`;
    });
    const shown = vectors.filter(({ mv }) => !mv || mv.magnitude >= minimum);
    const lines = shown.map((entry) => !entry.mv ? `${prefix(entry)} ? px`
      : entry.mv.magnitude === 0 ? `${prefix(entry)} • 0 px`
        : `${prefix(entry)} (${signed(entry.mv.x)}, ${signed(entry.mv.y)}) px`);
    const fallback = block.mode === "intra" || block.intraMode != null ? "INTRA · no temporal MV" : vectors.length ? "Below MV threshold" : component === "secondary" ? "No MV2" : "No MV data";
    return {
      tone: "motion", compact: options.showMotionVectors === false ? "OFF" : shown.length ? shown.every(({ mv }) => mv?.magnitude === 0) ? "0px" : shown.map(({ index, mv }) => `${reference(block, index)}${mv ? "" : "?"}`).join("/") : "—",
      lines: options.showMotionVectors === false ? ["Vectors hidden"] : lines.length ? lines : [fallback],
      detail: [...(detail.length ? detail : [fallback]), "Δx: right + / left − · Δy: down + / up −", ...(options.showMotionVectors === false ? ["Vector display is switched off"] : vectors.length !== shown.length ? [`Vectors below ${minimum} px are hidden`] : [])],
    };
  }
  return null;
}

// Pack only labels which fit inside their blocks. Use CSS pixels so zoom reveals
// detail without enlarging the text; reject collisions across overlapping planes.
export function layoutBlockAnnotations(blocks, { layer, width, height, bounds, viewport = bounds, selectedBlockId = null, labels = "auto", ...options }) {
  if (!["mode", "coefficients", "motion"].includes(layer) || labels !== "auto" || !(width > 0 && height > 0 && bounds.width > 0 && bounds.height > 0)) return [];
  const sx = bounds.width / width, sy = bounds.height / height;
  const offsetX = (bounds.left ?? 0) - (viewport.left ?? 0);
  const offsetY = (bounds.top ?? 0) - (viewport.top ?? 0);
  const candidates = [];
  for (const block of blocks) {
    const bw = block.width * sx, bh = block.height * sy;
    if (bw < 12 || bh < 12) continue;
    if (block.x * sx + offsetX + bw < 0 || block.y * sy + offsetY + bh < 0 || block.x * sx + offsetX > viewport.width || block.y * sy + offsetY > viewport.height) continue;
    const content = blockAnnotationContent(block, layer, options);
    if (!content) continue;
    const roomy = bw >= 130 && bh >= 50;
    const variants = [...(roomy ? [{ lines: content.lines, fontSize: 11, padding: 12 }] : []), { lines: [content.lines[0]], fontSize: 11, padding: 12 }, { lines: [content.compact], fontSize: 10, padding: 4 }, { lines: [content.compact], fontSize: 9, padding: 2 }];
    const fit = variants.map(({ lines, fontSize, padding }) => ({
      lines, fontSize, labelWidth: Math.max(...lines.map((line) => line.length * fontSize * 0.61)) + padding,
      labelHeight: lines.length * (fontSize + 2) + 2 + (lines.length > 1 && content.bar != null ? 4 : 0),
    })).find(({ labelWidth, labelHeight }) => labelWidth <= bw - 1 && labelHeight <= bh - 1);
    if (!fit) continue;
    const { lines, fontSize, labelWidth, labelHeight } = fit;
    const left = block.x * sx + (bw - labelWidth) / 2;
    const top = block.y * sy + (layer === "motion" ? 2 : (bh - labelHeight) / 2);
    if (left + offsetX + labelWidth < 0 || top + offsetY + labelHeight < 0 || left + offsetX > viewport.width || top + offsetY > viewport.height) continue;
    candidates.push({ blockId: block.blockId, left, top, width: labelWidth, height: labelHeight, lines, fontSize, tone: content.tone, bar: lines.length > 1 ? content.bar : null });
  }
  candidates.sort((a, b) => Number(b.blockId === selectedBlockId) - Number(a.blockId === selectedBlockId) || b.width * b.height - a.width * a.height);
  const cells = new Map(), result = [];
  for (const item of candidates) {
    const keys = [];
    let overlaps = false;
    for (let y = Math.floor(item.top / 64); y <= Math.floor((item.top + item.height) / 64); y++) {
      for (let x = Math.floor(item.left / 64); x <= Math.floor((item.left + item.width) / 64); x++) {
        const key = `${x}:${y}`;
        keys.push(key);
        if ((cells.get(key) ?? []).some((other) => item.left < other.left + other.width + 2 && item.left + item.width + 2 > other.left && item.top < other.top + other.height + 2 && item.top + item.height + 2 > other.top)) overlaps = true;
      }
    }
    if (overlaps) continue;
    result.push(item);
    for (const key of keys) { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(item); }
    if (result.length >= 500) break;
  }
  return result;
}

export function paintBlockAnnotationElements(root, items, document) {
  root.innerHTML = "";
  for (const item of items) {
    const label = document.createElement("span");
    label.className = `block-label tone-${item.tone}${item.fontSize < 11 ? " compact-label" : ""}`;
    label.textContent = item.lines.join("\n");
    // CSSOM assignment is allowed by style-src 'self'. HTML style attributes
    // are blocked by that policy and would stack every label at the origin.
    Object.assign(label.style, { left: `${item.left}px`, top: `${item.top}px`, width: `${item.width}px`, height: `${item.height}px`, fontSize: `${item.fontSize}px`, lineHeight: `${item.fontSize + 2}px` });
    if (item.bar != null) {
      const meter = document.createElement("i"), fill = document.createElement("i");
      meter.className = "coefficient-meter";
      fill.style.width = `${item.bar * 100}%`;
      meter.append(fill); label.append(meter);
    }
    root.append(label);
  }
}
