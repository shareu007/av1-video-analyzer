import { BitReader } from "./bit-reader.js";
import { SCHEMA_VERSION, Severity, byteRange, diagnostic } from "./model.js";

function bitRange(startBit, lengthBits) {
  return { startBit, lengthBits };
}

export function parseSequenceHeader(
  buffer,
  obu,
  { nextSyntaxNodeId = 0 } = {},
) {
  const nodes = [];
  const diagnostics = [];
  const { start, length } = obu.payloadRange;
  const reader = new BitReader(buffer, { startByte: start, lengthBytes: length });
  const baseBit = start * 8;

  function field(path, width, presence = "true") {
    const relativeStart = reader.position;
    const value = reader.readBits(width);
    const node = {
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId,
      obuId: obu.obuId,
      path,
      value,
      coding: `f(${width})`,
      presence,
      bitRange: bitRange(baseBit + relativeStart, width),
      specAnchor: "AV1 §5.5.1 General sequence header OBU syntax",
    };
    nextSyntaxNodeId += 1;
    nodes.push(node);
    return value;
  }

  function uvlc(path, presence) {
    const relativeStart = reader.position;
    let leadingZeros = 0;
    while (reader.readBit() === 0) {
      leadingZeros += 1;
      if (leadingZeros >= 32) {
        const value = 0xffff_ffff;
        nodes.push({
          schemaVersion: SCHEMA_VERSION,
          nodeId: nextSyntaxNodeId,
          obuId: obu.obuId,
          path,
          value,
          coding: "uvlc()",
          presence,
          bitRange: bitRange(
            baseBit + relativeStart,
            reader.position - relativeStart,
          ),
          specAnchor: "AV1 §4.10.3 UVLC syntax",
        });
        nextSyntaxNodeId += 1;
        return value;
      }
    }
    const suffix = leadingZeros === 0 ? 0 : reader.readBits(leadingZeros);
    const value = 2 ** leadingZeros - 1 + suffix;
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId,
      obuId: obu.obuId,
      path,
      value,
      coding: "uvlc()",
      presence,
      bitRange: bitRange(
        baseBit + relativeStart,
        reader.position - relativeStart,
      ),
      specAnchor: "AV1 §4.10.3 UVLC syntax",
    });
    nextSyntaxNodeId += 1;
    return value;
  }

  try {
    const seqProfile = field("sequence_header.seq_profile", 3);
    field("sequence_header.still_picture", 1);
    const reduced = field(
      "sequence_header.reduced_still_picture_header",
      1,
    );

    let decoderModelInfoPresent = 0;
    let initialDisplayDelayPresent = 0;
    let operatingPointsCountMinus1 = 0;
    let bufferDelayLengthMinus1 = null;

    if (reduced) {
      field(
        "sequence_header.operating_points[0].seq_level_idx",
        5,
        "reduced_still_picture_header == 1",
      );
    } else {
      const timingInfoPresent = field(
        "sequence_header.timing_info_present_flag",
        1,
        "reduced_still_picture_header == 0",
      );
      if (timingInfoPresent) {
        field(
          "sequence_header.timing_info.num_units_in_display_tick",
          32,
          "timing_info_present_flag == 1",
        );
        field(
          "sequence_header.timing_info.time_scale",
          32,
          "timing_info_present_flag == 1",
        );
        const equalPictureInterval = field(
          "sequence_header.timing_info.equal_picture_interval",
          1,
          "timing_info_present_flag == 1",
        );
        if (equalPictureInterval) {
          uvlc(
            "sequence_header.timing_info.num_ticks_per_picture_minus_1",
            "equal_picture_interval == 1",
          );
        }
        decoderModelInfoPresent = field(
          "sequence_header.decoder_model_info_present_flag",
          1,
          "timing_info_present_flag == 1",
        );
        if (decoderModelInfoPresent) {
          bufferDelayLengthMinus1 = field(
            "sequence_header.decoder_model_info.buffer_delay_length_minus_1",
            5,
            "decoder_model_info_present_flag == 1",
          );
          field(
            "sequence_header.decoder_model_info.num_units_in_decoding_tick",
            32,
            "decoder_model_info_present_flag == 1",
          );
          field(
            "sequence_header.decoder_model_info.buffer_removal_time_length_minus_1",
            5,
            "decoder_model_info_present_flag == 1",
          );
          field(
            "sequence_header.decoder_model_info.frame_presentation_time_length_minus_1",
            5,
            "decoder_model_info_present_flag == 1",
          );
        }
      }

      initialDisplayDelayPresent = field(
        "sequence_header.initial_display_delay_present_flag",
        1,
        "reduced_still_picture_header == 0",
      );
      operatingPointsCountMinus1 = field(
        "sequence_header.operating_points_cnt_minus_1",
        5,
        "reduced_still_picture_header == 0",
      );
      for (let index = 0; index <= operatingPointsCountMinus1; index += 1) {
        const prefix = `sequence_header.operating_points[${index}]`;
        field(`${prefix}.operating_point_idc`, 12, "operating point loop");
        const level = field(`${prefix}.seq_level_idx`, 5, "operating point loop");
        if (level > 7) {
          field(`${prefix}.seq_tier`, 1, "seq_level_idx > 7");
        }
        if (decoderModelInfoPresent) {
          const modelPresent = field(
            `${prefix}.decoder_model_present_for_this_op`,
            1,
            "decoder_model_info_present_flag == 1",
          );
          if (modelPresent) {
            const delayWidth = bufferDelayLengthMinus1 + 1;
            field(
              `${prefix}.decoder_buffer_delay`,
              delayWidth,
              "decoder_model_present_for_this_op == 1",
            );
            field(
              `${prefix}.encoder_buffer_delay`,
              delayWidth,
              "decoder_model_present_for_this_op == 1",
            );
            field(
              `${prefix}.low_delay_mode_flag`,
              1,
              "decoder_model_present_for_this_op == 1",
            );
          }
        }
        if (initialDisplayDelayPresent) {
          const delayPresent = field(
            `${prefix}.initial_display_delay_present_for_this_op`,
            1,
            "initial_display_delay_present_flag == 1",
          );
          if (delayPresent) {
            field(
              `${prefix}.initial_display_delay_minus_1`,
              4,
              "initial_display_delay_present_for_this_op == 1",
            );
          }
        }
      }
    }

    const widthBitsMinus1 = field(
      "sequence_header.frame_width_bits_minus_1",
      4,
    );
    const heightBitsMinus1 = field(
      "sequence_header.frame_height_bits_minus_1",
      4,
    );
    field(
      "sequence_header.max_frame_width_minus_1",
      widthBitsMinus1 + 1,
    );
    field(
      "sequence_header.max_frame_height_minus_1",
      heightBitsMinus1 + 1,
    );

    if (!reduced) {
      const frameIdNumbersPresent = field(
        "sequence_header.frame_id_numbers_present_flag",
        1,
        "reduced_still_picture_header == 0",
      );
      if (frameIdNumbersPresent) {
        field(
          "sequence_header.delta_frame_id_length_minus_2",
          4,
          "frame_id_numbers_present_flag == 1",
        );
        field(
          "sequence_header.additional_frame_id_length_minus_1",
          3,
          "frame_id_numbers_present_flag == 1",
        );
      }
    }

    field("sequence_header.use_128x128_superblock", 1);
    field("sequence_header.enable_filter_intra", 1);
    field("sequence_header.enable_intra_edge_filter", 1);

    let enableOrderHint = 0;
    if (!reduced) {
      field("sequence_header.enable_interintra_compound", 1);
      field("sequence_header.enable_masked_compound", 1);
      field("sequence_header.enable_warped_motion", 1);
      field("sequence_header.enable_dual_filter", 1);
      enableOrderHint = field("sequence_header.enable_order_hint", 1);
      if (enableOrderHint) {
        field(
          "sequence_header.enable_jnt_comp",
          1,
          "enable_order_hint == 1",
        );
        field(
          "sequence_header.enable_ref_frame_mvs",
          1,
          "enable_order_hint == 1",
        );
      }
      const chooseScreenContentTools = field(
        "sequence_header.seq_choose_screen_content_tools",
        1,
      );
      let forceScreenContentTools = 2;
      if (!chooseScreenContentTools) {
        forceScreenContentTools = field(
          "sequence_header.seq_force_screen_content_tools",
          1,
          "seq_choose_screen_content_tools == 0",
        );
      }
      if (forceScreenContentTools > 0) {
        const chooseIntegerMv = field(
          "sequence_header.seq_choose_integer_mv",
          1,
          "seq_force_screen_content_tools > 0",
        );
        if (!chooseIntegerMv) {
          field(
            "sequence_header.seq_force_integer_mv",
            1,
            "seq_choose_integer_mv == 0",
          );
        }
      }
      if (enableOrderHint) {
        field(
          "sequence_header.order_hint_bits_minus_1",
          3,
          "enable_order_hint == 1",
        );
      }
    }

    field("sequence_header.enable_superres", 1);
    field("sequence_header.enable_cdef", 1);
    field("sequence_header.enable_restoration", 1);

    const highBitdepth = field("sequence_header.color_config.high_bitdepth", 1);
    let bitDepth;
    if (seqProfile === 2 && highBitdepth) {
      const twelveBit = field(
        "sequence_header.color_config.twelve_bit",
        1,
        "seq_profile == 2 && high_bitdepth == 1",
      );
      bitDepth = twelveBit ? 12 : 10;
    } else {
      bitDepth = highBitdepth ? 10 : 8;
    }
    const monoChrome =
      seqProfile === 1
        ? 0
        : field(
            "sequence_header.color_config.mono_chrome",
            1,
            "seq_profile != 1",
          );
    const colorDescriptionPresent = field(
      "sequence_header.color_config.color_description_present_flag",
      1,
    );
    let colorPrimaries = 2;
    let transferCharacteristics = 2;
    let matrixCoefficients = 2;
    if (colorDescriptionPresent) {
      colorPrimaries = field(
        "sequence_header.color_config.color_primaries",
        8,
        "color_description_present_flag == 1",
      );
      transferCharacteristics = field(
        "sequence_header.color_config.transfer_characteristics",
        8,
        "color_description_present_flag == 1",
      );
      matrixCoefficients = field(
        "sequence_header.color_config.matrix_coefficients",
        8,
        "color_description_present_flag == 1",
      );
    }

    if (monoChrome) {
      field(
        "sequence_header.color_config.color_range",
        1,
        "mono_chrome == 1",
      );
    } else {
      const identityRgb =
        colorPrimaries === 1 &&
        transferCharacteristics === 13 &&
        matrixCoefficients === 0;
      let subsamplingX;
      let subsamplingY;
      if (identityRgb) {
        subsamplingX = 0;
        subsamplingY = 0;
      } else {
        field(
          "sequence_header.color_config.color_range",
          1,
          "not identity RGB",
        );
        if (seqProfile === 0) {
          subsamplingX = 1;
          subsamplingY = 1;
        } else if (seqProfile === 1) {
          subsamplingX = 0;
          subsamplingY = 0;
        } else if (bitDepth === 12) {
          subsamplingX = field(
            "sequence_header.color_config.subsampling_x",
            1,
            "seq_profile == 2 && BitDepth == 12",
          );
          subsamplingY = subsamplingX
            ? field(
                "sequence_header.color_config.subsampling_y",
                1,
                "subsampling_x == 1",
              )
            : 0;
        } else {
          subsamplingX = 1;
          subsamplingY = 0;
        }
        if (subsamplingX && subsamplingY) {
          field(
            "sequence_header.color_config.chroma_sample_position",
            2,
            "subsampling_x == 1 && subsampling_y == 1",
          );
        }
      }
      field(
        "sequence_header.color_config.separate_uv_delta_q",
        1,
        "mono_chrome == 0",
      );
    }

    field("sequence_header.film_grain_params_present", 1);

    const trailingOne = field(
      "sequence_header.trailing_bits.trailing_one_bit",
      1,
    );
    if (trailingOne !== 1) {
      diagnostics.push(
        diagnostic(
          "SEQUENCE_HEADER_TRAILING_ONE_BIT_INVALID",
          Severity.ERROR,
          "Sequence Header trailing_one_bit must be one",
          {
            range: byteRange(
              Math.floor(nodes.at(-1).bitRange.startBit / 8),
              1,
            ),
            frameId: obu.frameId,
            obuId: obu.obuId,
          },
        ),
      );
    }
    while (reader.position % 8 !== 0) {
      const zero = field(
        `sequence_header.trailing_bits.trailing_zero_bit[${reader.position % 8}]`,
        1,
      );
      if (zero !== 0) {
        diagnostics.push(
          diagnostic(
            "SEQUENCE_HEADER_TRAILING_ZERO_BIT_INVALID",
            Severity.ERROR,
            "Sequence Header trailing_zero_bit must be zero",
            {
              range: byteRange(start + Math.floor((reader.position - 1) / 8), 1),
              frameId: obu.frameId,
              obuId: obu.obuId,
            },
          ),
        );
      }
    }
    if (reader.remaining !== 0) {
      diagnostics.push(
        diagnostic(
          "SEQUENCE_HEADER_EXTRA_DATA",
          Severity.ERROR,
          `${reader.remaining} unparsed bits remain after Sequence Header trailing bits`,
          {
            range: byteRange(start + reader.position / 8, reader.remaining / 8),
            frameId: obu.frameId,
            obuId: obu.obuId,
          },
        ),
      );
    }
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error;
    }
    const consumedBytes = Math.min(length, Math.ceil(reader.position / 8));
    diagnostics.push(
      diagnostic(
        "SEQUENCE_HEADER_TRUNCATED",
        Severity.ERROR,
        `Sequence Header ended while reading its prefix: ${error.message}`,
        {
          range: byteRange(start, consumedBytes),
          frameId: obu.frameId,
          obuId: obu.obuId,
        },
      ),
    );
  }

  return {
    nodes,
    diagnostics,
    nextSyntaxNodeId,
    parsedBitLength: reader.position,
    status:
      diagnostics.length === 0 && reader.remaining === 0 ? "complete" : "error",
  };
}
