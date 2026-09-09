#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

#include "av1scope_abi.h"
#include "av1scope_demux.h"
#include "av1scope_inspection.h"

struct av1scope_demux {
  uint64_t source_bytes;
  uint32_t emitted;
};

struct av1scope_inspector {
  uint32_t interface_version;
  av1scope_inspection_options_v1 options;
  av1scope_inspection_options_v2 options_v2;
};

static const uint8_t mock_name[] = "av1scope-test-mock";
static const uint8_t mock_build[] = "not-a-production-adapter";
static const uint8_t invalid_argument[] = "invalid argument";
static const uint8_t allocation_failed[] = "allocation failed";

static void set_diagnostic(
  av1scope_diagnostic_v1 *diagnostic,
  av1scope_status_v1 status,
  const uint8_t *message,
  uint32_t message_bytes
) {
  if (diagnostic == NULL || diagnostic->struct_size < sizeof(*diagnostic)) {
    return;
  }
  diagnostic->status = status;
  diagnostic->message_utf8 = message;
  diagnostic->message_bytes = message_bytes;
  diagnostic->reserved = UINT32_C(0);
}

static int is_cancelled(const av1scope_call_context_v1 *call) {
  return call != NULL
    && call->struct_size >= sizeof(*call)
    && call->abi_version == AV1SCOPE_ABI_VERSION_V1
    && call->cancelled != NULL
    && call->cancelled(call->user_data) != UINT32_C(0);
}

