import { motionVectorToPixels } from "./block-renderer.js";

export function analysisModes(blocks, supports = () => true) {
  const hasMode = blocks.some((block) => ["intra", "inter", "skip"].includes(block.mode));
  const hasCoefficients = blocks.some((block) => Number.isFinite(block.coeffNonZero) && block.coeffNonZero >= 0);
  const hasQindex = blocks.some((block) => Number.isFinite(block.qindex) && block.qindex >= 0 && block.qindex <= 255);
  const hasMotion = blocks.some((block) => block.mv?.some((vector) => motionVectorToPixels(vector) !== null));
  return [
    { id: "coding-flow", label: "Coding flow", layer: "partition", available: blocks.length > 0, note: "Coding block layout. Decode traversal order is not available." },
    { id: "predictions", label: "Predictions", layer: "mode", available: supports("mode") && hasMode, note: "Select an Inter block to show its reference picture, MV source area and overlapping coding blocks below the image. Intra direction symbols are schematic. Angle deltas and predicted pixel samples are not available." },
    { id: "residuals", label: "Residuals", layer: "coefficients", available: supports("coefficient") && hasCoefficients, note: "Words and colors show coefficient density, not residual amplitude. NZ = non-zero coefficients; % and bar = count / block area. Zoom for counts; hover or click for details. Edge clipping can inflate density (! = area mismatch). Signed residual samples are not available." },
    { id: "reconstruction", label: "Reconstruction", available: false, note: "Pre-filter reconstruction samples are not available." },
    { id: "deblocking", label: "Deblocking", available: false, note: "Before/after deblocking samples and filtered-edge data are not available." },
    { id: "sao", label: "SAO", available: false, note: "SAO is not an AV1 coding tool." },
    { id: "yuv", label: "YUV", layer: "none", available: true, note: "Final decoded picture, converted to RGB for display. Separate Y/U/V plane views are not available." },
    { id: "info-overlays", label: "Info overlays", layer: "qindex", available: supports("qindex") && hasQindex, note: "Block QIndex and quantizer delta overlays." },
    { id: "simple-motion", label: "Simple motion", layer: "motion", available: supports("motion-vector") && hasMotion, note: "Block labels identify references and (Δx, Δy) in pixels; 0px marks zero displacement. Click for both MV components and exact values. Arrow scaling changes only the drawing, not the reported displacement." },
  ];
}
