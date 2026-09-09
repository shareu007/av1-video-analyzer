#ifndef AV1SCOPE_INSPECTION_H
#define AV1SCOPE_INSPECTION_H

#include "av1scope_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AV1SCOPE_BLOCK_NONE_I16 INT16_C(-1)
#define AV1SCOPE_BLOCK_NONE_I32 INT32_C(-1)
#define AV1SCOPE_BLOCK_NONE_U8 UINT8_C(255)

#define AV1SCOPE_BLOCK_FLAG_SKIP_V1 UINT8_C(1)
#define AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1 UINT8_C(2)
#define AV1SCOPE_BLOCK_FLAGS_MASK_V1 UINT8_C(3)

#define AV1SCOPE_INSPECTION_ABI_VERSION_V2 UINT32_C(2)
#define AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2 UINT32_C(1)
#define AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2 UINT32_C(2)
#define AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2 UINT32_C(4)
#define AV1SCOPE_BLOCK_DETAILS_MASK_V2 UINT32_C(7)

#define AV1SCOPE_INSPECTION_FEATURE_PARTITION_V1 UINT32_C(1)
#define AV1SCOPE_INSPECTION_FEATURE_MODE_V1 UINT32_C(2)
#define AV1SCOPE_INSPECTION_FEATURE_MOTION_VECTOR_V1 UINT32_C(4)
#define AV1SCOPE_INSPECTION_FEATURE_TRANSFORM_V1 UINT32_C(8)
#define AV1SCOPE_INSPECTION_FEATURE_COEFFICIENT_V1 UINT32_C(16)
#define AV1SCOPE_INSPECTION_FEATURE_QINDEX_V1 UINT32_C(32)
#define AV1SCOPE_INSPECTION_FEATURE_FILTER_V1 UINT32_C(64)
#define AV1SCOPE_INSPECTION_FEATURES_ALL_V1 UINT32_C(127)

typedef struct av1scope_inspector av1scope_inspector;

typedef enum av1scope_block_mode_v1 {
  AV1SCOPE_BLOCK_MODE_UNKNOWN_V1 = 0,
  AV1SCOPE_BLOCK_MODE_INTRA_V1 = 1,
  AV1SCOPE_BLOCK_MODE_INTER_V1 = 2,
  AV1SCOPE_BLOCK_MODE_SKIP_V1 = 3
} av1scope_block_mode_v1;

typedef enum av1scope_partition_v1 {
  AV1SCOPE_PARTITION_UNKNOWN_V1 = 0,
  AV1SCOPE_PARTITION_NONE_V1 = 1,
  AV1SCOPE_PARTITION_SPLIT_V1 = 2,
  AV1SCOPE_PARTITION_HORZ_V1 = 3,
  AV1SCOPE_PARTITION_VERT_V1 = 4,
  AV1SCOPE_PARTITION_HORZ_A_V1 = 5,
  AV1SCOPE_PARTITION_HORZ_B_V1 = 6,
  AV1SCOPE_PARTITION_VERT_A_V1 = 7,
  AV1SCOPE_PARTITION_VERT_B_V1 = 8,
  AV1SCOPE_PARTITION_HORZ_4_V1 = 9,
  AV1SCOPE_PARTITION_VERT_4_V1 = 10
} av1scope_partition_v1;

typedef struct av1scope_motion_vector_v1 {
  int32_t row;
  int32_t column;
  uint8_t precision;
  uint8_t valid;
  uint16_t reserved;
} av1scope_motion_vector_v1;

typedef struct av1scope_block_record_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  uint64_t block_id;
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
} av1scope_block_record_v1;

/* v2 is an append-only extension. Its first 88 bytes are byte-for-byte v1,
 * so a producer can deliberately down-convert without reinterpreting fields. */
typedef struct av1scope_block_record_v2 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  uint64_t block_id;
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
  uint32_t detail_flags;
  uint32_t mi_row;
  uint32_t mi_column;
  int16_t compound_type;
  int16_t quant_delta;
} av1scope_block_record_v2;

typedef struct av1scope_block_chunk_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  uint64_t first_block_id;
  const av1scope_block_record_v1 *records;
  uint32_t record_count;
  uint32_t final_chunk;
} av1scope_block_chunk_v1;

typedef av1scope_status_v1 (*av1scope_block_chunk_fn_v1)(
  void *user_data,
  const av1scope_block_chunk_v1 *chunk
);

typedef struct av1scope_block_chunk_v2 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  uint64_t first_block_id;
  const av1scope_block_record_v2 *records;
  uint32_t record_count;
  uint32_t final_chunk;
} av1scope_block_chunk_v2;

typedef av1scope_status_v1 (*av1scope_block_chunk_fn_v2)(
  void *user_data,
  const av1scope_block_chunk_v2 *chunk
);

/* chunk and records are borrowed only for the duration of the callback. The
 * callback must copy accepted records and may return CANCELLED/RESOURCE_LIMIT
 * to stop production. record_count must not exceed the negotiated maximum. */

typedef struct av1scope_inspection_options_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t feature_flags;
  uint32_t maximum_blocks_per_chunk;
  uint64_t maximum_frame_bytes;
  av1scope_block_chunk_fn_v1 on_block_chunk;
  void *user_data;
} av1scope_inspection_options_v1;

typedef struct av1scope_inspection_options_v2 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t feature_flags;
  uint32_t maximum_blocks_per_chunk;
  uint64_t maximum_frame_bytes;
  av1scope_block_chunk_fn_v2 on_block_chunk;
  void *user_data;
} av1scope_inspection_options_v2;

AV1SCOPE_API av1scope_status_v1 av1scope_inspection_adapter_info_v1(
  av1scope_adapter_info_v1 *out_info
);

AV1SCOPE_API av1scope_status_v1 av1scope_inspector_create_v1(
  const av1scope_inspection_options_v1 *options,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API av1scope_status_v1 av1scope_inspector_decode_frame_v1(
  av1scope_inspector *inspector,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API av1scope_status_v1 av1scope_inspector_flush_v1(
  av1scope_inspector *inspector,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API void av1scope_inspector_destroy_v1(av1scope_inspector *inspector);

AV1SCOPE_API av1scope_status_v1 av1scope_inspector_create_v2(
  const av1scope_inspection_options_v2 *options,
  av1scope_inspector **out_inspector,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API av1scope_status_v1 av1scope_inspector_decode_frame_v2(
  av1scope_inspector *inspector,
  uint64_t frame_id,
  av1scope_bytes_v1 sample,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API av1scope_status_v1 av1scope_inspector_flush_v2(
  av1scope_inspector *inspector,
  const av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API void av1scope_inspector_destroy_v2(av1scope_inspector *inspector);

/* destroy accepts NULL. A successful create owns one fixed-build decoder
 * instance; decoder/libaom objects and entropy state never cross this ABI. */

#ifdef __cplusplus
}
#endif

#endif
