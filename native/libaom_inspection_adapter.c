#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "av1scope_abi.h"
#include "av1scope_inspection.h"
#include "av1scope_libaom_patch.h"

#ifndef AV1SCOPE_LIBAOM_BUILD_ID
#error "AV1SCOPE_LIBAOM_BUILD_ID must identify the pinned patched fork/build"
#endif

#define AV1SCOPE_LIBAOM_EVENT_V1_PREFIX_BYTES UINT32_C(72)

struct av1scope_inspector {
  uint32_t interface_version;
  uint32_t feature_flags;
  uint32_t maximum_blocks_per_chunk;
  uint64_t maximum_frame_bytes;
  union {
    av1scope_block_chunk_fn_v1 v1;
    av1scope_block_chunk_fn_v2 v2;
  } callback;
  void *user_data;
  av1scope_libaom_patch_decoder *decoder;
  void *records;
  const av1scope_call_context_v1 *call;
  uint64_t frame_id;
  uint64_t next_block_id;
  uint32_t record_count;
  av1scope_status_v1 sink_status;
};

static const uint8_t adapter_name[] = "libaom-inspect-v1";
static const uint8_t adapter_build[] = AV1SCOPE_LIBAOM_BUILD_ID;
static const uint8_t invalid_argument[] = "invalid argument";
static const uint8_t invalid_patch_event[] = "instrumented libaom emitted an invalid block event";
static const uint8_t allocation_failed[] = "allocation failed";

_Static_assert(sizeof(adapter_name) - 1U <= 32U, "adapter name exceeds worker provenance budget");
_Static_assert(sizeof(adapter_build) > 1U, "adapter build ID must not be empty");
_Static_assert(sizeof(adapter_build) - 1U <= 40U, "adapter build ID exceeds worker provenance budget");
_Static_assert(sizeof(av1scope_block_record_v1) == 88U, "v1 record prefix drift");
_Static_assert(offsetof(av1scope_block_record_v2, detail_flags) == sizeof(av1scope_block_record_v1),
  "v2 record is not an append-only extension");
_Static_assert(offsetof(av1scope_libaom_block_event_v1, detail_flags)
  == AV1SCOPE_LIBAOM_EVENT_V1_PREFIX_BYTES, "patch event prefix drift");

static void set_diagnostic(
  av1scope_diagnostic_v1 *diagnostic,
  av1scope_status_v1 status,
  const uint8_t *message,
  uint32_t message_bytes
) {
  if (diagnostic == NULL || diagnostic->struct_size < sizeof(*diagnostic)) return;
  diagnostic->status = status;
  diagnostic->message_utf8 = message;
  diagnostic->message_bytes = message_bytes;
  diagnostic->reserved = UINT32_C(0);
}

static int valid_call(const av1scope_call_context_v1 *call) {
  return call == NULL || (call->struct_size >= sizeof(*call)
    && call->abi_version == AV1SCOPE_ABI_VERSION_V1);
}

static int cancelled(const av1scope_call_context_v1 *call) {
  return call != NULL && call->cancelled != NULL
    && call->cancelled(call->user_data) != UINT32_C(0);
}

static uint64_t unix_time_ms(void) {
  struct timespec now;
  uint64_t seconds;
  if (timespec_get(&now, TIME_UTC) != TIME_UTC || now.tv_sec < 0) return UINT64_C(0);
  seconds = (uint64_t)now.tv_sec;
  if (seconds > UINT64_MAX / UINT64_C(1000)) return UINT64_MAX;
  return seconds * UINT64_C(1000) + (uint64_t)now.tv_nsec / UINT64_C(1000000);
}

static int deadline_expired(const av1scope_call_context_v1 *call) {
  uint64_t now;
  if (call == NULL || call->deadline_unix_ms == UINT64_C(0)) return 0;
  now = unix_time_ms();
  return now != UINT64_C(0) && now >= call->deadline_unix_ms;
}

