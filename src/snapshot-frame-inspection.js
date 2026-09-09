import { createHash } from "node:crypto";

import { writeBlockOverlaySnapshot } from "./block-overlay-store.js";
import {
  NATIVE_INSPECTION_MAX_INPUT_BYTES,
  inspectReportFramesInNativeWorker,
} from "./native-inspection-worker.js";
import { readSnapshotManifest, readSnapshotPage } from "./snapshot-store.js";

export const SNAPSHOT_INSPECTION_MAX_FRAMES = 10_000;
const PAGE_SIZE = 1_000;

function inspectionError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function validateFrameRecord(frame, expectedFrameId, sourceSize) {
  const range = frame?.payloadRange;
  if (frame?.frameId !== expectedFrameId
      || !Number.isSafeInteger(range?.start) || range.start < 0
      || !Number.isSafeInteger(range?.length) || range.length < 1
      || range.start + range.length > sourceSize || frame.complete === false) {
    throw inspectionError(
      `snapshot frame ${expectedFrameId} is incomplete or has an invalid payload range`,
      "SNAPSHOT_FRAME_INSPECTION_RANGE_INVALID",
      409,
    );
  }
  return frame;
}

async function findDecoderConfigRange(
  rootDirectory,
  snapshotId,
  firstFrame,
  sourceSize,
) {
  const obuIds = Array.isArray(firstFrame.obuIds)
    ? firstFrame.obuIds.filter((value) => Number.isSafeInteger(value) && value >= 0)
    : [];
  let cursor = obuIds.length ? Math.max(...obuIds) + 1 : 0;
  while (cursor > 0) {
    const offset = Math.max(0, cursor - PAGE_SIZE);
    const page = await readSnapshotPage(rootDirectory, snapshotId, "obus", {
      offset,
      limit: cursor - offset,
    });
    const sequence = [...page.records].reverse().find(({ type }) => type?.code === 1);
    if (sequence) {
      const range = sequence.byteRange;
      if (!Number.isSafeInteger(range?.start) || range.start < 0
          || !Number.isSafeInteger(range?.length) || range.length < 1
          || range.start + range.length > sourceSize) {
        throw inspectionError(
          "indexed Sequence Header has an invalid source range",
          "SNAPSHOT_FRAME_INSPECTION_RANGE_INVALID",
          409,
        );
      }
      const frameRange = firstFrame.payloadRange;
      const alreadyInFrame = range.start >= frameRange.start
        && range.start + range.length <= frameRange.start + frameRange.length;
      return { found: true, prefixRange: alreadyInFrame ? null : range };
    }
    cursor = offset;
  }
  return { found: false, prefixRange: null };
}

export async function planSnapshotFrameInspection(
  rootDirectory,
  snapshotId,
  targetFrameId,
  {
    maximumInputBytes = NATIVE_INSPECTION_MAX_INPUT_BYTES,
    maximumFrames = SNAPSHOT_INSPECTION_MAX_FRAMES,
  } = {},
) {
  if (!Number.isSafeInteger(targetFrameId) || targetFrameId < 0) {
    throw inspectionError(
      "target frame ID must be a non-negative safe integer",
      "SNAPSHOT_FRAME_INSPECTION_INVALID",
    );
  }
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 1
      || maximumInputBytes > NATIVE_INSPECTION_MAX_INPUT_BYTES
      || !Number.isSafeInteger(maximumFrames) || maximumFrames < 1
      || maximumFrames > SNAPSHOT_INSPECTION_MAX_FRAMES) {
    throw new RangeError("snapshot inspection plan has invalid resource limits");
  }
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const frameCount = manifest.collections?.frames?.count ?? 0;
  if (targetFrameId >= frameCount) {
    throw inspectionError(
      "snapshot target frame does not exist",
      "SNAPSHOT_FRAME_NOT_FOUND",
      404,
    );
  }
  const sourceSize = manifest.header?.source?.size;
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 1) {
    throw inspectionError(
      "snapshot source size is unavailable",
      "SNAPSHOT_FRAME_INSPECTION_UNAVAILABLE",
      409,
    );
  }

  const reversed = [];
  let inputByteLength = 0;
  let cursor = targetFrameId + 1;
  let randomAccessFrameId = null;
  while (cursor > 0 && randomAccessFrameId === null) {
    const offset = Math.max(0, cursor - PAGE_SIZE);
    const page = await readSnapshotPage(rootDirectory, snapshotId, "frames", {
      offset,
      limit: cursor - offset,
    });
    for (let index = page.records.length - 1; index >= 0; index -= 1) {
      const frameId = offset + index;
      const frame = validateFrameRecord(page.records[index], frameId, sourceSize);
      reversed.push(frame);
      inputByteLength += frame.payloadRange.length;
      if (inputByteLength > maximumInputBytes) {
        throw inspectionError(
          `decode window exceeds the ${maximumInputBytes}-byte native inspection limit`,
          "SNAPSHOT_FRAME_INSPECTION_WINDOW_TOO_LARGE",
          413,
        );
      }
      if (reversed.length > maximumFrames) {
        throw inspectionError(
          `decode window exceeds the ${maximumFrames}-frame inspection limit`,
          "SNAPSHOT_FRAME_INSPECTION_WINDOW_TOO_LARGE",
          413,
        );
      }
      if (frame.keyframe === true || frameId === 0) {
        randomAccessFrameId = frameId;
        break;
      }
    }
    cursor = offset;
  }
  if (randomAccessFrameId === null) {
    throw inspectionError(
      "no random-access frame was found for the requested decode window",
      "SNAPSHOT_FRAME_INSPECTION_NO_RANDOM_ACCESS",
      409,
    );
  }
  const sourceFrames = reversed.reverse();
  const decoderConfig = await findDecoderConfigRange(
    rootDirectory, snapshotId, sourceFrames[0], sourceSize,
  );
  const decoderConfigRanges = decoderConfig.prefixRange ? [decoderConfig.prefixRange] : [];
  inputByteLength += decoderConfigRanges.reduce((total, range) => total + range.length, 0);
  if (inputByteLength > maximumInputBytes) {
    throw inspectionError(
      `decode window plus decoder configuration exceeds the ${maximumInputBytes}-byte limit`,
      "SNAPSHOT_FRAME_INSPECTION_WINDOW_TOO_LARGE",
      413,
    );
  }
  const frames = sourceFrames.map((frame) => ({
    frameId: frame.frameId,
    decodeIndex: frame.decodeIndex,
    timestamp: frame.timestamp,
    keyframe: frame.keyframe === true || frame.frameId === 0,
    headerSummary: frame.headerSummary ?? null,
    payloadRange: frame.payloadRange,
  }));
  return {
    schemaVersion: 1,
    kind: "av1scope-snapshot-frame-inspection-plan",
    snapshotId,
    targetFrameId,
    randomAccessFrameId,
    inputByteLength,
    decoderConfigRanges,
    sequenceHeaderFound: decoderConfig.found,
    frames,
    sourceFingerprint: manifest.header.source.fingerprint ?? null,
  };
}

