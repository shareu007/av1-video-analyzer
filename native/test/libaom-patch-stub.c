#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "av1scope_libaom_patch.h"

struct av1scope_libaom_patch_decoder {
  uint32_t feature_flags;
  uint64_t maximum_frame_bytes;
};

uint32_t av1scope_libaom_patch_feature_flags_v1(void) {
  return AV1SCOPE_INSPECTION_FEATURES_ALL_V1;
}

av1scope_status_v1 av1scope_libaom_patch_decoder_create_v1(
  const av1scope_libaom_patch_options_v1 *options,
  av1scope_libaom_patch_decoder **out_decoder,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_libaom_patch_decoder *decoder;
  (void)out_diagnostic;
  if (options == NULL || out_decoder == NULL || options->struct_size < sizeof(*options)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_decoder = NULL;
  if (options->abi_version != AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  decoder = (av1scope_libaom_patch_decoder *)calloc(1U, sizeof(*decoder));
  if (decoder == NULL) return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  decoder->feature_flags = options->feature_flags;
  decoder->maximum_frame_bytes = options->maximum_frame_bytes;
  *out_decoder = decoder;
  return AV1SCOPE_STATUS_OK_V1;
}

static av1scope_libaom_block_event_v1 event(uint32_t index) {
  av1scope_libaom_block_event_v1 value;
  (void)memset(&value, 0, sizeof(value));
  value.struct_size = (uint32_t)sizeof(value);
  value.abi_version = AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1;
  value.x = index * UINT32_C(4);
  value.width = UINT32_C(4);
  value.height = UINT32_C(16);
  value.partition = (uint8_t)AV1SCOPE_PARTITION_VERT_V1;
  value.mode = index == UINT32_C(2)
    ? (uint8_t)AV1SCOPE_BLOCK_MODE_INTER_V1
    : (uint8_t)AV1SCOPE_BLOCK_MODE_INTRA_V1;
  value.segment_id = AV1SCOPE_BLOCK_NONE_U8;
  value.flags = AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1;
  value.reference_0 = index == UINT32_C(2) ? UINT8_C(0) : AV1SCOPE_BLOCK_NONE_U8;
  value.reference_1 = AV1SCOPE_BLOCK_NONE_U8;
  value.qindex = index == UINT32_C(2) ? UINT8_C(255) : UINT8_C(92);
  value.intra_mode = index == UINT32_C(2) ? AV1SCOPE_BLOCK_NONE_I16 : INT16_C(1);
  value.inter_mode = index == UINT32_C(2) ? INT16_C(3) : AV1SCOPE_BLOCK_NONE_I16;
  value.tx_size = INT16_C(2);
  value.tx_type = INT16_C(1);
  value.coeff_non_zero = INT32_C(4);
  value.filter_summary = INT32_C(9);
  value.motion_vectors[0].valid = index == UINT32_C(2) ? UINT8_C(1) : UINT8_C(0);
  value.motion_vectors[0].row = INT32_C(-2);
  value.motion_vectors[0].column = INT32_C(4);
  value.motion_vectors[0].precision = UINT8_C(3);
  value.detail_flags = AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2
    | AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2;
  value.mi_row = UINT32_C(0);
  value.mi_column = index;
  value.quant_delta = index == UINT32_C(2) ? INT16_C(163) : INT16_C(0);
  if (index == UINT32_C(2)) {
    value.detail_flags |= AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2;
    value.compound_type = INT16_C(4);
  }
  return value;
}

av1scope_status_v1 av1scope_libaom_patch_decode_frame_v1(
  av1scope_libaom_patch_decoder *decoder,
  av1scope_bytes_v1 sample,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  uint32_t index;
  (void)out_diagnostic;
  if (decoder == NULL || context == NULL || context->struct_size < sizeof(*context)
      || context->emit_block == NULL || (sample.length != UINT64_C(0) && sample.data == NULL)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (context->abi_version != AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if (sample.length > decoder->maximum_frame_bytes) return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  if (context->cancelled != NULL
      && context->cancelled(context->cancel_user_data) != UINT32_C(0)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }
  if (sample.length != UINT64_C(0) && sample.data[0] == UINT8_C(0xee)) {
    return AV1SCOPE_STATUS_MALFORMED_INPUT_V1;
  }
  for (index = UINT32_C(0); index < UINT32_C(3); index += UINT32_C(1)) {
    av1scope_libaom_block_event_v1 value = event(index);
    av1scope_status_v1 status;
    if (sample.length != UINT64_C(0) && sample.data[0] == UINT8_C(0xfd)) {
      value.width = UINT32_C(0);
    }
    if (sample.length != UINT64_C(0) && sample.data[0] == UINT8_C(0xfc)) {
      value.detail_flags = UINT32_C(8);
    }
    status = context->emit_block(context->emit_user_data, &value);
    if (status != AV1SCOPE_STATUS_OK_V1) return status;
  }
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_libaom_patch_flush_v1(
  av1scope_libaom_patch_decoder *decoder,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  (void)out_diagnostic;
  if (decoder == NULL || context == NULL || context->struct_size < sizeof(*context)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (context->cancelled != NULL
      && context->cancelled(context->cancel_user_data) != UINT32_C(0)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }
  return AV1SCOPE_STATUS_OK_V1;
}

void av1scope_libaom_patch_decoder_destroy_v1(
  av1scope_libaom_patch_decoder *decoder
) {
  free(decoder);
}