static av1scope_status_v1 emit_chunk(av1scope_inspector *inspector, uint32_t final_chunk) {
  av1scope_status_v1 status;
  if (inspector->interface_version == AV1SCOPE_ABI_VERSION_V1) {
    av1scope_block_chunk_v1 chunk;
    chunk.struct_size = (uint32_t)sizeof(chunk);
    chunk.abi_version = AV1SCOPE_ABI_VERSION_V1;
    chunk.frame_id = inspector->frame_id;
    chunk.first_block_id = inspector->next_block_id - (uint64_t)inspector->record_count;
    chunk.records = inspector->record_count == UINT32_C(0)
      ? NULL : (const av1scope_block_record_v1 *)inspector->records;
    chunk.record_count = inspector->record_count;
    chunk.final_chunk = final_chunk;
    status = inspector->callback.v1(inspector->user_data, &chunk);
  } else {
    av1scope_block_chunk_v2 chunk;
    chunk.struct_size = (uint32_t)sizeof(chunk);
    chunk.abi_version = AV1SCOPE_INSPECTION_ABI_VERSION_V2;
    chunk.frame_id = inspector->frame_id;
    chunk.first_block_id = inspector->next_block_id - (uint64_t)inspector->record_count;
    chunk.records = inspector->record_count == UINT32_C(0)
      ? NULL : (const av1scope_block_record_v2 *)inspector->records;
    chunk.record_count = inspector->record_count;
    chunk.final_chunk = final_chunk;
    status = inspector->callback.v2(inspector->user_data, &chunk);
  }
  inspector->record_count = UINT32_C(0);
  if (status != AV1SCOPE_STATUS_OK_V1) inspector->sink_status = status;
  return status;
}

static int valid_event(const av1scope_libaom_block_event_v1 *event) {
  unsigned int index;
  if (event == NULL || event->struct_size < AV1SCOPE_LIBAOM_EVENT_V1_PREFIX_BYTES
      || (event->struct_size != AV1SCOPE_LIBAOM_EVENT_V1_PREFIX_BYTES
        && event->struct_size < sizeof(*event))
      || event->abi_version != AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1
      || event->width == UINT32_C(0) || event->height == UINT32_C(0)
      || event->x > UINT32_MAX - event->width
      || event->y > UINT32_MAX - event->height
      || event->plane > UINT8_C(2)
      || event->partition > (uint8_t)AV1SCOPE_PARTITION_VERT_4_V1
      || event->mode > (uint8_t)AV1SCOPE_BLOCK_MODE_SKIP_V1
      || (event->segment_id != AV1SCOPE_BLOCK_NONE_U8 && event->segment_id > UINT8_C(7))
      || (event->flags & (uint8_t)~AV1SCOPE_BLOCK_FLAGS_MASK_V1) != UINT8_C(0)
      || (event->reference_0 != AV1SCOPE_BLOCK_NONE_U8 && event->reference_0 > UINT8_C(7))
      || (event->reference_1 != AV1SCOPE_BLOCK_NONE_U8 && event->reference_1 > UINT8_C(7))) {
    return 0;
  }
  for (index = 0U; index < 2U; index += 1U) {
    if (event->motion_vectors[index].valid > UINT8_C(1)
        || event->motion_vectors[index].reserved != UINT16_C(0)) return 0;
  }
  if (event->struct_size >= sizeof(*event)
      && ((event->detail_flags & ~AV1SCOPE_BLOCK_DETAILS_MASK_V2) != UINT32_C(0)
        || ((event->detail_flags & AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2) == 0U
          && (event->mi_row != UINT32_C(0) || event->mi_column != UINT32_C(0)))
        || ((event->detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) == 0U
          && event->compound_type != INT16_C(0))
        || ((event->detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) != 0U
          && event->compound_type < INT16_C(0))
        || ((event->detail_flags & AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2) == 0U
          && event->quant_delta != INT16_C(0)))) return 0;
  return 1;
}

