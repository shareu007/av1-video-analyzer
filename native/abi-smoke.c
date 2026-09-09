#include <stddef.h>
#include <stdint.h>

#include "av1scope_abi.h"
#include "av1scope_demux.h"
#include "av1scope_inspection.h"
#include "av1scope_libaom_patch.h"

_Static_assert(AV1SCOPE_ABI_VERSION_V1 == 1, "unexpected ABI version");
_Static_assert(sizeof(av1scope_status_v1) == 4, "status code ABI drift");
_Static_assert(sizeof(av1scope_byte_range_v1) == 16, "byte range ABI drift");
_Static_assert(sizeof(av1scope_motion_vector_v1) == 12, "motion vector ABI drift");
_Static_assert(sizeof(av1scope_block_record_v1) == 88, "block record ABI drift");
_Static_assert(offsetof(av1scope_block_record_v1, flags) == 44,
               "block flags offset drift");
_Static_assert(offsetof(av1scope_block_record_v1, qindex) == 47,
               "block qindex offset drift");
_Static_assert(offsetof(av1scope_block_record_v1, motion_vectors) == 64,
               "block vector offset drift");
_Static_assert(sizeof(av1scope_block_record_v2) == 104, "block v2 record ABI drift");
_Static_assert(offsetof(av1scope_block_record_v2, detail_flags) == 88,
               "block v2 detail flags offset drift");
_Static_assert(offsetof(av1scope_block_record_v2, mi_row) == 92,
               "block v2 MI row offset drift");
_Static_assert(offsetof(av1scope_block_record_v2, compound_type) == 100,
               "block v2 compound type offset drift");
_Static_assert(sizeof(av1scope_libaom_block_event_v1) == 88,
               "libaom patch event ABI drift");
_Static_assert(offsetof(av1scope_libaom_block_event_v1, detail_flags) == 72,
               "libaom patch event detail offset drift");
_Static_assert(sizeof(av1scope_libaom_patch_options_v1) == 24,
               "libaom patch options ABI drift");
_Static_assert(sizeof(av1scope_libaom_decode_context_v1) == 56,
               "libaom patch decode context ABI drift");
_Static_assert(sizeof(av1scope_sample_v1) == 64, "sample ABI drift");
_Static_assert(offsetof(av1scope_sample_v1, source_range) == 48,
               "sample range offset drift");

static uint32_t cancelled(void *user_data) {
  return user_data == NULL ? UINT32_C(0) : UINT32_C(1);
}

static int64_t read_at(
  void *user_data,
  uint64_t offset,
  uint8_t *destination,
  uint64_t capacity
) {
  (void)user_data;
  (void)offset;
  (void)destination;
  return capacity == 0 ? INT64_C(0) : INT64_C(-1);
}

static av1scope_status_v1 on_blocks(
  void *user_data,
  const av1scope_block_chunk_v1 *chunk
) {
  (void)user_data;
  return chunk == NULL ? AV1SCOPE_STATUS_INVALID_ARGUMENT_V1 : AV1SCOPE_STATUS_OK_V1;
}

static av1scope_status_v1 on_blocks_v2(
  void *user_data,
  const av1scope_block_chunk_v2 *chunk
) {
  (void)user_data;
  return chunk == NULL ? AV1SCOPE_STATUS_INVALID_ARGUMENT_V1 : AV1SCOPE_STATUS_OK_V1;
}

int av1scope_abi_smoke(void) {
  av1scope_call_context_v1 call = {
    (uint32_t)sizeof(av1scope_call_context_v1),
    AV1SCOPE_ABI_VERSION_V1,
    UINT64_C(0),
    cancelled,
    NULL
  };
  av1scope_demux_source_v1 source = {
    (uint32_t)sizeof(av1scope_demux_source_v1),
    AV1SCOPE_ABI_VERSION_V1,
    UINT64_C(0),
    read_at,
    NULL
  };
  av1scope_inspection_options_v1 inspection = {
    (uint32_t)sizeof(av1scope_inspection_options_v1),
    AV1SCOPE_ABI_VERSION_V1,
    UINT32_C(0),
    AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1,
    AV1SCOPE_MAX_SAMPLE_BYTES_V1,
    on_blocks,
    NULL
  };
  av1scope_inspection_options_v2 inspection_v2 = {
    (uint32_t)sizeof(av1scope_inspection_options_v2),
    AV1SCOPE_INSPECTION_ABI_VERSION_V2,
    UINT32_C(0),
    AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1,
    AV1SCOPE_MAX_SAMPLE_BYTES_V1,
    on_blocks_v2,
    NULL
  };
  return call.struct_size > 0 && source.struct_size > 0 && inspection.struct_size > 0
    && inspection_v2.struct_size > 0
    ? 0
    : 1;
}
