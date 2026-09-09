import { BitReader } from "./bit-reader.js";
import { SCHEMA_VERSION, Severity, byteRange, diagnostic } from "./model.js";

const FRAME_TYPES = ["KEY_FRAME", "INTER_FRAME", "INTRA_ONLY_FRAME", "SWITCH_FRAME"];
const SEGMENT_FEATURE_BITS = [8, 6, 6, 6, 6, 3, 0, 0];
const SEGMENT_FEATURE_SIGNED = [true, true, true, true, true, false, false, false];
const SEGMENT_FEATURE_NAMES = [
  "alt_q", "alt_lf_y_v", "alt_lf_y_h", "alt_lf_u", "alt_lf_v",
  "ref_frame", "skip", "globalmv",
];
const RESTORATION_TYPE_NAMES = [
  "RESTORE_NONE", "RESTORE_SWITCHABLE", "RESTORE_WIENER", "RESTORE_SGRPROJ",
];

export function decodeSignedBits(unsignedValue, bitWidth) {
  if (!Number.isInteger(bitWidth) || bitWidth < 1 || bitWidth > 31) {
    throw new RangeError("signed bit width must be between 1 and 31");
  }
  const signMask = 2 ** (bitWidth - 1);
  return unsignedValue >= signMask ? unsignedValue - 2 ** bitWidth : unsignedValue;
}

export function inverseRecenter(reference, value) {
  if (value > 2 * reference) return value;
  return value % 2 ? reference - Math.floor((value + 1) / 2) : reference + value / 2;
}

export function recenterSubexpValue(maximum, reference, value) {
  return reference * 2 <= maximum
    ? inverseRecenter(reference, value)
    : maximum - 1 - inverseRecenter(maximum - 1 - reference, value);
}

function valueFor(nodes, path, fallback = undefined) {
  return nodes.find((node) => node.path === path)?.value ?? fallback;
}

export function operatingPointIncludes(operatingPointIdc, temporalId = 0, spatialId = 0) {
  if (operatingPointIdc === 0) return true;
  return Boolean(
    ((operatingPointIdc >> temporalId) & 1) &&
    ((operatingPointIdc >> (spatialId + 8)) & 1),
  );
}

export function invalidatedSlotsFromOrderHints(referenceSlots, refOrderHints) {
  const invalidated = [];
  for (let slot = 0; slot < Math.min(referenceSlots.length, refOrderHints.length); slot += 1) {
    const stored = referenceSlots[slot]?.orderHint;
    if (stored !== undefined && stored !== null && refOrderHints[slot] !== stored) invalidated.push(slot);
  }
  return invalidated;
}

export function sequenceContextFromNodes(nodes) {
  const reduced = valueFor(nodes, "sequence_header.reduced_still_picture_header", 0);
  const chooseScreen = valueFor(nodes, "sequence_header.seq_choose_screen_content_tools", reduced ? 1 : 0);
  const forceScreen = reduced || chooseScreen
    ? 2
    : valueFor(nodes, "sequence_header.seq_force_screen_content_tools", 0);
  const chooseInteger = valueFor(nodes, "sequence_header.seq_choose_integer_mv", reduced ? 1 : 0);
  const forceInteger = reduced || chooseInteger
    ? 2
    : valueFor(nodes, "sequence_header.seq_force_integer_mv", 0);
  const operatingPointsCount = valueFor(nodes, "sequence_header.operating_points_cnt_minus_1", 0) + 1;
  return {
    reducedStillPictureHeader: reduced,
    decoderModelInfoPresentFlag: valueFor(nodes, "sequence_header.decoder_model_info_present_flag", 0),
    bufferRemovalTimeLengthMinus1: valueFor(
      nodes, "sequence_header.decoder_model_info.buffer_removal_time_length_minus_1", -1,
    ),
    framePresentationTimeLengthMinus1: valueFor(
      nodes, "sequence_header.decoder_model_info.frame_presentation_time_length_minus_1", -1,
    ),
    operatingPoints: Array.from({ length: operatingPointsCount }, (_, index) => ({
      operatingPointIdc: valueFor(nodes, `sequence_header.operating_points[${index}].operating_point_idc`, 0),
      decoderModelPresent: Boolean(valueFor(
        nodes, `sequence_header.operating_points[${index}].decoder_model_present_for_this_op`, 0,
      )),
    })),
    equalPictureInterval: valueFor(nodes, "sequence_header.timing_info.equal_picture_interval", 0),
    frameIdNumbersPresentFlag: valueFor(nodes, "sequence_header.frame_id_numbers_present_flag", 0),
    deltaFrameIdLengthMinus2: valueFor(nodes, "sequence_header.delta_frame_id_length_minus_2", 0),
    additionalFrameIdLengthMinus1: valueFor(nodes, "sequence_header.additional_frame_id_length_minus_1", 0),
    frameWidthBitsMinus1: valueFor(nodes, "sequence_header.frame_width_bits_minus_1", 0),
    frameHeightBitsMinus1: valueFor(nodes, "sequence_header.frame_height_bits_minus_1", 0),
    maxFrameWidthMinus1: valueFor(nodes, "sequence_header.max_frame_width_minus_1", 0),
    maxFrameHeightMinus1: valueFor(nodes, "sequence_header.max_frame_height_minus_1", 0),
    enableOrderHint: valueFor(nodes, "sequence_header.enable_order_hint", 0),
    orderHintBitsMinus1: valueFor(nodes, "sequence_header.order_hint_bits_minus_1", -1),
    enableSuperres: valueFor(nodes, "sequence_header.enable_superres", 0),
    use128x128Superblock: valueFor(nodes, "sequence_header.use_128x128_superblock", 0),
    enableWarpedMotion: valueFor(nodes, "sequence_header.enable_warped_motion", 0),
    enableRefFrameMvs: valueFor(nodes, "sequence_header.enable_ref_frame_mvs", 0),
    enableCdef: valueFor(nodes, "sequence_header.enable_cdef", 0),
    enableRestoration: valueFor(nodes, "sequence_header.enable_restoration", 0),
    filmGrainParamsPresent: valueFor(nodes, "sequence_header.film_grain_params_present", 0),
    numPlanes: valueFor(nodes, "sequence_header.color_config.mono_chrome", 0) ? 1 : 3,
    subsamplingX: valueFor(nodes, "sequence_header.color_config.subsampling_x", 1),
    subsamplingY: valueFor(nodes, "sequence_header.color_config.subsampling_y", 1),
    separateUvDeltaQ: valueFor(nodes, "sequence_header.color_config.separate_uv_delta_q", 0),
    seqForceScreenContentTools: forceScreen,
    seqForceIntegerMv: forceInteger,
  };
}