static void fill_v1_record(
  av1scope_block_record_v1 *record,
  const av1scope_inspector *inspector,
  const av1scope_libaom_block_event_v1 *event
) {
  (void)memset(record, 0, sizeof(*record));
  record->struct_size = (uint32_t)sizeof(*record);
  record->abi_version = AV1SCOPE_ABI_VERSION_V1;
  record->frame_id = inspector->frame_id;
  record->block_id = inspector->next_block_id;
  record->x = event->x;
  record->y = event->y;
  record->width = event->width;
  record->height = event->height;
  record->plane = event->plane;
  record->partition = event->partition;
  record->mode = event->mode;
  record->segment_id = event->segment_id;
  record->flags = event->flags;
  record->reference_0 = event->reference_0;
  record->reference_1 = event->reference_1;
  record->qindex = event->qindex;
  record->intra_mode = event->intra_mode;
  record->inter_mode = event->inter_mode;
  record->tx_size = event->tx_size;
  record->tx_type = event->tx_type;
  record->coeff_non_zero = event->coeff_non_zero;
  record->filter_summary = event->filter_summary;
  record->motion_vectors[0] = event->motion_vectors[0];
  record->motion_vectors[1] = event->motion_vectors[1];
}

static av1scope_status_v1 receive_block(
  void *user_data,
  const av1scope_libaom_block_event_v1 *event
) {
  av1scope_inspector *inspector = (av1scope_inspector *)user_data;
  if (inspector == NULL) return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  if (inspector->sink_status != AV1SCOPE_STATUS_OK_V1) return inspector->sink_status;
  if (cancelled(inspector->call) || deadline_expired(inspector->call)) {
    inspector->sink_status = AV1SCOPE_STATUS_CANCELLED_V1;
    return inspector->sink_status;
  }
  if (!valid_event(event)) {
    inspector->sink_status = AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    return inspector->sink_status;
  }
  if (inspector->interface_version == AV1SCOPE_ABI_VERSION_V1) {
    av1scope_block_record_v1 *record =
      &((av1scope_block_record_v1 *)inspector->records)[inspector->record_count];
    fill_v1_record(record, inspector, event);
  } else {
    av1scope_block_record_v2 *record =
      &((av1scope_block_record_v2 *)inspector->records)[inspector->record_count];
    av1scope_block_record_v1 prefix;
    fill_v1_record(&prefix, inspector, event);
    (void)memset(record, 0, sizeof(*record));
    (void)memcpy(record, &prefix, sizeof(prefix));
    record->struct_size = (uint32_t)sizeof(*record);
    record->abi_version = AV1SCOPE_INSPECTION_ABI_VERSION_V2;
    if (event->struct_size >= sizeof(*event)) {
      record->detail_flags = event->detail_flags;
      record->mi_row = event->mi_row;
      record->mi_column = event->mi_column;
      record->compound_type = event->compound_type;
      record->quant_delta = event->quant_delta;
    }
  }
  inspector->next_block_id += UINT64_C(1);
  inspector->record_count += UINT32_C(1);
  if (inspector->record_count == inspector->maximum_blocks_per_chunk) {
    return emit_chunk(inspector, UINT32_C(0));
  }
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_inspection_adapter_info_v1(
  av1scope_adapter_info_v1 *out_info
) {
  uint32_t supported = av1scope_libaom_patch_feature_flags_v1();
  if (out_info == NULL || out_info->struct_size < sizeof(*out_info)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (out_info->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if ((supported & ~AV1SCOPE_INSPECTION_FEATURES_ALL_V1) != UINT32_C(0)) {
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  out_info->name_utf8 = adapter_name;
  out_info->name_bytes = (uint32_t)(sizeof(adapter_name) - 1U);
  out_info->reserved_0 = UINT32_C(0);
  out_info->build_utf8 = adapter_build;
  out_info->build_bytes = (uint32_t)(sizeof(adapter_build) - 1U);
  out_info->feature_flags = supported;
  return AV1SCOPE_STATUS_OK_V1;
}

static av1scope_status_v1 create_common(
  uint32_t interface_version,
  uint32_t feature_flags,
  uint32_t maximum_blocks_per_chunk,
  uint64_t maximum_frame_bytes,
  av1scope_block_chunk_fn_v1 callback_v1,
  av1scope_block_chunk_fn_v2 callback_v2,
  void *user_data,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_inspector *inspector;
  av1scope_libaom_patch_options_v1 patch_options;
  av1scope_status_v1 status;
  uint32_t supported = av1scope_libaom_patch_feature_flags_v1();
  uint32_t requested;
  size_t record_size = interface_version == AV1SCOPE_ABI_VERSION_V1
    ? sizeof(av1scope_block_record_v1) : sizeof(av1scope_block_record_v2);
  if (out_inspector == NULL
      || (callback_v1 == NULL && callback_v2 == NULL)
      || maximum_blocks_per_chunk == UINT32_C(0)
      || maximum_blocks_per_chunk > AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1
      || maximum_frame_bytes == UINT64_C(0)
      || maximum_frame_bytes > AV1SCOPE_MAX_SAMPLE_BYTES_V1) {
    set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1,
      invalid_argument, (uint32_t)(sizeof(invalid_argument) - 1U));
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_inspector = NULL;
  if ((supported & ~AV1SCOPE_INSPECTION_FEATURES_ALL_V1) != UINT32_C(0)) {
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  if ((feature_flags & ~supported) != UINT32_C(0)) return AV1SCOPE_STATUS_UNSUPPORTED_V1;
  requested = feature_flags == UINT32_C(0) ? supported : feature_flags;
  inspector = (av1scope_inspector *)calloc(1U, sizeof(*inspector));
  if (inspector == NULL) {
    set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
      allocation_failed, (uint32_t)(sizeof(allocation_failed) - 1U));
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  inspector->records = calloc((size_t)maximum_blocks_per_chunk, record_size);
  if (inspector->records == NULL) {
    free(inspector);
    set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
      allocation_failed, (uint32_t)(sizeof(allocation_failed) - 1U));
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  inspector->interface_version = interface_version;
  inspector->feature_flags = requested;
  inspector->maximum_blocks_per_chunk = maximum_blocks_per_chunk;
  inspector->maximum_frame_bytes = maximum_frame_bytes;
  inspector->callback.v1 = callback_v1;
  if (interface_version == AV1SCOPE_INSPECTION_ABI_VERSION_V2) inspector->callback.v2 = callback_v2;
  inspector->user_data = user_data;
  patch_options.struct_size = (uint32_t)sizeof(patch_options);
  patch_options.abi_version = AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1;
  patch_options.feature_flags = requested;
  patch_options.reserved = UINT32_C(0);
  patch_options.maximum_frame_bytes = maximum_frame_bytes;
  status = av1scope_libaom_patch_decoder_create_v1(
    &patch_options, &inspector->decoder, out_diagnostic
  );
  if (status != AV1SCOPE_STATUS_OK_V1 || inspector->decoder == NULL) {
    av1scope_libaom_patch_decoder_destroy_v1(inspector->decoder);
    free(inspector->records);
    free(inspector);
    return status == AV1SCOPE_STATUS_OK_V1 ? AV1SCOPE_STATUS_ADAPTER_ERROR_V1 : status;
  }
  *out_inspector = inspector;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_inspector_create_v1(
  const av1scope_inspection_options_v1 *options,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  if (options == NULL || options->struct_size < sizeof(*options)) {
    set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1,
      invalid_argument, (uint32_t)(sizeof(invalid_argument) - 1U));
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (options->abi_version != AV1SCOPE_ABI_VERSION_V1) return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  return create_common(AV1SCOPE_ABI_VERSION_V1, options->feature_flags,
    options->maximum_blocks_per_chunk, options->maximum_frame_bytes,
    options->on_block_chunk, NULL, options->user_data, out_inspector, out_diagnostic);
}

av1scope_status_v1 av1scope_inspector_create_v2(
  const av1scope_inspection_options_v2 *options,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  if (options == NULL || options->struct_size < sizeof(*options)) {
    set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1,
      invalid_argument, (uint32_t)(sizeof(invalid_argument) - 1U));
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (options->abi_version != AV1SCOPE_INSPECTION_ABI_VERSION_V2) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  return create_common(AV1SCOPE_INSPECTION_ABI_VERSION_V2, options->feature_flags,
    options->maximum_blocks_per_chunk, options->maximum_frame_bytes,
    NULL, options->on_block_chunk, options->user_data, out_inspector, out_diagnostic);
}

static av1scope_status_v1 decode_common(
  av1scope_inspector *inspector,
  uint32_t interface_version,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_libaom_decode_context_v1 context;
  av1scope_status_v1 status;
  if (inspector == NULL || (sample.length != UINT64_C(0) && sample.data == NULL)
      || !valid_call(call)) return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  if (inspector->interface_version != interface_version) return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  if (sample.length > inspector->maximum_frame_bytes) return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  if (cancelled(call) || deadline_expired(call)) return AV1SCOPE_STATUS_CANCELLED_V1;
  inspector->call = call;
  inspector->frame_id = frame_id;
  inspector->next_block_id = UINT64_C(0);
  inspector->record_count = UINT32_C(0);
  inspector->sink_status = AV1SCOPE_STATUS_OK_V1;
  context.struct_size = (uint32_t)sizeof(context);
  context.abi_version = AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1;
  context.frame_id = frame_id;
  context.deadline_unix_ms = call == NULL ? UINT64_C(0) : call->deadline_unix_ms;
  context.cancelled = call == NULL ? NULL : call->cancelled;
  context.cancel_user_data = call == NULL ? NULL : call->user_data;
  context.emit_block = receive_block;
  context.emit_user_data = inspector;
  status = av1scope_libaom_patch_decode_frame_v1(
    inspector->decoder, sample, &context, out_diagnostic
  );
  inspector->call = NULL;
  if (inspector->sink_status != AV1SCOPE_STATUS_OK_V1) {
    if (inspector->sink_status == AV1SCOPE_STATUS_ADAPTER_ERROR_V1) {
      set_diagnostic(out_diagnostic, inspector->sink_status, invalid_patch_event,
        (uint32_t)(sizeof(invalid_patch_event) - 1U));
    }
    return inspector->sink_status;
  }
  if (status != AV1SCOPE_STATUS_OK_V1) return status;
  return emit_chunk(inspector, UINT32_C(1));
}

av1scope_status_v1 av1scope_inspector_decode_frame_v1(
  av1scope_inspector *inspector,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  return decode_common(inspector, AV1SCOPE_ABI_VERSION_V1, frame_id,
    sample, call, out_diagnostic);
}

av1scope_status_v1 av1scope_inspector_decode_frame_v2(
  av1scope_inspector *inspector,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  return decode_common(inspector, AV1SCOPE_INSPECTION_ABI_VERSION_V2, frame_id,
    sample, call, out_diagnostic);
}

static av1scope_status_v1 flush_common(
  av1scope_inspector *inspector,
  uint32_t interface_version,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_libaom_decode_context_v1 context;
  if (inspector == NULL || !valid_call(call)) return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  if (inspector->interface_version != interface_version) return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  if (cancelled(call) || deadline_expired(call)) return AV1SCOPE_STATUS_CANCELLED_V1;
  (void)memset(&context, 0, sizeof(context));
  context.struct_size = (uint32_t)sizeof(context);
  context.abi_version = AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1;
  context.deadline_unix_ms = call == NULL ? UINT64_C(0) : call->deadline_unix_ms;
  context.cancelled = call == NULL ? NULL : call->cancelled;
  context.cancel_user_data = call == NULL ? NULL : call->user_data;
  return av1scope_libaom_patch_flush_v1(inspector->decoder, &context, out_diagnostic);
}

av1scope_status_v1 av1scope_inspector_flush_v1(
  av1scope_inspector *inspector,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  return flush_common(inspector, AV1SCOPE_ABI_VERSION_V1, call, out_diagnostic);
}

av1scope_status_v1 av1scope_inspector_flush_v2(
  av1scope_inspector *inspector,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  return flush_common(inspector, AV1SCOPE_INSPECTION_ABI_VERSION_V2, call, out_diagnostic);
}

static void destroy_common(av1scope_inspector *inspector) {
  if (inspector == NULL) return;
  av1scope_libaom_patch_decoder_destroy_v1(inspector->decoder);
  free(inspector->records);
  free(inspector);
}

void av1scope_inspector_destroy_v1(av1scope_inspector *inspector) {
  destroy_common(inspector);
}

void av1scope_inspector_destroy_v2(av1scope_inspector *inspector) {
  destroy_common(inspector);
}
