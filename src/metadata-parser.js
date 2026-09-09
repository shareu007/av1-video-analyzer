import { BitReader } from "./bit-reader.js";
import { Leb128Error, readLeb128 } from "./leb128.js";
import { SCHEMA_VERSION, Severity, byteRange, diagnostic } from "./model.js";

const METADATA_TYPES = new Map([
  [1, "HDR_CLL"],
  [2, "HDR_MDCV"],
  [3, "SCALABILITY"],
  [4, "ITUT_T35"],
  [5, "TIMECODE"],
]);

export function parseMetadata(buffer, obu, { nextSyntaxNodeId = 0 } = {}) {
  const nodes = [];
  const diagnostics = [];
  const { start, length } = obu.payloadRange;
  const end = start + length;
  let metadata;
  try {
    metadata = readLeb128(buffer, start, end);
  } catch (error) {
    if (!(error instanceof Leb128Error)) throw error;
    diagnostics.push(diagnostic(error.code, Severity.ERROR, error.message, {
      range: byteRange(error.start, error.length), frameId: obu.frameId, obuId: obu.obuId,
    }));
    return { nodes, diagnostics, nextSyntaxNodeId, parsedBitLength: 0, status: "error" };
  }
  const typeName = METADATA_TYPES.get(metadata.value) ?? "UNKNOWN_OR_PRIVATE";
  const addNode = (path, value, coding, bitRange, presence = "true") => {
    nodes.push({
      schemaVersion: SCHEMA_VERSION,
      nodeId: nextSyntaxNodeId++,
      obuId: obu.obuId,
      path,
      value,
      coding,
      presence,
      bitRange,
      specAnchor: "AV1 §5.8 Metadata OBU syntax",
    });
    return value;
  };
  addNode(
    "metadata.metadata_type",
    metadata.value,
    "leb128()",
    { startBit: start * 8, lengthBits: metadata.length * 8 },
  );
  addNode("metadata.metadata_type_name", typeName, "inferred", null, "derived from metadata_type");
  const contentStart = start + metadata.length;
  const reader = new BitReader(buffer, { startByte: contentStart, lengthBytes: end - contentStart });
  const field = (path, width, presence = "true") => {
    const relative = reader.position;
    return addNode(path, reader.readBits(width), `f(${width})`, {
      startBit: contentStart * 8 + relative,
      lengthBits: width,
    }, presence);
  };

  try {
    let knownFixed = false;
    if (metadata.value === 1) {
      field("metadata.hdr_cll.max_cll", 16);
      field("metadata.hdr_cll.max_fall", 16);
      knownFixed = true;
    } else if (metadata.value === 2) {
      for (let index = 0; index < 3; index += 1) {
        field(`metadata.hdr_mdcv.primary_chromaticity_x[${index}]`, 16);
        field(`metadata.hdr_mdcv.primary_chromaticity_y[${index}]`, 16);
      }
      field("metadata.hdr_mdcv.white_point_chromaticity_x", 16);
      field("metadata.hdr_mdcv.white_point_chromaticity_y", 16);
      field("metadata.hdr_mdcv.luminance_max", 32);
      field("metadata.hdr_mdcv.luminance_min", 32);
      knownFixed = true;
    } else if (metadata.value === 4) {
      const country = field("metadata.itut_t35.country_code", 8);
      if (country === 0xff) field("metadata.itut_t35.country_code_extension_byte", 8, "country_code == 255");
      addNode(
        "metadata.itut_t35.payload_byte_length",
        Math.floor(reader.remaining / 8),
        "derived",
        null,
        "remaining ITU-T T.35 bytes",
      );
    } else if (metadata.value === 3) {
      const mode = field("metadata.scalability.scalability_mode_idc", 8);
      if (mode === 14) {
        const layersMinus1 = field("metadata.scalability.spatial_layers_cnt_minus_1", 2, "scalability_mode_idc == 14");
        const dimensionsPresent = field("metadata.scalability.spatial_layer_dimensions_present_flag", 1, "scalability_mode_idc == 14");
        const descriptionPresent = field("metadata.scalability.spatial_layer_description_present_flag", 1, "scalability_mode_idc == 14");
        const temporalGroupPresent = field("metadata.scalability.temporal_group_description_present_flag", 1, "scalability_mode_idc == 14");
        const reserved = field("metadata.scalability.scalability_structure_reserved_3bits", 3, "scalability_mode_idc == 14");
        if (reserved !== 0) diagnostics.push(diagnostic(
          "SCALABILITY_RESERVED_BITS_SET", Severity.ERROR,
          "scalability_structure_reserved_3bits must be zero",
          { range: byteRange(contentStart + Math.floor((reader.position - 3) / 8), 1), frameId: obu.frameId, obuId: obu.obuId },
        ));
        if (dimensionsPresent) {
          for (let layer = 0; layer <= layersMinus1; layer += 1) {
            field(`metadata.scalability.spatial_layer_max_width[${layer}]`, 16, "spatial_layer_dimensions_present_flag == 1");
            field(`metadata.scalability.spatial_layer_max_height[${layer}]`, 16, "spatial_layer_dimensions_present_flag == 1");
          }
        }
        if (descriptionPresent) {
          for (let layer = 0; layer <= layersMinus1; layer += 1) {
            field(`metadata.scalability.spatial_layer_ref_id[${layer}]`, 8, "spatial_layer_description_present_flag == 1");
          }
        }
        if (temporalGroupPresent) {
          const groupSize = field("metadata.scalability.temporal_group_size", 8, "temporal_group_description_present_flag == 1");
          for (let picture = 0; picture < groupSize; picture += 1) {
            field(`metadata.scalability.temporal_group_temporal_id[${picture}]`, 3, "temporal group loop");
            field(`metadata.scalability.temporal_group_temporal_switching_up_point_flag[${picture}]`, 1, "temporal group loop");
            field(`metadata.scalability.temporal_group_spatial_switching_up_point_flag[${picture}]`, 1, "temporal group loop");
            const refs = field(`metadata.scalability.temporal_group_ref_cnt[${picture}]`, 3, "temporal group loop");
            for (let reference = 0; reference < refs; reference += 1) {
              field(`metadata.scalability.temporal_group_ref_pic_diff[${picture}][${reference}]`, 8, "temporal_group_ref_cnt loop");
            }
          }
        }
      } else if (mode > 28) {
        diagnostics.push(diagnostic(
          "SCALABILITY_MODE_RESERVED", Severity.WARNING,
          `scalability_mode_idc ${mode} is reserved`,
          { range: byteRange(contentStart, 1), frameId: obu.frameId, obuId: obu.obuId },
        ));
      }
      knownFixed = true;
    } else if (metadata.value === 5) {
      field("metadata.timecode.counting_type", 5);
      const fullTimestamp = field("metadata.timecode.full_timestamp_flag", 1);
      field("metadata.timecode.discontinuity_flag", 1);
      field("metadata.timecode.cnt_dropped_flag", 1);
      field("metadata.timecode.n_frames", 9);
      const readSeconds = (presence) => {
        const seconds = field("metadata.timecode.seconds_value", 6, presence);
        if (seconds > 59) diagnostics.push(diagnostic("TIMECODE_SECONDS_INVALID", Severity.ERROR, `seconds_value ${seconds} exceeds 59`, { range: byteRange(contentStart, Math.ceil(reader.position / 8)), frameId: obu.frameId, obuId: obu.obuId }));
      };
      const readMinutes = (presence) => {
        const minutes = field("metadata.timecode.minutes_value", 6, presence);
        if (minutes > 59) diagnostics.push(diagnostic("TIMECODE_MINUTES_INVALID", Severity.ERROR, `minutes_value ${minutes} exceeds 59`, { range: byteRange(contentStart, Math.ceil(reader.position / 8)), frameId: obu.frameId, obuId: obu.obuId }));
      };
      const readHours = (presence) => {
        const hours = field("metadata.timecode.hours_value", 5, presence);
        if (hours > 23) diagnostics.push(diagnostic("TIMECODE_HOURS_INVALID", Severity.ERROR, `hours_value ${hours} exceeds 23`, { range: byteRange(contentStart, Math.ceil(reader.position / 8)), frameId: obu.frameId, obuId: obu.obuId }));
      };
      if (fullTimestamp) {
        readSeconds("full_timestamp_flag == 1");
        readMinutes("full_timestamp_flag == 1");
        readHours("full_timestamp_flag == 1");
      } else {
        const secondsPresent = field("metadata.timecode.seconds_flag", 1, "full_timestamp_flag == 0");
        if (secondsPresent) {
          readSeconds("seconds_flag == 1");
          const minutesPresent = field("metadata.timecode.minutes_flag", 1, "seconds_flag == 1");
          if (minutesPresent) {
            readMinutes("minutes_flag == 1");
            const hoursPresent = field("metadata.timecode.hours_flag", 1, "minutes_flag == 1");
            if (hoursPresent) readHours("hours_flag == 1");
          }
        }
      }
      const offsetLength = field("metadata.timecode.time_offset_length", 5);
      if (offsetLength > 0) field("metadata.timecode.time_offset_value", offsetLength, "time_offset_length > 0");
      knownFixed = true;
    }
    if (knownFixed) {
      const trailingOne = field("metadata.trailing_bits.trailing_one_bit", 1);
      if (trailingOne !== 1) {
        diagnostics.push(diagnostic(
          "METADATA_TRAILING_ONE_BIT_INVALID",
          Severity.ERROR,
          "Metadata trailing_one_bit must be one",
          { range: byteRange(contentStart + Math.floor((reader.position - 1) / 8), 1), frameId: obu.frameId, obuId: obu.obuId },
        ));
      }
      while (reader.position % 8 !== 0) {
        const zero = field(`metadata.trailing_bits.trailing_zero_bit[${reader.position % 8}]`, 1);
        if (zero !== 0) {
          diagnostics.push(diagnostic(
            "METADATA_TRAILING_ZERO_BIT_INVALID",
            Severity.ERROR,
            "Metadata trailing_zero_bit must be zero",
            { range: byteRange(contentStart + Math.floor((reader.position - 1) / 8), 1), frameId: obu.frameId, obuId: obu.obuId },
          ));
        }
      }
      if (reader.remaining !== 0) {
        diagnostics.push(diagnostic(
          "METADATA_EXTRA_DATA",
          Severity.ERROR,
          `${reader.remaining} unparsed bits remain after Metadata trailing bits`,
          { range: byteRange(contentStart + reader.position / 8, reader.remaining / 8), frameId: obu.frameId, obuId: obu.obuId },
        ));
      }
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    diagnostics.push(diagnostic(
      "METADATA_TRUNCATED",
      Severity.ERROR,
      `Metadata ${typeName} ended before all fixed fields were available`,
      { range: byteRange(contentStart, Math.ceil(reader.position / 8)), frameId: obu.frameId, obuId: obu.obuId },
    ));
    return { nodes, diagnostics, nextSyntaxNodeId, parsedBitLength: metadata.length * 8 + reader.position, status: "error" };
  }
  const knownFixed = [1, 2, 3, 5].includes(metadata.value);
  const nodeValue = (path, fallback = null) => nodes.find((node) => node.path === path)?.value ?? fallback;
  const summary = { metadataType: metadata.value, metadataTypeName: typeName };
  if (metadata.value === 3) {
    summary.scalabilityModeIdc = nodeValue("metadata.scalability.scalability_mode_idc");
    summary.spatialLayerCount = nodeValue("metadata.scalability.spatial_layers_cnt_minus_1", 0) + 1;
    summary.temporalGroupSize = nodeValue("metadata.scalability.temporal_group_size", null);
  } else if (metadata.value === 5) {
    summary.timecode = {
      countingType: nodeValue("metadata.timecode.counting_type"),
      nFrames: nodeValue("metadata.timecode.n_frames"),
      seconds: nodeValue("metadata.timecode.seconds_value"),
      minutes: nodeValue("metadata.timecode.minutes_value"),
      hours: nodeValue("metadata.timecode.hours_value"),
      timeOffsetLength: nodeValue("metadata.timecode.time_offset_length"),
      timeOffsetValue: nodeValue("metadata.timecode.time_offset_value", 0),
    };
  }
  return {
    nodes,
    diagnostics,
    nextSyntaxNodeId,
    parsedBitLength: metadata.length * 8 + reader.position,
    status: knownFixed
      ? diagnostics.length === 0 && reader.remaining === 0 ? "complete" : "error"
      : "partial",
    summary,
  };
}
