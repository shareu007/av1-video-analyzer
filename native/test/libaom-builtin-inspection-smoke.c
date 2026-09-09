#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "av1scope_libaom_patch.h"

typedef struct sink_state {
  uint32_t count;
  av1scope_libaom_block_event_v1 events[4];
  av1scope_status_v1 result;
} sink_state;

static av1scope_status_v1 emit(
  void *user_data,
  const av1scope_libaom_block_event_v1 *event
) {
  sink_state *sink = (sink_state *)user_data;
  assert(sink != NULL && event != NULL && sink->count < UINT32_C(4));
  sink->events[sink->count] = *event;
  sink->count += UINT32_C(1);
  return sink->result;
}

static uint32_t never_cancelled(void *user_data) {
  (void)user_data;
  return UINT32_C(0);
}

int main(void) {
  const uint32_t features = AV1SCOPE_INSPECTION_FEATURE_PARTITION_V1
    | AV1SCOPE_INSPECTION_FEATURE_MODE_V1
    | AV1SCOPE_INSPECTION_FEATURE_MOTION_VECTOR_V1
    | AV1SCOPE_INSPECTION_FEATURE_TRANSFORM_V1
    | AV1SCOPE_INSPECTION_FEATURE_COEFFICIENT_V1
    | AV1SCOPE_INSPECTION_FEATURE_QINDEX_V1
    | AV1SCOPE_INSPECTION_FEATURE_FILTER_V1;
  const uint8_t sample_bytes[] = {UINT8_C(1), UINT8_C(2)};
  const uint8_t malformed_bytes[] = {UINT8_C(0xee)};
  const uint8_t show_existing_bytes[] = {UINT8_C(0x55)};
  av1scope_libaom_patch_options_v1 options = {
    (uint32_t)sizeof(options), AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1,
    features, UINT32_C(0), UINT64_C(1024)
  };
  sink_state sink;
  av1scope_libaom_decode_context_v1 context;
  av1scope_diagnostic_v1 diagnostic = {
    (uint32_t)sizeof(diagnostic), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  av1scope_libaom_patch_decoder *decoder = NULL;
  av1scope_bytes_v1 sample = {sample_bytes, (uint64_t)sizeof(sample_bytes)};
  (void)memset(&sink, 0, sizeof(sink));
  sink.result = AV1SCOPE_STATUS_OK_V1;
  (void)memset(&context, 0, sizeof(context));
  context.struct_size = (uint32_t)sizeof(context);
  context.abi_version = AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1;
  context.frame_id = UINT64_C(7);
  context.cancelled = never_cancelled;
  context.emit_block = emit;
  context.emit_user_data = &sink;

  assert(av1scope_libaom_patch_feature_flags_v1() == features);
  assert(av1scope_libaom_patch_decoder_create_v1(
    &options, &decoder, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(decoder != NULL);
  assert(av1scope_libaom_patch_decode_frame_v1(
    decoder, sample, &context, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(sink.count == UINT32_C(3));
  assert(sink.events[0].x == UINT32_C(0) && sink.events[0].y == UINT32_C(0));
  assert(sink.events[0].width == UINT32_C(8) && sink.events[0].height == UINT32_C(8));
  assert(sink.events[0].mode == (uint8_t)AV1SCOPE_BLOCK_MODE_INTRA_V1);
  assert(sink.events[0].partition == (uint8_t)AV1SCOPE_PARTITION_SPLIT_V1);
  assert(sink.events[0].coeff_non_zero == INT32_C(4));
  assert(sink.events[0].detail_flags
    == (AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2 | AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2));
  assert(sink.events[0].mi_row == UINT32_C(0) && sink.events[0].mi_column == UINT32_C(0));
  assert(sink.events[0].quant_delta == INT16_C(2));
  assert(sink.events[1].x == UINT32_C(8) && sink.events[1].y == UINT32_C(0));
  assert(sink.events[1].mode == (uint8_t)AV1SCOPE_BLOCK_MODE_INTER_V1);
  assert(sink.events[1].reference_0 == UINT8_C(1));
  assert(sink.events[1].reference_1 == UINT8_C(7));
  assert(sink.events[1].motion_vectors[0].valid == UINT8_C(1));
  assert(sink.events[1].motion_vectors[0].row == INT32_C(-2));
  assert(sink.events[1].motion_vectors[0].column == INT32_C(4));
  assert(sink.events[1].partition == (uint8_t)AV1SCOPE_PARTITION_HORZ_V1);
  assert(sink.events[1].coeff_non_zero == INT32_C(2));
  assert(sink.events[1].qindex == UINT8_C(255));
  assert((sink.events[1].detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) != 0U);
  assert(sink.events[1].compound_type == INT16_C(5));
  assert(sink.events[1].quant_delta == INT16_C(165));
  assert(sink.events[1].filter_summary == INT32_C(0x00040321));
  assert(sink.events[2].x == UINT32_C(8) && sink.events[2].y == UINT32_C(4));
  assert(sink.events[2].partition == (uint8_t)AV1SCOPE_PARTITION_VERT_V1);
  assert(sink.events[2].coeff_non_zero == INT32_C(3));

  sink.count = UINT32_C(0);
  sink.result = AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  assert(av1scope_libaom_patch_decode_frame_v1(
    decoder, sample, &context, &diagnostic
  ) == AV1SCOPE_STATUS_RESOURCE_LIMIT_V1);
  assert(sink.count == UINT32_C(1));
  sink.result = AV1SCOPE_STATUS_OK_V1;
  sink.count = UINT32_C(0);
  sample.data = show_existing_bytes;
  sample.length = (uint64_t)sizeof(show_existing_bytes);
  assert(av1scope_libaom_patch_decode_frame_v1(
    decoder, sample, &context, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(sink.count == UINT32_C(0));
  sample.data = malformed_bytes;
  sample.length = (uint64_t)sizeof(malformed_bytes);
  assert(av1scope_libaom_patch_decode_frame_v1(
    decoder, sample, &context, &diagnostic
  ) == AV1SCOPE_STATUS_MALFORMED_INPUT_V1);
  assert(diagnostic.status == AV1SCOPE_STATUS_MALFORMED_INPUT_V1);
  assert(av1scope_libaom_patch_flush_v1(
    decoder, &context, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  av1scope_libaom_patch_decoder_destroy_v1(decoder);
  return 0;
}
