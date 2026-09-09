import { Severity, byteRange, diagnostic } from "./model.js";

export function validateReportSemantics({ container, frames, obus }) {
  const diagnostics = [];
  for (const frame of frames) {
    const summary = frame.headerSummary;
    if (!summary) continue;
    if (summary.frameWidth !== null && summary.frameHeight !== null &&
        (summary.frameWidth <= 0 || summary.frameHeight <= 0)) {
      diagnostics.push(diagnostic(
        "FRAME_DIMENSIONS_INVALID",
        Severity.ERROR,
        `Frame ${frame.frameId} has invalid dimensions ${summary.frameWidth}x${summary.frameHeight}`,
        { range: frame.payloadRange, frameId: frame.frameId },
      ));
    }
    if (container?.width && container?.height && summary.frameTypeName === "KEY_FRAME" &&
        (summary.frameWidth !== container.width || summary.frameHeight !== container.height)) {
      diagnostics.push(diagnostic(
        "CONTAINER_CODED_DIMENSIONS_MISMATCH",
        Severity.WARNING,
        `Container is ${container.width}x${container.height}, key frame is ${summary.frameWidth}x${summary.frameHeight}`,
        { range: frame.payloadRange, frameId: frame.frameId },
      ));
    }
    for (const [index, referenceFrameId] of (summary.referenceFrameIds ?? []).entries()) {
      if (referenceFrameId === null) {
        diagnostics.push(diagnostic(
          "REFERENCE_SLOT_UNAVAILABLE",
          Severity.WARNING,
          `Frame ${frame.frameId} reference ${index} points to an uninitialized slot`,
          { range: frame.payloadRange, frameId: frame.frameId },
        ));
      } else if (referenceFrameId >= frame.frameId) {
        diagnostics.push(diagnostic(
          "REFERENCE_FRAME_NOT_EARLIER",
          Severity.ERROR,
          `Frame ${frame.frameId} references non-earlier frame ${referenceFrameId}`,
          { range: frame.payloadRange, frameId: frame.frameId },
        ));
      }
    }
  }
  for (const obu of obus) {
    if (obu.parsedPayloadBitLength !== undefined &&
        obu.parsedPayloadBitLength > obu.payloadRange.length * 8) {
      diagnostics.push(diagnostic(
        "SYNTAX_RANGE_EXCEEDS_PAYLOAD",
        Severity.ERROR,
        `Parsed syntax consumes ${obu.parsedPayloadBitLength} bits from a ${obu.payloadRange.length * 8}-bit payload`,
        { range: byteRange(obu.payloadRange.start, obu.payloadRange.length), frameId: obu.frameId, obuId: obu.obuId },
      ));
    }
  }
  return diagnostics;
}
