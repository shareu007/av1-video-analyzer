#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "av1scope_abi.h"
#include "av1scope_demux.h"
#include "av1scope_inspection.h"

typedef struct memory_source {
  const uint8_t *bytes;
  uint64_t length;
} memory_source;

typedef struct callback_state {
  uint32_t calls;
  av1scope_status_v1 result;
} callback_state;

static int64_t memory_read_at(
  void *user_data,
  uint64_t offset,
  uint8_t *destination,
  uint64_t capacity
) {
  memory_source *source = (memory_source *)user_data;
  uint64_t available;
  uint64_t count;
  if (source == NULL || destination == NULL || offset > source->length) {
    return INT64_C(-1);
  }
  available = source->length - offset;
  count = capacity < available ? capacity : available;
  if (count > (uint64_t)SIZE_MAX || count > (uint64_t)INT64_MAX) {
    return INT64_C(-1);
  }
  if (count != UINT64_C(0)) {
    (void)memcpy(destination, source->bytes + (size_t)offset, (size_t)count);
  }
  return (int64_t)count;
}

static uint32_t cancellation(void *user_data) {
  const uint32_t *cancelled = (const uint32_t *)user_data;
  return cancelled == NULL ? UINT32_C(0) : *cancelled;
}

static av1scope_status_v1 consume_blocks(
  void *user_data,
  const av1scope_block_chunk_v1 *chunk
) {
  callback_state *state = (callback_state *)user_data;
  assert(state != NULL);
  assert(chunk != NULL);
  assert(chunk->struct_size == sizeof(*chunk));
  assert(chunk->abi_version == AV1SCOPE_ABI_VERSION_V1);
  assert(chunk->record_count == UINT32_C(1));
  assert(chunk->records != NULL);
  assert(chunk->records[0].struct_size == sizeof(chunk->records[0]));
  assert(chunk->records[0].frame_id == chunk->frame_id);
  assert(chunk->records[0].block_id == chunk->first_block_id);
  state->calls += UINT32_C(1);
  return state->result;
}

int main(void) {
  const uint8_t source_bytes[] = {UINT8_C(0x12), UINT8_C(0x00)};
  uint32_t cancelled = UINT32_C(0);
  memory_source memory = {source_bytes, (uint64_t)sizeof(source_bytes)};
  av1scope_call_context_v1 call = {
    (uint32_t)sizeof(call), AV1SCOPE_ABI_VERSION_V1, UINT64_C(0), cancellation, &cancelled
  };
  av1scope_demux_source_v1 source = {
    (uint32_t)sizeof(source),
    AV1SCOPE_ABI_VERSION_V1,
    (uint64_t)sizeof(source_bytes),
    memory_read_at,
    &memory
  };
  av1scope_demux_options_v1 demux_options = {
    (uint32_t)sizeof(demux_options),
    AV1SCOPE_ABI_VERSION_V1,
    INT32_C(-1),
    UINT32_C(0),
    UINT64_C(4096),
    UINT64_C(4096)
  };
  av1scope_diagnostic_v1 diagnostic = {
    (uint32_t)sizeof(diagnostic), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  av1scope_adapter_info_v1 info = {
    (uint32_t)sizeof(info), AV1SCOPE_ABI_VERSION_V1, NULL, UINT32_C(0),
    UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  av1scope_demux *demux = NULL;
  av1scope_stream_info_v1 stream = {
    (uint32_t)sizeof(stream), AV1SCOPE_ABI_VERSION_V1,
    INT32_C(0), UINT32_C(0), UINT32_C(0), UINT32_C(0),
    INT32_C(0), INT32_C(0), UINT64_C(0)
  };
  av1scope_sample_v1 sample = {
    (uint32_t)sizeof(sample), AV1SCOPE_ABI_VERSION_V1,
    UINT64_C(0), INT32_C(0), UINT32_C(0),
    INT64_C(0), INT64_C(0), INT64_C(0), {UINT64_C(0), UINT64_C(0)}
  };
  callback_state callback = {UINT32_C(0), AV1SCOPE_STATUS_OK_V1};
  av1scope_inspection_options_v1 inspection_options = {
    (uint32_t)sizeof(inspection_options),
    AV1SCOPE_ABI_VERSION_V1,
    UINT32_C(0),
    UINT32_C(4),
    UINT64_C(4096),
    consume_blocks,
    &callback
  };
  av1scope_inspector *inspector = NULL;
  av1scope_bytes_v1 encoded = {source_bytes, (uint64_t)sizeof(source_bytes)};

  assert(av1scope_demux_adapter_info_v1(&info) == AV1SCOPE_STATUS_OK_V1);
  assert(info.name_utf8 != NULL && info.name_bytes != UINT32_C(0));
  assert(av1scope_demux_open_v1(
    &source, &demux_options, &call, &demux, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(demux != NULL);
  assert(av1scope_demux_stream_info_v1(
    demux, &stream, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(stream.sample_count == UINT64_C(1));
  assert(av1scope_demux_next_sample_v1(
    demux, &call, &sample, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(sample.source_range.length == (uint64_t)sizeof(source_bytes));
  assert(av1scope_demux_next_sample_v1(
    demux, &call, &sample, &diagnostic
  ) == AV1SCOPE_STATUS_END_V1);
  av1scope_demux_close_v1(demux);
  av1scope_demux_close_v1(NULL);

  demux_options.abi_version = UINT32_C(999);
  assert(av1scope_demux_open_v1(
    &source, &demux_options, &call, &demux, &diagnostic
  ) == AV1SCOPE_STATUS_ABI_MISMATCH_V1);
  demux_options.abi_version = AV1SCOPE_ABI_VERSION_V1;
  cancelled = UINT32_C(1);
  assert(av1scope_demux_open_v1(
    &source, &demux_options, &call, &demux, &diagnostic
  ) == AV1SCOPE_STATUS_CANCELLED_V1);
  cancelled = UINT32_C(0);

  assert(av1scope_inspector_create_v1(
    &inspection_options, &inspector, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(7), encoded, &call, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  assert(callback.calls == UINT32_C(1));
  callback.result = AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(8), encoded, &call, &diagnostic
  ) == AV1SCOPE_STATUS_RESOURCE_LIMIT_V1);
  cancelled = UINT32_C(1);
  assert(av1scope_inspector_decode_frame_v1(
    inspector, UINT64_C(9), encoded, &call, &diagnostic
  ) == AV1SCOPE_STATUS_CANCELLED_V1);
  cancelled = UINT32_C(0);
  assert(av1scope_inspector_flush_v1(
    inspector, &call, &diagnostic
  ) == AV1SCOPE_STATUS_OK_V1);
  av1scope_inspector_destroy_v1(inspector);
  av1scope_inspector_destroy_v1(NULL);
  return 0;
}