export async function inspectSnapshotFrameWindow(
  rootDirectory,
  snapshotId,
  targetFrameId,
  input,
  {
    executable,
    signal = null,
    inspectFrames = inspectReportFramesInNativeWorker,
    writeOverlay = writeBlockOverlaySnapshot,
  } = {},
) {
  if (!Buffer.isBuffer(input)) throw new TypeError("snapshot inspection input must be a Buffer");
  const plan = await planSnapshotFrameInspection(rootDirectory, snapshotId, targetFrameId);
  if (input.length !== plan.inputByteLength) {
    throw inspectionError(
      "uploaded decode window length does not match the snapshot plan",
      "SNAPSHOT_FRAME_INSPECTION_LENGTH_MISMATCH",
    );
  }
  const manifest = await readSnapshotManifest(rootDirectory, snapshotId);
  const decoderConfigBytes = plan.decoderConfigRanges
    .reduce((total, range) => total + range.length, 0);
  let cursor = decoderConfigBytes;
  const localFrames = plan.frames.map((frame, frameId) => {
    const local = {
      ...frame,
      frameId,
      payloadRange: {
        start: frameId === 0 ? 0 : cursor,
        length: frame.payloadRange.length + (frameId === 0 ? decoderConfigBytes : 0),
      },
    };
    cursor += frame.payloadRange.length;
    return local;
  });
  const localReport = {
    ...manifest.header,
    frames: localFrames,
    obus: [],
    syntaxNodes: [],
    diagnostics: [],
  };
  const localOverlay = await inspectFrames(input, localReport, {
    executable,
    signal,
  });
  if (!Array.isArray(localOverlay?.frames)
      || localOverlay.frames.length !== plan.frames.length
      || localOverlay.frames.some((frame, index) => frame?.frameId !== index)) {
    throw inspectionError(
      "native inspection returned an incomplete or reordered frame window",
      "SNAPSHOT_FRAME_INSPECTION_PROTOCOL_ERROR",
      502,
    );
  }
  const overlay = {
    ...localOverlay,
    provenance: {
      ...localOverlay.provenance,
      sourceFingerprint: plan.sourceFingerprint,
      inputSha256: createHash("sha256").update(input).digest("hex"),
      frameWindow: {
        randomAccessFrameId: plan.randomAccessFrameId,
        targetFrameId: plan.targetFrameId,
        frameCount: plan.frames.length,
      },
    },
    frames: localOverlay.frames.map((frame, index) => ({
      ...frame,
      frameId: plan.frames[index].frameId,
    })),
  };
  const stored = await writeOverlay(rootDirectory, {
    parentSnapshotId: snapshotId,
    overlay,
  });
  return { plan, overlay, stored };
}
