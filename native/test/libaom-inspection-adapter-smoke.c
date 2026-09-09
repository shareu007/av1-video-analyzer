#include <assert.h>
#include <stdint.h>
#include <string.h>

#include "av1scope_inspection.h"

typedef struct sink_state {
  uint32_t calls;
  uint32_t records;
  uint32_t final_seen;
  uint32_t qindex_255_seen;
  av1scope_status_v1 result;
} sink_state;

static uint32_t cancellation(void *user_data) {
  return *(const uint32_t *)user_data;
}

static av1scope_status_v1 consume(
  void *user_data,
  const av1scope_block_chunk_v1 *chunk
) {
  sink_state *state = (sink_state *)user_data;
  uint32_t index;
  assert(state != NULL && chunk != NULL);
  assert(chunk->struct_size == sizeof(*chunk));
  assert(chunk->abi_version == AV1SCOPE_ABI_VERSION_V1);
  assert(chunk->first_block_id == state->records);
  assert(chunk->record_count <= UINT32_C(2));
  for (index = UINT32_C(0); index < chunk->record_count; index += UINT32_C(1)) {
    const av1scope_block_record_v1 *record = &chunk->records[index];
    assert(record->frame_id == chunk->frame_id);
    assert(record->block_id == (uint64_t)state->records + (uint64_t)index);
    if ((record->flags & AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1) != UINT8_C(0)
        && record->qindex == UINT8_C(255)) state->qindex_255_seen = UINT32_C(1);
  }
  state->calls += UINT32_C(1);
  state->records += chunk->record_count;
  state->final_seen = chunk->final_chunk;
  return state->result;
}

static av1scope_status_v1 consume_v2(
  void *user_data,
  const av1scope_block_chunk_v2 *chunk
) {
  sink_state *state = (sink_state *)user_data;
  uint32_t index;
  assert(state != NULL && chunk != NULL);
  assert(chunk->struct_size == sizeof(*chunk));
  assert(chunk->abi_version == AV1SCOPE_INSPECTION_ABI_VERSION_V2);
  assert(chunk->first_block_id == state->records);
  assert(chunk->record_count <= UINT32_C(2));
  for (index = UINT32_C(0); index < chunk->record_count; index += UINT32_C(1)) {
    const av1scope_block_record_v2 *record = &chunk->records[index];
    assert(record->struct_size == sizeof(*record));
    assert(record->abi_version == AV1SCOPE_INSPECTION_ABI_VERSION_V2);
    assert(record->frame_id == chunk->frame_id);
    assert(record->block_id == (uint64_t)state->records + (uint64_t)index);
    assert((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2) != 0);
    assert(record->mi_column == index + state->records);
    assert((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2) != 0);
    if (index + state->records == UINT32_C(2)) {
      assert((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) != 0);
      assert(record->compound_type == INT16_C(4));
      assert(record->quant_delta == INT16_C(163));
    } else {
      assert((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) == 0);
      assert(record->quant_delta == INT16_C(0));
    }
    if ((record->flags & AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1) != UINT8_C(0)
        && record->qindex == UINT8_C(255)) state->qindex_255_seen = UINT32_C(1);
  }
  state->calls += UINT32_C(1);
  state->records += chunk->record_count;
  state->final_seen = chunk->final_chunk;
  return state->result;
}

