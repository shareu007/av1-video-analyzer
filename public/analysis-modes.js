export function analysisModes(blocks, supports = () => true) {
  const has = (field) => blocks.some((block) => block[field] !== null && block[field] !== undefined);
  return [
    { id: "coding-flow", label: "Coding flow", layer: "partition", available: blocks.length > 0, note: "Coding block layout. Decode traversal order is not available." },
    { id: "predictions", label: "Predictions", layer: "mode", available: supports("mode") && has("mode"), note: "Intra/inter prediction classes. Predicted pixel samples are not available." },
    { id: "residuals", label: "Residuals", layer: "coefficients", available: supports("coefficient") && has("coeffNonZero"), note: "Non-zero coefficient count per block (log scale). Signed residual samples are not available." },
    { id: "reconstruction", label: "Reconstruction", available: false, note: "Pre-filter reconstruction samples are not available." },
    { id: "deblocking", label: "Deblocking", available: false, note: "Before/after deblocking samples and filtered-edge data are not available." },
    { id: "sao", label: "SAO", available: false, note: "SAO is not an AV1 coding tool." },
    { id: "yuv", label: "YUV", layer: "none", available: true, note: "Final decoded picture, converted to RGB for display. Separate Y/U/V plane views are not available." },
    { id: "info-overlays", label: "Info overlays", layer: "qindex", available: supports("qindex") && has("qindex"), note: "Block QIndex and quantizer delta overlays." },
    { id: "simple-motion", label: "Simple motion", layer: "motion", available: supports("motion-vector") && blocks.some((block) => block.mv?.length > 0), note: "Prediction motion vectors. Click to inspect; drag to pan. Zero vectors have no arrow." },
  ];
}