static av1scope_status_v1 write_info(av1scope_adapter_info_v1 *out_info) {
  if (out_info == NULL || out_info->struct_size < sizeof(*out_info)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (out_info->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  out_info->name_utf8 = mock_name;
  out_info->name_bytes = (uint32_t)(sizeof(mock_name) - 1U);
  out_info->reserved_0 = UINT32_C(0);
  out_info->build_utf8 = mock_build;
  out_info->build_bytes = (uint32_t)(sizeof(mock_build) - 1U);
  out_info->feature_flags = UINT32_C(0);
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_adapter_info_v1(
  av1scope_adapter_info_v1 *out_info
) {
  return write_info(out_info);
}

av1scope_status_v1 av1scope_demux_open_v1(
  const av1scope_demux_source_v1 *source,
  const av1scope_demux_options_v1 *options,
  const av1scope_call_context_v1 *call,
  av1scope_demux **out_demux,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_demux *demux;
  uint8_t probe;
  int64_t read_result;
  if (source == NULL || options == NULL || out_demux == NULL
      || source->struct_size < sizeof(*source)
      || options->struct_size < sizeof(*options)
      || source->read_at == NULL) {
    set_diagnostic(
      out_diagnostic,
      AV1SCOPE_STATUS_INVALID_ARGUMENT_V1,
      invalid_argument,
      (uint32_t)(sizeof(invalid_argument) - 1U)
    );
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_demux = NULL;
  if (source->abi_version != AV1SCOPE_ABI_VERSION_V1
      || options->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if (is_cancelled(call)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }
  if (source->source_bytes > options->maximum_sample_bytes) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if (source->source_bytes > UINT64_C(0)) {
    read_result = source->read_at(source->user_data, UINT64_C(0), &probe, UINT64_C(1));
    if (read_result != INT64_C(1)) {
      return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    }
  }
  demux = (av1scope_demux *)calloc(1U, sizeof(*demux));
  if (demux == NULL) {
    set_diagnostic(
      out_diagnostic,
      AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
      allocation_failed,
      (uint32_t)(sizeof(allocation_failed) - 1U)
    );
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  demux->source_bytes = source->source_bytes;
  *out_demux = demux;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_stream_info_v1(
  av1scope_demux *demux,
  av1scope_stream_info_v1 *out_stream,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  (void)out_diagnostic;
  if (demux == NULL || out_stream == NULL
      || out_stream->struct_size < sizeof(*out_stream)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (out_stream->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  out_stream->track_id = INT32_C(1);
  out_stream->codec_fourcc = UINT32_C(0x31307661);
  out_stream->width = UINT32_C(16);
  out_stream->height = UINT32_C(16);
  out_stream->time_base_num = INT32_C(1);
  out_stream->time_base_den = INT32_C(1000);
  out_stream->sample_count = UINT64_C(1);
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_next_sample_v1(
  av1scope_demux *demux,
  const av1scope_call_context_v1 *call,
  av1scope_sample_v1 *out_sample,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  (void)out_diagnostic;
  if (demux == NULL || out_sample == NULL
      || out_sample->struct_size < sizeof(*out_sample)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (out_sample->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if (is_cancelled(call)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }
  if (demux->emitted != UINT32_C(0)) {
    return AV1SCOPE_STATUS_END_V1;
  }
  out_sample->sample_id = UINT64_C(0);
  out_sample->track_id = INT32_C(1);
  out_sample->flags = AV1SCOPE_SAMPLE_FLAG_KEYFRAME_V1;
  out_sample->dts = INT64_C(0);
  out_sample->pts = INT64_C(0);
  out_sample->duration = INT64_C(1);
  out_sample->source_range.start = UINT64_C(0);
  out_sample->source_range.length = demux->source_bytes;
  demux->emitted = UINT32_C(1);
  return AV1SCOPE_STATUS_OK_V1;
}

void av1scope_demux_close_v1(av1scope_demux *demux) {
  free(demux);
}

av1scope_status_v1 av1scope_inspection_adapter_info_v1(
  av1scope_adapter_info_v1 *out_info
) {
  return write_info(out_info);
}

av1scope_status_v1 av1scope_inspector_create_v1(
  const av1scope_inspection_options_v1 *options,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_inspector *inspector;
  (void)out_diagnostic;
  if (options == NULL || out_inspector == NULL
      || options->struct_size < sizeof(*options)
      || options->on_block_chunk == NULL
      || options->maximum_blocks_per_chunk == UINT32_C(0)
      || options->maximum_blocks_per_chunk > AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_inspector = NULL;
  if (options->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  inspector = (av1scope_inspector *)malloc(sizeof(*inspector));
  if (inspector == NULL) {
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  inspector->options = *options;
  inspector->interface_version = AV1SCOPE_ABI_VERSION_V1;
  *out_inspector = inspector;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_inspector_decode_frame_v1(
  av1scope_inspector *inspector,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_block_record_v1 record = {0};
  av1scope_block_chunk_v1 chunk = {0};
  (void)out_diagnostic;
  if (inspector == NULL || (sample.length != UINT64_C(0) && sample.data == NULL)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (sample.length > inspector->options.maximum_frame_bytes) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if (is_cancelled(call)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }
  record.struct_size = (uint32_t)sizeof(record);
  record.abi_version = AV1SCOPE_ABI_VERSION_V1;
  record.frame_id = frame_id;
  record.block_id = UINT64_C(0);
  record.width = UINT32_C(16);
  record.height = UINT32_C(16);
  record.partition = (uint8_t)AV1SCOPE_PARTITION_NONE_V1;
  record.mode = (uint8_t)AV1SCOPE_BLOCK_MODE_INTRA_V1;
  record.flags = AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1;
  record.qindex = UINT8_C(92);
  record.reference_0 = AV1SCOPE_BLOCK_NONE_U8;
  record.reference_1 = AV1SCOPE_BLOCK_NONE_U8;
  record.intra_mode = AV1SCOPE_BLOCK_NONE_I16;
  record.inter_mode = AV1SCOPE_BLOCK_NONE_I16;
  record.tx_size = AV1SCOPE_BLOCK_NONE_I16;
  record.tx_type = AV1SCOPE_BLOCK_NONE_I16;
  record.coeff_non_zero = AV1SCOPE_BLOCK_NONE_I32;
  record.filter_summary = AV1SCOPE_BLOCK_NONE_I32;

  chunk.struct_size = (uint32_t)sizeof(chunk);
  chunk.abi_version = AV1SCOPE_ABI_VERSION_V1;
  chunk.frame_id = frame_id;
  chunk.first_block_id = UINT64_C(0);
  chunk.records = &record;
  chunk.record_count = UINT32_C(1);
  chunk.final_chunk = UINT32_C(1);
  return inspector->options.on_block_chunk(inspector->options.user_data, &chunk);
}

av1scope_status_v1 av1scope_inspector_flush_v1(
  av1scope_inspector *inspector,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  (void)out_diagnostic;
  if (inspector == NULL) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  return is_cancelled(call) ? AV1SCOPE_STATUS_CANCELLED_V1 : AV1SCOPE_STATUS_OK_V1;
}

void av1scope_inspector_destroy_v1(av1scope_inspector *inspector) {
  free(inspector);
}

av1scope_status_v1 av1scope_inspector_create_v2(
  const av1scope_inspection_options_v2 *options,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_inspector *inspector;
  (void)out_diagnostic;
  if (options == NULL || out_inspector == NULL
      || options->struct_size < sizeof(*options)
      || options->on_block_chunk == NULL
      || options->maximum_blocks_per_chunk == UINT32_C(0)
      || options->maximum_blocks_per_chunk > AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_inspector = NULL;
  if (options->abi_version != AV1SCOPE_INSPECTION_ABI_VERSION_V2) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  inspector = (av1scope_inspector *)calloc(1U, sizeof(*inspector));
  if (inspector == NULL) return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  inspector->interface_version = AV1SCOPE_INSPECTION_ABI_VERSION_V2;
  inspector->options_v2 = *options;
  *out_inspector = inspector;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_inspector_decode_frame_v2(
  av1scope_inspector *inspector,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_block_record_v2 record = {0};
  av1scope_block_chunk_v2 chunk = {0};
  (void)out_diagnostic;
  if (inspector == NULL || inspector->interface_version != AV1SCOPE_INSPECTION_ABI_VERSION_V2
      || (sample.length != UINT64_C(0) && sample.data == NULL)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (sample.length > inspector->options_v2.maximum_frame_bytes) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if (is_cancelled(call)) return AV1SCOPE_STATUS_CANCELLED_V1;
  record.struct_size = (uint32_t)sizeof(record);
  record.abi_version = AV1SCOPE_INSPECTION_ABI_VERSION_V2;
  record.frame_id = frame_id;
  record.width = UINT32_C(16);
  record.height = UINT32_C(16);
  record.partition = (uint8_t)AV1SCOPE_PARTITION_NONE_V1;
  record.mode = (uint8_t)AV1SCOPE_BLOCK_MODE_INTRA_V1;
  record.flags = AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1;
  record.qindex = UINT8_C(92);
  record.reference_0 = AV1SCOPE_BLOCK_NONE_U8;
  record.reference_1 = AV1SCOPE_BLOCK_NONE_U8;
  record.intra_mode = AV1SCOPE_BLOCK_NONE_I16;
  record.inter_mode = AV1SCOPE_BLOCK_NONE_I16;
  record.tx_size = AV1SCOPE_BLOCK_NONE_I16;
  record.tx_type = AV1SCOPE_BLOCK_NONE_I16;
  record.coeff_non_zero = AV1SCOPE_BLOCK_NONE_I32;
  record.filter_summary = AV1SCOPE_BLOCK_NONE_I32;
  record.detail_flags = AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2
    | AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2;
  record.quant_delta = INT16_C(2);
  chunk.struct_size = (uint32_t)sizeof(chunk);
  chunk.abi_version = AV1SCOPE_INSPECTION_ABI_VERSION_V2;
  chunk.frame_id = frame_id;
  chunk.records = &record;
  chunk.record_count = UINT32_C(1);
  chunk.final_chunk = UINT32_C(1);
  return inspector->options_v2.on_block_chunk(inspector->options_v2.user_data, &chunk);
}

av1scope_status_v1 av1scope_inspector_flush_v2(
  av1scope_inspector *inspector,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  (void)out_diagnostic;
  if (inspector == NULL || inspector->interface_version != AV1SCOPE_INSPECTION_ABI_VERSION_V2) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  return is_cancelled(call) ? AV1SCOPE_STATUS_CANCELLED_V1 : AV1SCOPE_STATUS_OK_V1;
}

void av1scope_inspector_destroy_v2(av1scope_inspector *inspector) {
  free(inspector);
}