static av1scope_diagnostic_v1 diagnostic(void) {
  av1scope_diagnostic_v1 value = {
    (uint32_t)sizeof(value), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  return value;
}

int main(void) {
  const uint8_t valid[] = {UINT8_C(1)};
  const uint8_t malformed[] = {UINT8_C(0xee)};
  const uint8_t invalid_event[] = {UINT8_C(0xfd)};
  const uint8_t invalid_detail[] = {UINT8_C(0xfc)};
  uint32_t is_cancelled = UINT32_C(0);
  sink_state sink = {UINT32_C(0), UINT32_C(0), UINT32_C(0), UINT32_C(0), AV1SCOPE_STATUS_OK_V1};
  av1scope_inspection_options_v1 options = {
    (uint32_t)sizeof(options), AV1SCOPE_ABI_VERSION_V1,
    AV1SCOPE_INSPECTION_FEATURES_ALL_V1, UINT32_C(2), UINT64_C(4096), consume, &sink
  };
  av1scope_call_context_v1 call = {
    (uint32_t)sizeof(call), AV1SCOPE_ABI_VERSION_V1,
    UINT64_C(0), cancellation, &is_cancelled
  };
  av1scope_adapter_info_v1 info = {
    (uint32_t)sizeof(info), AV1SCOPE_ABI_VERSION_V1,
    NULL, UINT32_C(0), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  av1scope_diagnostic_v1 output = diagnostic();
  av1scope_inspector *inspector = NULL;
  av1scope_bytes_v1 sample = {valid, (uint64_t)sizeof(valid)};

  assert(av1scope_inspection_adapter_info_v1(&info) == AV1SCOPE_STATUS_OK_V1);
  assert(info.name_bytes == strlen("libaom-inspect-v1"));
  assert(info.build_bytes == strlen("test-patched-fork-build-0000000000000001"));
  assert(info.feature_flags == AV1SCOPE_INSPECTION_FEATURES_ALL_V1);
  assert(av1scope_inspector_create_v1(&options, &inspector, &output) == AV1SCOPE_STATUS_OK_V1);
  assert(inspector != NULL);
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(7), sample, &call, &output
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(sink.calls == UINT32_C(2));
  assert(sink.records == UINT32_C(3));
  assert(sink.final_seen == UINT32_C(1));
  assert(sink.qindex_255_seen == UINT32_C(1));

  sink.calls = sink.records = sink.final_seen = UINT32_C(0);
  sink.result = AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(8), sample, &call, &output
  ) == AV1SCOPE_STATUS_RESOURCE_LIMIT_V1);

  sink.result = AV1SCOPE_STATUS_OK_V1;
  sample.data = invalid_event;
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(9), sample, &call, &output
  ) == AV1SCOPE_STATUS_ADAPTER_ERROR_V1);
  assert(output.status == AV1SCOPE_STATUS_ADAPTER_ERROR_V1);
  sample.data = malformed;
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(10), sample, &call, &output
  ) == AV1SCOPE_STATUS_MALFORMED_INPUT_V1);
  sample.data = valid;
  is_cancelled = UINT32_C(1);
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(11), sample, &call, &output
  ) == AV1SCOPE_STATUS_CANCELLED_V1);
  is_cancelled = UINT32_C(0);
  assert(av1scope_inspector_flush_v1(inspector, &call, &output) == AV1SCOPE_STATUS_OK_V1);
  av1scope_inspector_destroy_v1(inspector);
  av1scope_inspector_destroy_v1(NULL);

  options.feature_flags = UINT32_C(128);
  assert(av1scope_inspector_create_v1(
    &options, &inspector, &output
  ) == AV1SCOPE_STATUS_UNSUPPORTED_V1);

  {
    av1scope_inspection_options_v2 options_v2 = {
      (uint32_t)sizeof(options_v2), AV1SCOPE_INSPECTION_ABI_VERSION_V2,
      AV1SCOPE_INSPECTION_FEATURES_ALL_V1, UINT32_C(2), UINT64_C(4096),
      consume_v2, &sink
    };
    av1scope_inspector *inspector_v2 = NULL;
    sink.calls = sink.records = sink.final_seen = sink.qindex_255_seen = UINT32_C(0);
    sink.result = AV1SCOPE_STATUS_OK_V1;
    sample.data = valid;
    assert(av1scope_inspector_create_v2(
      &options_v2, &inspector_v2, &output
    ) == AV1SCOPE_STATUS_OK_V1);
    assert(inspector_v2 != NULL);
    assert(av1scope_inspector_decode_frame_v1(
      inspector_v2, UINT64_C(12), sample, &call, &output
    ) == AV1SCOPE_STATUS_ABI_MISMATCH_V1);
    assert(av1scope_inspector_decode_frame_v2(
      inspector_v2, UINT64_C(12), sample, &call, &output
    ) == AV1SCOPE_STATUS_OK_V1);
    assert(sink.calls == UINT32_C(2));
    assert(sink.records == UINT32_C(3));
    assert(sink.final_seen == UINT32_C(1));
    assert(sink.qindex_255_seen == UINT32_C(1));
    sample.data = invalid_detail;
    assert(av1scope_inspector_decode_frame_v2(
      inspector_v2, UINT64_C(13), sample, &call, &output
    ) == AV1SCOPE_STATUS_ADAPTER_ERROR_V1);
    sample.data = valid;
    assert(av1scope_inspector_flush_v2(inspector_v2, &call, &output)
      == AV1SCOPE_STATUS_OK_V1);
    av1scope_inspector_destroy_v2(inspector_v2);
    av1scope_inspector_destroy_v2(NULL);
  }
  return 0;
}