export function parseFrameHeaderPrefix(
  buffer,
  obu,
  sequenceContext,
  { nextSyntaxNodeId = 0, referenceSlots = [] } = {},
) {
  const nodes = [];
  const diagnostics = [];
  const { start, length } = obu.payloadRange;
  const reader = new BitReader(buffer, { startByte: start, lengthBytes: length });
  const baseBit = start * 8;

  function coded(path, width, presence = "true") {
    const relativeStart = reader.position;
    const value = reader.readBits(width);
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path,
      value,
      coding: `f(${width})`,
      presence,
      bitRange: { startBit: baseBit + relativeStart, lengthBits: width },
      specAnchor: "AV1 §5.9.3 Uncompressed header syntax",
    });
    return value;
  }

  function inferred(path, value, presence) {
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path,
      value,
      coding: "inferred",
      presence,
      bitRange: null,
      specAnchor: "AV1 §5.9.3 Uncompressed header syntax",
    });
    return value;
  }

  function signed(path, bitWidth, presence = "true") {
    const relativeStart = reader.position;
    const value = decodeSignedBits(reader.readBits(bitWidth), bitWidth);
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path,
      value,
      coding: `su(${bitWidth})`,
      presence,
      bitRange: { startBit: baseBit + relativeStart, lengthBits: bitWidth },
      specAnchor: "AV1 §5.9 Frame header syntax",
    });
    return value;
  }

  function nonSymmetric(path, maximum, presence = "true") {
    if (!Number.isInteger(maximum) || maximum < 1) throw new RangeError("ns(n) maximum must be positive");
    const relativeStart = reader.position;
    let value = 0;
    if (maximum > 1) {
      const width = Math.floor(Math.log2(maximum)) + 1;
      const cutoff = 2 ** width - maximum;
      const prefix = reader.readBits(width - 1);
      value = prefix < cutoff
        ? prefix
        : (prefix * 2 - cutoff + reader.readBits(1));
    }
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path,
      value,
      coding: `ns(${maximum})`,
      presence,
      bitRange: { startBit: baseBit + relativeStart, lengthBits: reader.position - relativeStart },
      specAnchor: "AV1 §5.9.15 Tile info syntax",
    });
    return value;
  }

  function rawNonSymmetric(maximum) {
    if (maximum <= 1) return 0;
    const width = Math.floor(Math.log2(maximum)) + 1;
    const cutoff = 2 ** width - maximum;
    const prefix = reader.readBits(width - 1);
    return prefix < cutoff ? prefix : prefix * 2 - cutoff + reader.readBits(1);
  }

  function decodeSubexp(numSyms) {
    let iteration = 0;
    let offset = 0;
    while (true) {
      const bits = iteration ? 3 + iteration - 1 : 3;
      const alphabet = 2 ** bits;
      if (numSyms <= offset + 3 * alphabet) return rawNonSymmetric(numSyms - offset) + offset;
      if (reader.readBits(1)) {
        iteration += 1;
        offset += alphabet;
      } else {
        return reader.readBits(bits) + offset;
      }
    }
  }

  function readSignedSubexp(path, low, high, reference, presence) {
    const relativeStart = reader.position;
    const maximum = high - low;
    const centeredReference = reference - low;
    const encoded = decodeSubexp(maximum);
    const value = recenterSubexpValue(maximum, centeredReference, encoded) + low;
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path: `${path}.subexp_code`,
      value: encoded,
      coding: `decode_signed_subexp_with_ref(${low},${high},${reference})`,
      presence,
      bitRange: { startBit: baseBit + relativeStart, lengthBits: reader.position - relativeStart },
      specAnchor: "AV1 §5.9.26 Decode signed subexp with ref syntax",
    });
    inferred(path, value, `decoded from ${path}.subexp_code`);
    return value;
  }

  function tileLog2(blockSize, target) {
    let value = 0;
    while ((blockSize << value) < target) value += 1;
    return value;
  }

  function relativeDistance(left, right) {
    if (!sequenceContext.enableOrderHint) return 0;
    const bits = sequenceContext.orderHintBitsMinus1 + 1;
    const mask = 2 ** bits - 1;
    const sign = 2 ** (bits - 1);
    const difference = (left - right) & mask;
    return (difference & (sign - 1)) - (difference & sign);
  }

  function readDeltaQ(path) {
    const present = coded(`${path}.delta_coded`, 1);
    return present ? signed(`${path}.delta_q`, 7, `${path}.delta_coded == 1`) : 0;
  }

  if (!sequenceContext) {
    diagnostics.push(
      diagnostic(
        "FRAME_HEADER_SEQUENCE_CONTEXT_MISSING",
        Severity.ERROR,
        "Frame Header requires a preceding complete Sequence Header",
        { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
      ),
    );
    return { nodes, diagnostics, nextSyntaxNodeId, parsedBitLength: 0, status: "error" };
  }

  try {
    let showExistingFrame;
    let frameType;
    let showFrame;
    let showableFrame;
    let errorResilientMode;
    if (sequenceContext.reducedStillPictureHeader) {
      showExistingFrame = inferred("frame_header.show_existing_frame", 0, "reduced_still_picture_header == 1");
      frameType = inferred("frame_header.frame_type", 0, "reduced_still_picture_header == 1");
      inferred("frame_header.frame_type_name", FRAME_TYPES[frameType], "derived from frame_type");
      showFrame = inferred("frame_header.show_frame", 1, "reduced_still_picture_header == 1");
      showableFrame = inferred("frame_header.showable_frame", 0, "reduced_still_picture_header == 1");
      errorResilientMode = inferred("frame_header.error_resilient_mode", 1, "KEY_FRAME && show_frame");
    } else {
      showExistingFrame = coded("frame_header.show_existing_frame", 1);
      if (showExistingFrame) {
        if (obu.type?.code === 6) {
          diagnostics.push(diagnostic(
            "SHOW_EXISTING_IN_FRAME_OBU",
            Severity.ERROR,
            "show_existing_frame must be zero in an OBU_FRAME",
            { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
          ));
        }
        const frameToShowMapIdx = coded("frame_header.frame_to_show_map_idx", 3, "show_existing_frame == 1");
        const referenced = referenceSlots[frameToShowMapIdx] ?? null;
        let framePresentationTime = null;
        if (sequenceContext.decoderModelInfoPresentFlag && !sequenceContext.equalPictureInterval) {
          framePresentationTime = coded(
            "frame_header.frame_presentation_time",
            sequenceContext.framePresentationTimeLengthMinus1 + 1,
            "show_existing_frame && decoder_model_info_present_flag && !equal_picture_interval",
          );
        }
        let displayFrameId = null;
        if (sequenceContext.frameIdNumbersPresentFlag) {
          const idLength = sequenceContext.additionalFrameIdLengthMinus1 +
            sequenceContext.deltaFrameIdLengthMinus2 + 3;
          displayFrameId = coded(
            "frame_header.display_frame_id",
            idLength,
            "show_existing_frame && frame_id_numbers_present_flag",
          );
          if (referenced?.currentFrameId !== undefined && displayFrameId !== referenced.currentFrameId) {
            diagnostics.push(diagnostic(
              "DISPLAY_FRAME_ID_MISMATCH",
              Severity.ERROR,
              `display_frame_id ${displayFrameId} does not match reference slot ${frameToShowMapIdx} frame id ${referenced.currentFrameId}`,
              { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
            ));
          }
        }
        if (!referenced) {
          diagnostics.push(diagnostic(
            "SHOW_EXISTING_REFERENCE_MISSING",
            Severity.ERROR,
            `show_existing_frame selects empty reference slot ${frameToShowMapIdx}`,
            { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
          ));
        } else if (referenced.showableFrame === false) {
          diagnostics.push(diagnostic(
            "SHOW_EXISTING_REFERENCE_NOT_SHOWABLE",
            Severity.ERROR,
            `reference slot ${frameToShowMapIdx} was not marked showable`,
            { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
          ));
        }
        const referencedFrameType = referenced?.frameType ?? null;
        const refreshFrameFlags = referencedFrameType === 0 ? 255 : 0;
        inferred(
          "frame_header.refresh_frame_flags",
          refreshFrameFlags,
          referencedFrameType === 0 ? "show_existing_frame references KEY_FRAME" : "show_existing_frame",
        );
        const filmGrain = sequenceContext.filmGrainParamsPresent && referenced?.filmGrain
          ? structuredClone(referenced.filmGrain)
          : { applyGrain: false };
        return {
          nodes,
          diagnostics,
          nextSyntaxNodeId,
          parsedBitLength: reader.position,
          status: "partial",
          summary: {
            showExistingFrame,
            frameType: referencedFrameType,
            frameTypeName: "SHOW_EXISTING",
            referencedFrameTypeName: referencedFrameType === null ? null : FRAME_TYPES[referencedFrameType],
            showFrame: 1,
            showableFrame: 1,
            frameToShowMapIdx,
            framePresentationTime,
            displayFrameId,
            refreshFrameFlags,
            referenceSlotIndices: [frameToShowMapIdx],
            referenceFrameIds: [referenced?.frameId ?? null],
            frameWidth: referenced?.frameWidth ?? null,
            frameHeight: referenced?.frameHeight ?? null,
            renderWidth: referenced?.renderWidth ?? null,
            renderHeight: referenced?.renderHeight ?? null,
            orderHint: referenced?.orderHint ?? null,
            segmentation: referenced?.segmentation,
            globalMotionTypes: referenced?.globalMotionTypes,
            globalMotionParams: referenced?.globalMotionParams,
            filmGrain,
          },
        };
      }
      frameType = coded("frame_header.frame_type", 2, "show_existing_frame == 0");
      inferred("frame_header.frame_type_name", FRAME_TYPES[frameType], "derived from frame_type");
      showFrame = coded("frame_header.show_frame", 1, "show_existing_frame == 0");
      if (showFrame && sequenceContext.decoderModelInfoPresentFlag && !sequenceContext.equalPictureInterval) {
        coded(
          "frame_header.frame_presentation_time",
          sequenceContext.framePresentationTimeLengthMinus1 + 1,
          "show_frame && decoder_model_info_present_flag && !equal_picture_interval",
        );
      }
      showableFrame = showFrame
        ? inferred("frame_header.showable_frame", frameType === 0 ? 0 : 1, "show_frame == 1")
        : coded("frame_header.showable_frame", 1, "show_frame == 0");
      errorResilientMode = frameType === 3 || (frameType === 0 && showFrame)
        ? inferred("frame_header.error_resilient_mode", 1, "SWITCH_FRAME || (KEY_FRAME && show_frame)")
        : coded("frame_header.error_resilient_mode", 1, "otherwise");
    }

    const frameIsIntra = frameType === 0 || frameType === 2;
    inferred("frame_header.frame_is_intra", frameIsIntra ? 1 : 0, "derived from frame_type");
    coded("frame_header.disable_cdf_update", 1);

    let allowScreenContentTools;
    if (sequenceContext.seqForceScreenContentTools === 2) {
      allowScreenContentTools = coded(
        "frame_header.allow_screen_content_tools",
        1,
        "seq_force_screen_content_tools == SELECT_SCREEN_CONTENT_TOOLS",
      );
    } else {
      allowScreenContentTools = inferred(
        "frame_header.allow_screen_content_tools",
        sequenceContext.seqForceScreenContentTools,
        "seq_force_screen_content_tools != SELECT_SCREEN_CONTENT_TOOLS",
      );
    }
    let forceIntegerMv = 0;
    if (allowScreenContentTools) {
      forceIntegerMv = sequenceContext.seqForceIntegerMv === 2
        ? coded("frame_header.force_integer_mv", 1, "allow_screen_content_tools == 1")
        : inferred("frame_header.force_integer_mv", sequenceContext.seqForceIntegerMv, "fixed by sequence header");
    }
    if (frameIsIntra) {
      forceIntegerMv = 1;
      inferred("frame_header.effective_force_integer_mv", 1, "FrameIsIntra == 1");
    }

    let currentFrameId = null;
    if (sequenceContext.frameIdNumbersPresentFlag) {
      const idLength =
        sequenceContext.additionalFrameIdLengthMinus1 +
        sequenceContext.deltaFrameIdLengthMinus2 +
        3;
      currentFrameId = coded("frame_header.current_frame_id", idLength, "frame_id_numbers_present_flag == 1");
    }

    let frameSizeOverrideFlag;
    if (frameType === 3) {
      frameSizeOverrideFlag = inferred("frame_header.frame_size_override_flag", 1, "frame_type == SWITCH_FRAME");
    } else if (sequenceContext.reducedStillPictureHeader) {
      frameSizeOverrideFlag = inferred("frame_header.frame_size_override_flag", 0, "reduced_still_picture_header == 1");
    } else {
      frameSizeOverrideFlag = coded("frame_header.frame_size_override_flag", 1, "otherwise");
    }

    let orderHint = 0;
    if (sequenceContext.enableOrderHint) {
      orderHint = coded(
        "frame_header.order_hint",
        sequenceContext.orderHintBitsMinus1 + 1,
        "enable_order_hint == 1",
      );
    }
    let primaryRefFrame;
    if (frameIsIntra || errorResilientMode) {
      primaryRefFrame = inferred("frame_header.primary_ref_frame", 7, "FrameIsIntra || error_resilient_mode");
    } else {
      primaryRefFrame = coded("frame_header.primary_ref_frame", 3, "inter frame and not error resilient");
    }

    const bufferRemovalTimes = [];
    let bufferRemovalTimePresent = 0;
    if (sequenceContext.decoderModelInfoPresentFlag) {
      bufferRemovalTimePresent = coded("frame_header.buffer_removal_time_present_flag", 1);
      if (bufferRemovalTimePresent) {
        const temporalId = obu.header?.temporalId ?? obu.temporalId ?? 0;
        const spatialId = obu.header?.spatialId ?? obu.spatialId ?? 0;
        for (let index = 0; index < sequenceContext.operatingPoints.length; index += 1) {
          const point = sequenceContext.operatingPoints[index];
          if (point.decoderModelPresent && operatingPointIncludes(point.operatingPointIdc, temporalId, spatialId)) {
            bufferRemovalTimes[index] = coded(
              `frame_header.buffer_removal_time[${index}]`,
              sequenceContext.bufferRemovalTimeLengthMinus1 + 1,
              `decoder model present and OBU layer belongs to operating point ${index}`,
            );
          }
        }
      }
    } else {
      inferred("frame_header.buffer_removal_time_present_flag", 0, "decoder_model_info_present_flag == 0");
    }

    const refreshFrameFlags = frameType === 3 || (frameType === 0 && showFrame)
      ? inferred(
        "frame_header.refresh_frame_flags",
        255,
        "SWITCH_FRAME || (KEY_FRAME && show_frame)",
      )
      : coded("frame_header.refresh_frame_flags", 8, "otherwise");

    const refOrderHints = [];
    if ((!frameIsIntra || refreshFrameFlags !== 255) &&
        errorResilientMode && sequenceContext.enableOrderHint) {
      for (let index = 0; index < 8; index += 1) {
        refOrderHints[index] = coded(
          `frame_header.ref_order_hint[${index}]`,
          sequenceContext.orderHintBitsMinus1 + 1,
          "error_resilient_mode && enable_order_hint",
        );
      }
    }
    const invalidatedReferenceSlots = invalidatedSlotsFromOrderHints(referenceSlots, refOrderHints);
    const invalidatedReferenceSlotSet = new Set(invalidatedReferenceSlots);
    for (const index of invalidatedReferenceSlots) inferred(
      `frame_header.ref_valid_after_order_hint[${index}]`,
      0,
      `ref_order_hint[${index}] != stored RefOrderHint[${index}]`,
    );
    const referenceSlot = (slot) => invalidatedReferenceSlotSet.has(slot) ? null : referenceSlots[slot];

    const referenceSlotIndices = [];
    const referenceFrameIds = [];
    if (!frameIsIntra) {
      const shortSignaling = sequenceContext.enableOrderHint
        ? coded("frame_header.frame_refs_short_signaling", 1, "enable_order_hint == 1")
        : inferred("frame_header.frame_refs_short_signaling", 0, "enable_order_hint == 0");
      if (shortSignaling) {
        const last = coded("frame_header.last_frame_idx", 3, "frame_refs_short_signaling == 1");
        const gold = coded("frame_header.gold_frame_idx", 3, "frame_refs_short_signaling == 1");
        referenceSlotIndices.push(last, gold);
      }
      for (let index = 0; index < 7; index += 1) {
        if (!shortSignaling) {
          referenceSlotIndices.push(coded(
            `frame_header.ref_frame_idx[${index}]`,
            3,
            "frame_refs_short_signaling == 0",
          ));
        }
        if (sequenceContext.frameIdNumbersPresentFlag) {
          coded(
            `frame_header.delta_frame_id_minus_1[${index}]`,
            sequenceContext.deltaFrameIdLengthMinus2 + 2,
            "frame_id_numbers_present_flag == 1",
          );
        }
      }
      for (const slot of referenceSlotIndices) {
        const referenced = referenceSlot(slot);
        referenceFrameIds.push(referenced?.frameId ?? null);
      }
    }

    let frameWidth;
    let frameHeight;
    let renderWidth;
    let renderHeight;
    let foundReference = null;
    if (!frameIsIntra && frameSizeOverrideFlag && !errorResilientMode) {
      for (let index = 0; index < 7; index += 1) {
        const found = coded(
          `frame_header.found_ref[${index}]`,
          1,
          "inter frame_size_with_refs",
        );
        if (found) {
          foundReference = index;
          const slot = referenceSlotIndices[index];
          const referenced = referenceSlot(slot);
          frameWidth = referenced?.frameWidth ?? null;
          frameHeight = referenced?.frameHeight ?? null;
          renderWidth = referenced?.renderWidth ?? frameWidth;
          renderHeight = referenced?.renderHeight ?? frameHeight;
          inferred("frame_header.frame_width", frameWidth, `found_ref[${index}] == 1`);
          inferred("frame_header.frame_height", frameHeight, `found_ref[${index}] == 1`);
          inferred("frame_header.render_width", renderWidth, `found_ref[${index}] == 1`);
          inferred("frame_header.render_height", renderHeight, `found_ref[${index}] == 1`);
          break;
        }
      }
    }

    if (foundReference === null && frameSizeOverrideFlag) {
      frameWidth = coded(
        "frame_header.frame_width_minus_1",
        sequenceContext.frameWidthBitsMinus1 + 1,
        "frame_size_override_flag == 1",
      ) + 1;
      frameHeight = coded(
        "frame_header.frame_height_minus_1",
        sequenceContext.frameHeightBitsMinus1 + 1,
        "frame_size_override_flag == 1",
      ) + 1;
    } else if (foundReference === null) {
      frameWidth = sequenceContext.maxFrameWidthMinus1 + 1;
      frameHeight = sequenceContext.maxFrameHeightMinus1 + 1;
      inferred("frame_header.frame_width", frameWidth, "frame_size_override_flag == 0");
      inferred("frame_header.frame_height", frameHeight, "frame_size_override_flag == 0");
    }

    if (sequenceContext.enableSuperres) {
      const useSuperres = coded("frame_header.use_superres", 1, "enable_superres == 1");
      if (useSuperres) coded("frame_header.coded_denom", 3, "use_superres == 1");
    }
    if (foundReference === null) {
      const renderDifferent = coded("frame_header.render_and_frame_size_different", 1);
      if (renderDifferent) {
        renderWidth = coded("frame_header.render_width_minus_1", 16, "render_and_frame_size_different == 1") + 1;
        renderHeight = coded("frame_header.render_height_minus_1", 16, "render_and_frame_size_different == 1") + 1;
      } else {
        renderWidth = frameWidth;
        renderHeight = frameHeight;
        inferred("frame_header.render_width", renderWidth, "render_and_frame_size_different == 0");
        inferred("frame_header.render_height", renderHeight, "render_and_frame_size_different == 0");
      }
    }
    if (frameIsIntra && allowScreenContentTools) {
      coded("frame_header.allow_intrabc", 1, "FrameIsIntra && allow_screen_content_tools");
    }

    let allowIntrabc = valueFor(nodes, "frame_header.allow_intrabc", 0);
    let allowHighPrecisionMv = 0;
    if (!frameIsIntra) {
      if (!forceIntegerMv) allowHighPrecisionMv = coded("frame_header.allow_high_precision_mv", 1, "!force_integer_mv");
      else allowHighPrecisionMv = inferred("frame_header.allow_high_precision_mv", 0, "force_integer_mv == 1");
      const filterSwitchable = coded("frame_header.is_filter_switchable", 1);
      if (!filterSwitchable) coded("frame_header.interpolation_filter", 2, "is_filter_switchable == 0");
      if (sequenceContext.enableWarpedMotion && !errorResilientMode) {
        coded("frame_header.is_motion_mode_switchable", 1, "enable_warped_motion && !error_resilient_mode");
      } else {
        inferred("frame_header.is_motion_mode_switchable", 0, "warped motion disabled or error resilient");
      }
      if (sequenceContext.enableRefFrameMvs && !errorResilientMode) {
        coded("frame_header.use_ref_frame_mvs", 1, "enable_ref_frame_mvs && !error_resilient_mode");
      } else {
        inferred("frame_header.use_ref_frame_mvs", 0, "reference frame MVs disabled or error resilient");
      }
    }

    if (sequenceContext.reducedStillPictureHeader || valueFor(nodes, "frame_header.disable_cdf_update", 0)) {
      inferred("frame_header.disable_frame_end_update_cdf", 1, "reduced still picture or disable_cdf_update");
    } else {
      coded("frame_header.disable_frame_end_update_cdf", 1);
    }

    const miCols = 2 * Math.ceil(frameWidth / 8);
    const miRows = 2 * Math.ceil(frameHeight / 8);
    const sbCols = sequenceContext.use128x128Superblock
      ? Math.ceil(miCols / 32)
      : Math.ceil(miCols / 16);
    const sbRows = sequenceContext.use128x128Superblock
      ? Math.ceil(miRows / 32)
      : Math.ceil(miRows / 16);
    const sbSize = sequenceContext.use128x128Superblock ? 128 : 64;
    const maxTileWidthSb = 4096 / sbSize;
    const maxTileAreaSb = (4096 * 2304) / (sbSize * sbSize);
    const minLog2TileCols = tileLog2(maxTileWidthSb, sbCols);
    const maxLog2TileCols = tileLog2(1, Math.min(sbCols, 64));
    const maxLog2TileRows = tileLog2(1, Math.min(sbRows, 64));
    const minLog2Tiles = Math.max(minLog2TileCols, tileLog2(maxTileAreaSb, sbRows * sbCols));
    const uniformTiles = coded("frame_header.tile_info.uniform_tile_spacing_flag", 1);
    let tileColsLog2;
    let tileRowsLog2;
    const tileWidthsSb = [];
    const tileHeightsSb = [];
    if (uniformTiles) {
      tileColsLog2 = minLog2TileCols;
      while (tileColsLog2 < maxLog2TileCols) {
        if (!coded(`frame_header.tile_info.increment_tile_cols_log2[${tileColsLog2}]`, 1)) break;
        tileColsLog2 += 1;
      }
      const tileWidthSb = Math.ceil(sbCols / (2 ** tileColsLog2));
      for (let startSb = 0; startSb < sbCols; startSb += tileWidthSb) {
        tileWidthsSb.push(Math.min(tileWidthSb, sbCols - startSb));
      }
      const minLog2TileRows = Math.max(minLog2Tiles - tileColsLog2, 0);
      tileRowsLog2 = minLog2TileRows;
      while (tileRowsLog2 < maxLog2TileRows) {
        if (!coded(`frame_header.tile_info.increment_tile_rows_log2[${tileRowsLog2}]`, 1)) break;
        tileRowsLog2 += 1;
      }
      const tileHeightSb = Math.ceil(sbRows / (2 ** tileRowsLog2));
      for (let startSb = 0; startSb < sbRows; startSb += tileHeightSb) {
        tileHeightsSb.push(Math.min(tileHeightSb, sbRows - startSb));
      }
    } else {
      let widestTileSb = 0;
      for (let startSb = 0, column = 0; startSb < sbCols; column += 1) {
        const maxWidth = Math.min(sbCols - startSb, maxTileWidthSb);
        const sizeSb = nonSymmetric(
          `frame_header.tile_info.width_in_sbs_minus_1[${column}]`,
          maxWidth,
          "uniform_tile_spacing_flag == 0",
        ) + 1;
        tileWidthsSb.push(sizeSb);
        widestTileSb = Math.max(widestTileSb, sizeSb);
        startSb += sizeSb;
      }
      tileColsLog2 = tileLog2(1, tileWidthsSb.length);
      const constrainedAreaSb = minLog2Tiles > 0
        ? Math.floor((sbRows * sbCols) / (2 ** (minLog2Tiles + 1)))
        : sbRows * sbCols;
      const maxTileHeightSb = Math.max(Math.floor(constrainedAreaSb / widestTileSb), 1);
      for (let startSb = 0, row = 0; startSb < sbRows; row += 1) {
        const maxHeight = Math.min(sbRows - startSb, maxTileHeightSb);
        const sizeSb = nonSymmetric(
          `frame_header.tile_info.height_in_sbs_minus_1[${row}]`,
          maxHeight,
          "uniform_tile_spacing_flag == 0",
        ) + 1;
        tileHeightsSb.push(sizeSb);
        startSb += sizeSb;
      }
      tileRowsLog2 = tileLog2(1, tileHeightsSb.length);
    }
    inferred("frame_header.tile_info.tile_cols_log2", tileColsLog2, "derived from tile_info");
    inferred("frame_header.tile_info.tile_rows_log2", tileRowsLog2, "derived from tile_info");
    inferred("frame_header.tile_info.tile_widths_sb", tileWidthsSb, "derived from tile_info");
    inferred("frame_header.tile_info.tile_heights_sb", tileHeightsSb, "derived from tile_info");
    const tileBits = tileColsLog2 + tileRowsLog2;
    let tileSizeBytes = 0;
    if (tileBits > 0) {
      coded("frame_header.tile_info.context_update_tile_id", tileBits, "more than one tile");
      tileSizeBytes = coded(
        "frame_header.tile_info.tile_size_bytes_minus_1",
        2,
        "more than one tile",
      ) + 1;
    }

    const baseQIdx = coded("frame_header.quantization.base_q_idx", 8);
    const deltaQYDc = readDeltaQ("frame_header.quantization.delta_q_y_dc");
    let deltaQUDc = 0;
    let deltaQUAc = 0;
    let deltaQVDc = 0;
    let deltaQVAc = 0;
    if (sequenceContext.numPlanes > 1) {
      const diffUvDelta = sequenceContext.separateUvDeltaQ
        ? coded("frame_header.quantization.diff_uv_delta", 1, "separate_uv_delta_q == 1")
        : inferred("frame_header.quantization.diff_uv_delta", 0, "separate_uv_delta_q == 0");
      deltaQUDc = readDeltaQ("frame_header.quantization.delta_q_u_dc");
      deltaQUAc = readDeltaQ("frame_header.quantization.delta_q_u_ac");
      if (diffUvDelta) {
        deltaQVDc = readDeltaQ("frame_header.quantization.delta_q_v_dc");
        deltaQVAc = readDeltaQ("frame_header.quantization.delta_q_v_ac");
      } else {
        deltaQVDc = deltaQUDc;
        deltaQVAc = deltaQUAc;
      }
    }
    const usingQmatrix = coded("frame_header.quantization.using_qmatrix", 1);
    if (usingQmatrix) {
      coded("frame_header.quantization.qm_y", 4, "using_qmatrix == 1");
      coded("frame_header.quantization.qm_u", 4, "using_qmatrix == 1");
      if (sequenceContext.separateUvDeltaQ) coded("frame_header.quantization.qm_v", 4, "using_qmatrix && separate_uv_delta_q");
    }

    const emptySegmentation = () => Array.from(
      { length: 8 },
      () => Array.from({ length: 8 }, () => ({ enabled: false, value: 0 })),
    );
    const previousSegmentation = primaryRefFrame === 7
      ? null
      : referenceSlot(referenceSlotIndices[primaryRefFrame])?.segmentation;
    let segmentation = previousSegmentation
      ? previousSegmentation.map((features) => features.map((feature) => ({ ...feature })))
      : emptySegmentation();
    const segmentationEnabled = coded("frame_header.segmentation.segmentation_enabled", 1);
    let segmentationUpdateMap = 0;
    let segmentationTemporalUpdate = 0;
    let segmentationUpdateData = 0;
    if (segmentationEnabled) {
      if (primaryRefFrame === 7) {
        segmentationUpdateMap = inferred("frame_header.segmentation.segmentation_update_map", 1, "primary_ref_frame == PRIMARY_REF_NONE");
        segmentationTemporalUpdate = inferred("frame_header.segmentation.segmentation_temporal_update", 0, "primary_ref_frame == PRIMARY_REF_NONE");
        segmentationUpdateData = inferred("frame_header.segmentation.segmentation_update_data", 1, "primary_ref_frame == PRIMARY_REF_NONE");
      } else {
        segmentationUpdateMap = coded("frame_header.segmentation.segmentation_update_map", 1, "primary_ref_frame != PRIMARY_REF_NONE");
        segmentationTemporalUpdate = segmentationUpdateMap
          ? coded("frame_header.segmentation.segmentation_temporal_update", 1, "segmentation_update_map == 1")
          : inferred("frame_header.segmentation.segmentation_temporal_update", 0, "segmentation_update_map == 0");
        segmentationUpdateData = coded("frame_header.segmentation.segmentation_update_data", 1, "primary_ref_frame != PRIMARY_REF_NONE");
      }
      if (segmentationUpdateData) {
        segmentation = emptySegmentation();
        for (let segment = 0; segment < 8; segment += 1) {
          for (let feature = 0; feature < 8; feature += 1) {
            const prefix = `frame_header.segmentation.segment[${segment}].${SEGMENT_FEATURE_NAMES[feature]}`;
            const enabled = coded(`${prefix}.feature_enabled`, 1, "segmentation_update_data == 1");
            let value = 0;
            if (enabled && SEGMENT_FEATURE_BITS[feature] > 0) {
              const bits = SEGMENT_FEATURE_BITS[feature];
              value = SEGMENT_FEATURE_SIGNED[feature]
                ? signed(`${prefix}.feature_value`, bits + 1, `${prefix}.feature_enabled == 1`)
                : coded(`${prefix}.feature_value`, bits, `${prefix}.feature_enabled == 1`);
            }
            segmentation[segment][feature] = { enabled: Boolean(enabled), value };
          }
        }
      }
    }
    const deltaQPresent = baseQIdx > 0
      ? coded("frame_header.delta_q.delta_q_present", 1, "base_q_idx > 0")
      : inferred("frame_header.delta_q.delta_q_present", 0, "base_q_idx == 0");
    if (deltaQPresent) coded("frame_header.delta_q.delta_q_res", 2, "delta_q_present == 1");
    if (deltaQPresent && !allowIntrabc) {
      const deltaLfPresent = coded("frame_header.delta_lf.delta_lf_present", 1, "delta_q_present && !allow_intrabc");
      if (deltaLfPresent) {
        coded("frame_header.delta_lf.delta_lf_res", 2, "delta_lf_present == 1");
        coded("frame_header.delta_lf.delta_lf_multi", 1, "delta_lf_present == 1");
      }
    }

    const segmentQIndex = (segment) => {
      const altQ = segmentationEnabled ? segmentation[segment][0] : null;
      return Math.max(0, Math.min(255, baseQIdx + (altQ?.enabled ? altQ.value : 0)));
    };
    const segmentLossless = (segment) => segmentQIndex(segment) === 0 && deltaQYDc === 0 &&
      deltaQUDc === 0 && deltaQUAc === 0 && deltaQVDc === 0 && deltaQVAc === 0;
    const codedLossless = Array.from({ length: 8 }, (_, segment) => segmentLossless(segment)).every(Boolean);
    const allLossless = codedLossless && !valueFor(nodes, "frame_header.use_superres", 0);
    inferred("frame_header.coded_lossless", codedLossless ? 1 : 0, "all segments are lossless");
    inferred("frame_header.all_lossless", allLossless ? 1 : 0, "derived from all segment quantizers");
    const loopFilterLevels = [0, 0, 0, 0];
    if (!codedLossless && !allowIntrabc) {
      loopFilterLevels[0] = coded("frame_header.loop_filter.loop_filter_level[0]", 6);
      loopFilterLevels[1] = coded("frame_header.loop_filter.loop_filter_level[1]", 6);
      if (sequenceContext.numPlanes > 1 && (loopFilterLevels[0] || loopFilterLevels[1])) {
        loopFilterLevels[2] = coded("frame_header.loop_filter.loop_filter_level[2]", 6);
        loopFilterLevels[3] = coded("frame_header.loop_filter.loop_filter_level[3]", 6);
      }
      coded("frame_header.loop_filter.loop_filter_sharpness", 3);
      const deltaEnabled = coded("frame_header.loop_filter.loop_filter_delta_enabled", 1);
      if (deltaEnabled) {
        const deltaUpdate = coded("frame_header.loop_filter.loop_filter_delta_update", 1, "loop_filter_delta_enabled == 1");
        if (deltaUpdate) {
          for (let index = 0; index < 8; index += 1) {
            const update = coded(`frame_header.loop_filter.update_ref_delta[${index}]`, 1);
            if (update) signed(`frame_header.loop_filter.loop_filter_ref_deltas[${index}]`, 7);
          }
          for (let index = 0; index < 2; index += 1) {
            const update = coded(`frame_header.loop_filter.update_mode_delta[${index}]`, 1);
            if (update) signed(`frame_header.loop_filter.loop_filter_mode_deltas[${index}]`, 7);
          }
        }
      }
    }

    let cdefBits = 0;
    if (!codedLossless && !allowIntrabc && sequenceContext.enableCdef) {
      coded("frame_header.cdef.cdef_damping_minus_3", 2);
      cdefBits = coded("frame_header.cdef.cdef_bits", 2);
      for (let index = 0; index < (1 << cdefBits); index += 1) {
        coded(`frame_header.cdef.cdef_y_pri_strength[${index}]`, 4);
        coded(`frame_header.cdef.cdef_y_sec_strength[${index}]`, 2);
        if (sequenceContext.numPlanes > 1) {
          coded(`frame_header.cdef.cdef_uv_pri_strength[${index}]`, 4);
          coded(`frame_header.cdef.cdef_uv_sec_strength[${index}]`, 2);
        }
      }
    }

    const restorationTypes = Array(sequenceContext.numPlanes).fill("RESTORE_NONE");
    const loopRestorationSizes = Array(sequenceContext.numPlanes).fill(null);
    let usesLoopRestoration = false;
    let usesChromaLoopRestoration = false;
    let lrUnitShift = 0;
    let lrUvShift = 0;
    if (!allLossless && !allowIntrabc && sequenceContext.enableRestoration) {
      for (let plane = 0; plane < sequenceContext.numPlanes; plane += 1) {
        const lrType = coded(`frame_header.loop_restoration.lr_type[${plane}]`, 2);
        restorationTypes[plane] = RESTORATION_TYPE_NAMES[lrType];
        if (lrType !== 0) {
          usesLoopRestoration = true;
          if (plane > 0) usesChromaLoopRestoration = true;
        }
      }
      if (usesLoopRestoration) {
        lrUnitShift = coded("frame_header.loop_restoration.lr_unit_shift", 1, "UsesLr == 1");
        if (sequenceContext.use128x128Superblock) {
          lrUnitShift += 1;
        } else if (lrUnitShift) {
          lrUnitShift += coded(
            "frame_header.loop_restoration.lr_unit_extra_shift",
            1,
            "lr_unit_shift == 1 && use_128x128_superblock == 0",
          );
        }
        loopRestorationSizes[0] = 256 >> (2 - lrUnitShift);
        if (sequenceContext.subsamplingX && sequenceContext.subsamplingY && usesChromaLoopRestoration) {
          lrUvShift = coded(
            "frame_header.loop_restoration.lr_uv_shift",
            1,
            "subsampling_x && subsampling_y && usesChromaLr",
          );
        }
        for (let plane = 1; plane < sequenceContext.numPlanes; plane += 1) {
          loopRestorationSizes[plane] = loopRestorationSizes[0] >> lrUvShift;
        }
      }
    }

    let txMode;
    if (codedLossless) {
      txMode = "ONLY_4X4";
      inferred("frame_header.tx_mode", txMode, "CodedLossless == 1");
    } else {
      const txModeSelect = coded("frame_header.tx_mode_select", 1, "CodedLossless == 0");
      txMode = txModeSelect ? "TX_MODE_SELECT" : "TX_MODE_LARGEST";
      inferred("frame_header.tx_mode", txMode, "derived from tx_mode_select");
    }

    const referenceSelect = frameIsIntra
      ? inferred("frame_header.reference_select", 0, "FrameIsIntra == 1")
      : coded("frame_header.reference_select", 1, "FrameIsIntra == 0");
    let skipModeAllowed = false;
    const skipModeSlotIndices = [];
    if (!frameIsIntra && referenceSelect && sequenceContext.enableOrderHint) {
      let forward = null;
      let backward = null;
      for (let index = 0; index < referenceSlotIndices.length; index += 1) {
        const slot = referenceSlotIndices[index];
        const hint = referenceSlot(slot)?.orderHint;
        if (hint === undefined || hint === null) continue;
        const distance = relativeDistance(hint, orderHint);
        if (distance < 0 && (!forward || relativeDistance(hint, forward.hint) > 0)) {
          forward = { index, slot, hint };
        } else if (distance > 0 && (!backward || relativeDistance(hint, backward.hint) < 0)) {
          backward = { index, slot, hint };
        }
      }
      if (forward && backward) {
        skipModeAllowed = true;
        skipModeSlotIndices.push(forward.slot, backward.slot);
      } else if (forward) {
        let secondForward = null;
        for (let index = 0; index < referenceSlotIndices.length; index += 1) {
          const slot = referenceSlotIndices[index];
          const hint = referenceSlot(slot)?.orderHint;
          if (hint === undefined || hint === null || relativeDistance(hint, forward.hint) >= 0) continue;
          if (!secondForward || relativeDistance(hint, secondForward.hint) > 0) {
            secondForward = { index, slot, hint };
          }
        }
        if (secondForward) {
          skipModeAllowed = true;
          skipModeSlotIndices.push(forward.slot, secondForward.slot);
        }
      }
    }
    inferred("frame_header.skip_mode_allowed", skipModeAllowed ? 1 : 0, "derived from reference order hints");
    const skipModePresent = skipModeAllowed
      ? coded("frame_header.skip_mode_present", 1, "skipModeAllowed == 1")
      : inferred("frame_header.skip_mode_present", 0, "skipModeAllowed == 0");
    const allowWarpedMotion = frameIsIntra || errorResilientMode || !sequenceContext.enableWarpedMotion
      ? inferred("frame_header.allow_warped_motion", 0, "FrameIsIntra || error_resilient_mode || !enable_warped_motion")
      : coded("frame_header.allow_warped_motion", 1, "inter frame with warped motion enabled");
    const reducedTxSet = coded("frame_header.reduced_tx_set", 1);

    const identityMotionParams = () => [0, 0, 65536, 0, 0, 65536];
    const globalMotionTypes = Array(7).fill("IDENTITY");
    const globalMotionParams = Array.from({ length: 7 }, identityMotionParams);
    const primarySlot = primaryRefFrame === 7 ? null : referenceSlotIndices[primaryRefFrame];
    const previousGlobalMotion = primarySlot === null
      ? null
      : referenceSlot(primarySlot)?.globalMotionParams;
    const readGlobalParam = (type, reference, parameter) => {
      let absoluteBits = 12;
      let precisionBits = 15;
      if (parameter < 2) {
        if (type === "TRANSLATION") {
          absoluteBits = 9 - (allowHighPrecisionMv ? 0 : 1);
          precisionBits = 3 - (allowHighPrecisionMv ? 0 : 1);
        } else {
          absoluteBits = 12;
          precisionBits = 6;
        }
      }
      const precisionDifference = 16 - precisionBits;
      const round = parameter % 3 === 2 ? 65536 : 0;
      const subtract = parameter % 3 === 2 ? 2 ** precisionBits : 0;
      const maximum = 2 ** absoluteBits;
      const previous = previousGlobalMotion?.[reference]?.[parameter] ?? identityMotionParams()[parameter];
      const predictor = Math.floor(previous / (2 ** precisionDifference)) - subtract;
      const decoded = readSignedSubexp(
        `frame_header.global_motion.gm_params[${reference + 1}][${parameter}]`,
        -maximum,
        maximum + 1,
        predictor,
        `global motion type ${type}`,
      );
      globalMotionParams[reference][parameter] = decoded * (2 ** precisionDifference) + round;
    };
    if (!frameIsIntra) {
      for (let reference = 0; reference < 7; reference += 1) {
        const isGlobal = coded(`frame_header.global_motion.is_global[${reference + 1}]`, 1);
        if (isGlobal) {
          const isRotZoom = coded(`frame_header.global_motion.is_rot_zoom[${reference + 1}]`, 1, "is_global == 1");
          if (isRotZoom) globalMotionTypes[reference] = "ROTZOOM";
          else {
            const isTranslation = coded(
              `frame_header.global_motion.is_translation[${reference + 1}]`,
              1,
              "is_global == 1 && is_rot_zoom == 0",
            );
            globalMotionTypes[reference] = isTranslation ? "TRANSLATION" : "AFFINE";
          }
          const type = globalMotionTypes[reference];
          if (type === "ROTZOOM" || type === "AFFINE") {
            readGlobalParam(type, reference, 2);
            readGlobalParam(type, reference, 3);
            if (type === "AFFINE") {
              readGlobalParam(type, reference, 4);
              readGlobalParam(type, reference, 5);
            } else {
              globalMotionParams[reference][4] = -globalMotionParams[reference][3];
              globalMotionParams[reference][5] = globalMotionParams[reference][2];
            }
          }
          readGlobalParam(type, reference, 0);
          readGlobalParam(type, reference, 1);
        }
      }
    }

    let filmGrain = { applyGrain: false };
    if (sequenceContext.filmGrainParamsPresent && (showFrame || showableFrame)) {
      const applyGrain = coded("frame_header.film_grain.apply_grain", 1);
      filmGrain = { applyGrain: Boolean(applyGrain) };
      if (applyGrain) {
        const grainSeed = coded("frame_header.film_grain.grain_seed", 16, "apply_grain == 1");
        const updateGrain = frameType === 1
          ? coded("frame_header.film_grain.update_grain", 1, "frame_type == INTER_FRAME")
          : inferred("frame_header.film_grain.update_grain", 1, "frame_type != INTER_FRAME");
        if (!updateGrain) {
          const referenceIndex = coded(
            "frame_header.film_grain.film_grain_params_ref_idx",
            3,
            "update_grain == 0",
          );
          const referenced = referenceSlot(referenceIndex)?.filmGrain;
          filmGrain = referenced
            ? { ...structuredClone(referenced), applyGrain: true, grainSeed, updateGrain: false, referenceIndex }
            : { applyGrain: true, grainSeed, updateGrain: false, referenceIndex, referenceMissing: true };
        } else {
          const readPoints = (plane, count) => Array.from({ length: count }, (_, index) => ({
            value: coded(`frame_header.film_grain.point_${plane}_value[${index}]`, 8),
            scaling: coded(`frame_header.film_grain.point_${plane}_scaling[${index}]`, 8),
          }));
          const numYPoints = coded("frame_header.film_grain.num_y_points", 4);
          if (numYPoints > 14) {
            diagnostics.push(diagnostic(
              "FILM_GRAIN_Y_POINTS_INVALID",
              Severity.ERROR,
              `Film grain declares ${numYPoints} luma points; the maximum is 14`,
              { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
            ));
          }
          const yPoints = readPoints("y", numYPoints);
          const chromaScalingFromLuma = sequenceContext.numPlanes === 1
            ? inferred("frame_header.film_grain.chroma_scaling_from_luma", 0, "mono_chrome == 1")
            : coded("frame_header.film_grain.chroma_scaling_from_luma", 1, "mono_chrome == 0");
          let numCbPoints = 0;
          let numCrPoints = 0;
          let cbPoints = [];
          let crPoints = [];
          if (!(sequenceContext.numPlanes === 1 || chromaScalingFromLuma ||
              (sequenceContext.subsamplingX && sequenceContext.subsamplingY && numYPoints === 0))) {
            numCbPoints = coded("frame_header.film_grain.num_cb_points", 4);
            if (numCbPoints > 10) diagnostics.push(diagnostic(
              "FILM_GRAIN_CB_POINTS_INVALID", Severity.ERROR,
              `Film grain declares ${numCbPoints} Cb points; the maximum is 10`,
              { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
            ));
            cbPoints = readPoints("cb", numCbPoints);
            numCrPoints = coded("frame_header.film_grain.num_cr_points", 4);
            if (numCrPoints > 10) diagnostics.push(diagnostic(
              "FILM_GRAIN_CR_POINTS_INVALID", Severity.ERROR,
              `Film grain declares ${numCrPoints} Cr points; the maximum is 10`,
              { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
            ));
            crPoints = readPoints("cr", numCrPoints);
          } else {
            inferred("frame_header.film_grain.num_cb_points", 0, "chroma points inferred absent");
            inferred("frame_header.film_grain.num_cr_points", 0, "chroma points inferred absent");
          }
          for (const [plane, points] of [["Y", yPoints], ["Cb", cbPoints], ["Cr", crPoints]]) {
            if (points.some((point, index) => index > 0 && point.value <= points[index - 1].value)) {
              diagnostics.push(diagnostic(
                `FILM_GRAIN_${plane.toUpperCase()}_POINTS_NOT_INCREASING`, Severity.ERROR,
                `Film grain ${plane} control-point values must be strictly increasing`,
                { range: byteRange(start, length), frameId: obu.frameId, obuId: obu.obuId },
              ));
            }
          }
          const grainScalingMinus8 = coded("frame_header.film_grain.grain_scaling_minus_8", 2);
          const arCoeffLag = coded("frame_header.film_grain.ar_coeff_lag", 2);
          const numPosLuma = 2 * arCoeffLag * (arCoeffLag + 1);
          const numPosChroma = numYPoints ? numPosLuma + 1 : numPosLuma;
          const readCoefficients = (plane, count) => Array.from(
            { length: count },
            (_, index) => coded(`frame_header.film_grain.ar_coeffs_${plane}_plus_128[${index}]`, 8),
          );
          const arCoefficientsY = numYPoints ? readCoefficients("y", numPosLuma) : [];
          const arCoefficientsCb = chromaScalingFromLuma || numCbPoints
            ? readCoefficients("cb", numPosChroma) : [];
          const arCoefficientsCr = chromaScalingFromLuma || numCrPoints
            ? readCoefficients("cr", numPosChroma) : [];
          const arCoeffShiftMinus6 = coded("frame_header.film_grain.ar_coeff_shift_minus_6", 2);
          const grainScaleShift = coded("frame_header.film_grain.grain_scale_shift", 2);
          let cbMult = null;
          let cbLumaMult = null;
          let cbOffset = null;
          let crMult = null;
          let crLumaMult = null;
          let crOffset = null;
          if (numCbPoints) {
            cbMult = coded("frame_header.film_grain.cb_mult", 8);
            cbLumaMult = coded("frame_header.film_grain.cb_luma_mult", 8);
            cbOffset = coded("frame_header.film_grain.cb_offset", 9);
          }
          if (numCrPoints) {
            crMult = coded("frame_header.film_grain.cr_mult", 8);
            crLumaMult = coded("frame_header.film_grain.cr_luma_mult", 8);
            crOffset = coded("frame_header.film_grain.cr_offset", 9);
          }
          const overlapFlag = coded("frame_header.film_grain.overlap_flag", 1);
          const clipToRestrictedRange = coded("frame_header.film_grain.clip_to_restricted_range", 1);
          filmGrain = {
            applyGrain: true, grainSeed, updateGrain: true, yPoints, chromaScalingFromLuma: Boolean(chromaScalingFromLuma),
            cbPoints, crPoints, grainScalingMinus8, arCoeffLag, arCoefficientsY, arCoefficientsCb,
            arCoefficientsCr, arCoeffShiftMinus6, grainScaleShift, cbMult, cbLumaMult, cbOffset,
            crMult, crLumaMult, crOffset, overlapFlag: Boolean(overlapFlag),
            clipToRestrictedRange: Boolean(clipToRestrictedRange),
          };
        }
      }
    }

    return {
      nodes,
      diagnostics,
      nextSyntaxNodeId,
      parsedBitLength: reader.position,
      status: "partial",
      summary: {
        showExistingFrame,
        frameType,
        frameTypeName: FRAME_TYPES[frameType],
        showFrame,
        showableFrame,
        errorResilientMode,
        forceIntegerMv,
        refreshFrameFlags,
        referenceSlotIndices,
        referenceFrameIds,
        invalidatedReferenceSlots,
        frameWidth,
        frameHeight,
        currentFrameId,
        orderHint,
        renderWidth,
        renderHeight,
        baseQIdx,
        uniformTiles: Boolean(uniformTiles),
        tileCols: tileWidthsSb.length,
        tileRows: tileHeightsSb.length,
        tileColsLog2,
        tileRowsLog2,
        tileSizeBytes,
        tileWidthsSb,
        tileHeightsSb,
        loopFilterLevels,
        cdefBits,
        segmentationEnabled,
        segmentationUpdateMap,
        segmentationTemporalUpdate,
        segmentationUpdateData,
        segmentation,
        codedLossless,
        allLossless,
        restorationTypes,
        usesLoopRestoration,
        lrUnitShift,
        lrUvShift,
        loopRestorationSizes,
        txMode,
        referenceSelect,
        skipModeAllowed,
        skipModePresent,
        skipModeSlotIndices,
        allowWarpedMotion,
        reducedTxSet,
        globalMotionTypes,
        globalMotionParams,
        filmGrain,
        framePresentationTime: valueFor(nodes, "frame_header.frame_presentation_time", null),
        bufferRemovalTimePresent: Boolean(bufferRemovalTimePresent),
        bufferRemovalTimes,
      },
    };
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    diagnostics.push(
      diagnostic(
        "FRAME_HEADER_TRUNCATED",
        Severity.ERROR,
        `Frame Header ended while reading its prefix: ${error.message}`,
        {
          range: byteRange(start, Math.min(length, Math.ceil(reader.position / 8))),
          frameId: obu.frameId,
          obuId: obu.obuId,
        },
      ),
    );
    return {
      nodes,
      diagnostics,
      nextSyntaxNodeId,
      parsedBitLength: reader.position,
      status: "error",
    };
  }
}
