#ifndef AV1SCOPE_LIBAOM_PATCH_H
#define AV1SCOPE_LIBAOM_PATCH_H

#include "av1scope_inspection.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1 UINT32_C(1)

/* This is the private boundary implemented by the pinned instrumented libaom
 * fork. No libaom internal object or enum crosses into the product ABI. */

typedef struct av1scope_libaom_patch_decoder av1scope_libaom_patch_decoder;

typedef struct av1scope_libaom_block_event_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t x;
  uint32_t y;
  uint32_t width;
  uint32_t height;
  uint8_t plane;
  uint8_t partition;
  uint8_t mode;
  uint8_t segment_id;
  uint8_t flags;
  uint8_t reference_0;
  uint8_t reference_1;
  uint8_t qindex;
  int16_t intra_mode;
  int16_t inter_mode;
  int16_t tx_size;
  int16_t tx_type;
  int32_t coeff_non_zero;
  int32_t filter_summary;
  av1scope_motion_vector_v1 motion_vectors[2];
  /* Optional append-only details. Consumers must first check struct_size. */
  uint32_t detail_flags;
  uint32_t mi_row;
  uint32_t mi_column;
  int16_t compound_type;
  int16_t quant_delta;
} av1scope_libaom_block_event_v1;

typedef av1scope_status_v1 (*av1scope_libaom_emit_block_fn_v1)(
  void *user_data,
  const av1scope_libaom_block_event_v1 *event
);

/* emit_block is synchronous and must be called on the decode thread only.
 * The event is borrowed for that call. The fork must immediately stop and
 * return any non-OK sink status; it must never retain context or callback
 * pointers after decode_frame returns. */

typedef struct av1scope_libaom_patch_options_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t feature_flags;
  uint32_t reserved;
  uint64_t maximum_frame_bytes;
} av1scope_libaom_patch_options_v1;

typedef struct av1scope_libaom_decode_context_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  uint64_t deadline_unix_ms;
  av1scope_cancelled_fn_v1 cancelled;
  void *cancel_user_data;
  av1scope_libaom_emit_block_fn_v1 emit_block;
  void *emit_user_data;
} av1scope_libaom_decode_context_v1;

uint32_t av1scope_libaom_patch_feature_flags_v1(void);

av1scope_status_v1 av1scope_libaom_patch_decoder_create_v1(
  const av1scope_libaom_patch_options_v1 *options,
  av1scope_libaom_patch_decoder **out_decoder,
  av1scope_diagnostic_v1 *out_diagnostic
);

av1scope_status_v1 av1scope_libaom_patch_decode_frame_v1(
  av1scope_libaom_patch_decoder *decoder,
  av1scope_bytes_v1 sample,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *out_diagnostic
);

av1scope_status_v1 av1scope_libaom_patch_flush_v1(
  av1scope_libaom_patch_decoder *decoder,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *out_diagnostic
);

void av1scope_libaom_patch_decoder_destroy_v1(
  av1scope_libaom_patch_decoder *decoder
);

#ifdef __cplusplus
}
#endif

#endif
