#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "av1scope_inspection.h"
#include "av1scope_worker_limits.h"
#include "av1scope_worker_sandbox.h"

#define REQUEST_BYTES 56U
#define FRAME_DESCRIPTOR_BYTES 24U
#define RESPONSE_HEADER_BYTES 16U
#define RESPONSE_RECORD_BYTES 112U
#define MAX_WORKER_INPUT_BYTES (UINT64_C(64) * UINT64_C(1024) * UINT64_C(1024))
#define MAX_WORKER_FRAMES UINT64_C(250000)
#define MAX_WORKER_BLOCKS UINT64_C(1000000)
#define INFO_NAME_BYTES 32U
#define INFO_BUILD_BYTES 40U

enum response_kind {
  RESPONSE_INFO = 1,
  RESPONSE_BLOCK = 2,
  RESPONSE_FRAME_END = 3,
  RESPONSE_END = 4,
  RESPONSE_ERROR = 5
};

typedef struct frame_descriptor {
  uint64_t frame_id;
  uint64_t start;
  uint64_t length;
} frame_descriptor;

typedef struct callback_state {
  uint64_t frame_id;
  uint64_t next_block_id;
  uint64_t total_blocks;
  uint64_t maximum_blocks;
  uint32_t maximum_blocks_per_chunk;
  uint32_t final_seen;
  uint32_t output_failed;
} callback_state;

static uint32_t read_u32_le(const uint8_t *bytes) {
  return (uint32_t)bytes[0]
    | ((uint32_t)bytes[1] << 8U)
    | ((uint32_t)bytes[2] << 16U)
    | ((uint32_t)bytes[3] << 24U);
}

static uint64_t read_u64_le(const uint8_t *bytes) {
  uint64_t result = UINT64_C(0);
  unsigned int index;
  for (index = 0; index < 8U; index += 1U) {
    result |= (uint64_t)bytes[index] << (index * 8U);
  }
  return result;
}

static void write_u16_le(uint8_t *bytes, uint16_t value) {
  bytes[0] = (uint8_t)value;
  bytes[1] = (uint8_t)(value >> 8U);
}

static void write_u32_le(uint8_t *bytes, uint32_t value) {
  unsigned int index;
  for (index = 0; index < 4U; index += 1U) {
    bytes[index] = (uint8_t)(value >> (index * 8U));
  }
}

static void write_u64_le(uint8_t *bytes, uint64_t value) {
  unsigned int index;
  for (index = 0; index < 8U; index += 1U) {
    bytes[index] = (uint8_t)(value >> (index * 8U));
  }
}

static int read_exact(uint8_t *bytes, size_t length) {
  return length == 0U || fread(bytes, 1U, length, stdin) == length;
}

static int write_response_header(void) {
  uint8_t bytes[RESPONSE_HEADER_BYTES] = {
    'A', '1', 'I', 'N', 'O', '0', '2', 0,
    0, 0, 0, 0, 0, 0, 0, 0
  };
  write_u32_le(bytes + 8U, AV1SCOPE_INSPECTION_ABI_VERSION_V2);
  write_u32_le(bytes + 12U, RESPONSE_RECORD_BYTES);
  return fwrite(bytes, 1U, sizeof(bytes), stdout) == sizeof(bytes);
}

static int write_record(uint32_t kind, av1scope_status_v1 status, const uint8_t *payload) {
  uint8_t bytes[RESPONSE_RECORD_BYTES] = {0};
  write_u32_le(bytes, kind);
  write_u32_le(bytes + 4U, status);
  if (payload != NULL) {
    memcpy(bytes + 8U, payload, RESPONSE_RECORD_BYTES - 8U);
  }
  return fwrite(bytes, 1U, sizeof(bytes), stdout) == sizeof(bytes);
}

static int write_scalar_record(
  uint32_t kind,
  av1scope_status_v1 status,
  uint64_t first,
  uint64_t second
) {
  uint8_t payload[RESPONSE_RECORD_BYTES - 8U] = {0};
  write_u64_le(payload, first);
  write_u64_le(payload + 8U, second);
  return write_record(kind, status, payload);
}

static int write_info_record(
  const av1scope_adapter_info_v1 *info,
  uint32_t worker_sandbox_flags
) {
  uint8_t payload[RESPONSE_RECORD_BYTES - 8U] = {0};
  if (info == NULL || info->struct_size < sizeof(*info)
      || info->abi_version != AV1SCOPE_ABI_VERSION_V1
      || info->name_utf8 == NULL || info->name_bytes == UINT32_C(0)
      || info->name_bytes > INFO_NAME_BYTES
      || info->build_utf8 == NULL || info->build_bytes == UINT32_C(0)
      || info->build_bytes > INFO_BUILD_BYTES) {
    return 0;
  }
  write_u32_le(payload, info->feature_flags);
  write_u32_le(payload + 4U, worker_sandbox_flags);
  write_u32_le(payload + 8U, info->name_bytes);
  write_u32_le(payload + 12U, info->build_bytes);
  memcpy(payload + 16U, info->name_utf8, info->name_bytes);
  memcpy(payload + 48U, info->build_utf8, info->build_bytes);
  return write_record(RESPONSE_INFO, AV1SCOPE_STATUS_OK_V1, payload);
}

static int valid_record(const av1scope_block_record_v2 *record, const callback_state *state) {
  unsigned int index;
  if (record == NULL || record->struct_size < sizeof(*record)
      || record->abi_version != AV1SCOPE_INSPECTION_ABI_VERSION_V2
      || record->frame_id != state->frame_id
      || record->block_id != state->next_block_id
      || record->width == UINT32_C(0) || record->height == UINT32_C(0)
      || record->x > UINT32_MAX - record->width
      || record->y > UINT32_MAX - record->height
      || record->plane > UINT8_C(2)
      || record->partition > (uint8_t)AV1SCOPE_PARTITION_VERT_4_V1
      || record->mode > (uint8_t)AV1SCOPE_BLOCK_MODE_SKIP_V1
      || (record->segment_id != AV1SCOPE_BLOCK_NONE_U8 && record->segment_id > UINT8_C(7))
      || (record->flags & (uint8_t)~AV1SCOPE_BLOCK_FLAGS_MASK_V1) != UINT8_C(0)
      || (record->reference_0 != AV1SCOPE_BLOCK_NONE_U8 && record->reference_0 > UINT8_C(7))
      || (record->reference_1 != AV1SCOPE_BLOCK_NONE_U8 && record->reference_1 > UINT8_C(7))
      || (record->detail_flags & ~AV1SCOPE_BLOCK_DETAILS_MASK_V2) != UINT32_C(0)
      || ((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2) == 0U
        && (record->mi_row != UINT32_C(0) || record->mi_column != UINT32_C(0)))
      || ((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) == 0U
        && record->compound_type != INT16_C(0))
      || ((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2) != 0U
        && record->compound_type < INT16_C(0))
      || ((record->detail_flags & AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2) == 0U
        && record->quant_delta != INT16_C(0))) {
    return 0;
  }
  for (index = 0; index < 2U; index += 1U) {
    if (record->motion_vectors[index].valid > UINT8_C(1)
        || record->motion_vectors[index].reserved != UINT16_C(0)) {
      return 0;
    }
  }
  return 1;
}

static int write_block(const av1scope_block_record_v2 *record) {
  uint8_t payload[RESPONSE_RECORD_BYTES - 8U] = {0};
  unsigned int index;
  write_u32_le(payload, (uint32_t)sizeof(*record));
  write_u32_le(payload + 4U, AV1SCOPE_INSPECTION_ABI_VERSION_V2);
  write_u64_le(payload + 8U, record->frame_id);
  write_u64_le(payload + 16U, record->block_id);
  write_u32_le(payload + 24U, record->x);
  write_u32_le(payload + 28U, record->y);
  write_u32_le(payload + 32U, record->width);
  write_u32_le(payload + 36U, record->height);
  payload[40U] = record->plane;
  payload[41U] = record->partition;
  payload[42U] = record->mode;
  payload[43U] = record->segment_id;
  payload[44U] = record->flags;
  payload[45U] = record->reference_0;
  payload[46U] = record->reference_1;
  payload[47U] = record->qindex;
  write_u16_le(payload + 48U, (uint16_t)record->intra_mode);
  write_u16_le(payload + 50U, (uint16_t)record->inter_mode);
  write_u16_le(payload + 52U, (uint16_t)record->tx_size);
  write_u16_le(payload + 54U, (uint16_t)record->tx_type);
  write_u32_le(payload + 56U, (uint32_t)record->coeff_non_zero);
  write_u32_le(payload + 60U, (uint32_t)record->filter_summary);
  for (index = 0; index < 2U; index += 1U) {
    const av1scope_motion_vector_v1 *vector = &record->motion_vectors[index];
    const size_t offset = 64U + index * 12U;
    write_u32_le(payload + offset, (uint32_t)vector->row);
    write_u32_le(payload + offset + 4U, (uint32_t)vector->column);
    payload[offset + 8U] = vector->precision;
    payload[offset + 9U] = vector->valid;
    write_u16_le(payload + offset + 10U, vector->reserved);
  }
  write_u32_le(payload + 88U, record->detail_flags);
  write_u32_le(payload + 92U, record->mi_row);
  write_u32_le(payload + 96U, record->mi_column);
  write_u16_le(payload + 100U, (uint16_t)record->compound_type);
  write_u16_le(payload + 102U, (uint16_t)record->quant_delta);
  return write_record(RESPONSE_BLOCK, AV1SCOPE_STATUS_OK_V1, payload);
}

static av1scope_status_v1 consume_blocks(
  void *user_data,
  const av1scope_block_chunk_v2 *chunk
) {
  callback_state *state = (callback_state *)user_data;
  uint32_t index;
  if (state == NULL || chunk == NULL || chunk->struct_size < sizeof(*chunk)
      || chunk->abi_version != AV1SCOPE_INSPECTION_ABI_VERSION_V2
      || chunk->frame_id != state->frame_id
      || chunk->first_block_id != state->next_block_id
      || chunk->record_count > state->maximum_blocks_per_chunk
      || (chunk->record_count != UINT32_C(0) && chunk->records == NULL)
      || chunk->final_chunk > UINT32_C(1) || state->final_seen != UINT32_C(0)) {
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  if ((uint64_t)chunk->record_count > state->maximum_blocks - state->total_blocks) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  for (index = 0; index < chunk->record_count; index += 1U) {
    if (!valid_record(&chunk->records[index], state)) {
      return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    }
    if (!write_block(&chunk->records[index])) {
      state->output_failed = UINT32_C(1);
      return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    }
    state->next_block_id += UINT64_C(1);
    state->total_blocks += UINT64_C(1);
  }
  state->final_seen = chunk->final_chunk;
  return AV1SCOPE_STATUS_OK_V1;
}

static av1scope_diagnostic_v1 diagnostic(void) {
  av1scope_diagnostic_v1 value = {
    (uint32_t)sizeof(value), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  return value;
}

static void write_diagnostic_to_stderr(const av1scope_diagnostic_v1 *value) {
  size_t bytes;
  if (value == NULL || value->message_utf8 == NULL || value->message_bytes == UINT32_C(0)) return;
  bytes = value->message_bytes > UINT32_C(4096) ? (size_t)UINT32_C(4096)
                                                : (size_t)value->message_bytes;
  (void)fwrite(value->message_utf8, 1U, bytes, stderr);
  (void)fputc('\n', stderr);
}

int main(void) {
  uint8_t request[REQUEST_BYTES];
  uint8_t descriptor_bytes[FRAME_DESCRIPTOR_BYTES];
  uint8_t *input = NULL;
  frame_descriptor *frames = NULL;
  av1scope_inspector *inspector = NULL;
  av1scope_adapter_info_v1 adapter_info = {
    (uint32_t)sizeof(adapter_info), AV1SCOPE_ABI_VERSION_V1,
    NULL, UINT32_C(0), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  av1scope_inspection_options_v2 options;
  av1scope_call_context_v1 call = {
    (uint32_t)sizeof(call), AV1SCOPE_ABI_VERSION_V1, UINT64_C(0), NULL, NULL
  };
  av1scope_diagnostic_v1 output_diagnostic = diagnostic();
  callback_state state = {0};
  av1scope_status_v1 status;
  uint64_t input_bytes;
  uint64_t frame_count;
  uint64_t index;
  uint32_t worker_sandbox_flags = UINT32_C(0);

  if (!write_response_header()) return 3;
  if (!av1scope_apply_worker_limits()) {
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, NULL);
    return 0;
  }
  if (av1scope_worker_sandbox_is_supported()) {
    if (!av1scope_apply_worker_sandbox()) {
      (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, NULL);
      return 0;
    }
    worker_sandbox_flags = AV1SCOPE_WORKER_SANDBOX_LINUX_V1;
  }
  if (!read_exact(request, sizeof(request))
      || memcmp(request, "A1INX02", 7U) != 0 || request[7] != 0
      || read_u32_le(request + 8U) != AV1SCOPE_INSPECTION_ABI_VERSION_V2
      || read_u32_le(request + 12U) != REQUEST_BYTES
      || read_u32_le(request + 44U) != UINT32_C(0)) {
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, NULL);
    return 0;
  }
  input_bytes = read_u64_le(request + 16U);
  frame_count = read_u64_le(request + 24U);
  state.maximum_blocks = read_u64_le(request + 32U);
  state.maximum_blocks_per_chunk = read_u32_le(request + 40U);
  if (input_bytes > MAX_WORKER_INPUT_BYTES || frame_count == UINT64_C(0)
      || frame_count > MAX_WORKER_FRAMES || state.maximum_blocks == UINT64_C(0)
      || state.maximum_blocks > MAX_WORKER_BLOCKS
      || state.maximum_blocks_per_chunk == UINT32_C(0)
      || state.maximum_blocks_per_chunk > AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1
      || read_u64_le(request + 48U) == UINT64_C(0)
      || read_u64_le(request + 48U) > AV1SCOPE_MAX_SAMPLE_BYTES_V1
      || frame_count > (uint64_t)(SIZE_MAX / sizeof(*frames))) {
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1, NULL);
    return 0;
  }
  frames = (frame_descriptor *)calloc((size_t)frame_count, sizeof(*frames));
  input = (uint8_t *)malloc((size_t)(input_bytes == 0 ? 1 : input_bytes));
  if (frames == NULL || input == NULL) {
    free(frames);
    free(input);
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, NULL);
    return 0;
  }
  for (index = UINT64_C(0); index < frame_count; index += UINT64_C(1)) {
    if (!read_exact(descriptor_bytes, sizeof(descriptor_bytes))) {
      free(frames);
      free(input);
      (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_MALFORMED_INPUT_V1, NULL);
      return 0;
    }
    frames[index].frame_id = read_u64_le(descriptor_bytes);
    frames[index].start = read_u64_le(descriptor_bytes + 8U);
    frames[index].length = read_u64_le(descriptor_bytes + 16U);
    if (frames[index].frame_id != index || frames[index].start > input_bytes
        || frames[index].length > input_bytes - frames[index].start
        || frames[index].length > read_u64_le(request + 48U)) {
      free(frames);
      free(input);
      (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, NULL);
      return 0;
    }
  }
  if (!read_exact(input, (size_t)input_bytes)) {
    free(frames);
    free(input);
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_MALFORMED_INPUT_V1, NULL);
    return 0;
  }
  if (fgetc(stdin) != EOF) {
    free(frames);
    free(input);
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, NULL);
    return 0;
  }

  status = av1scope_inspection_adapter_info_v1(&adapter_info);
  if (status != AV1SCOPE_STATUS_OK_V1 || !write_info_record(&adapter_info, worker_sandbox_flags)) {
    free(frames);
    free(input);
    (void)write_record(RESPONSE_ERROR, status == AV1SCOPE_STATUS_OK_V1
      ? AV1SCOPE_STATUS_ADAPTER_ERROR_V1 : status, NULL);
    return 0;
  }
  options.struct_size = (uint32_t)sizeof(options);
  options.abi_version = AV1SCOPE_INSPECTION_ABI_VERSION_V2;
  options.feature_flags = UINT32_C(0);
  options.maximum_blocks_per_chunk = state.maximum_blocks_per_chunk;
  options.maximum_frame_bytes = read_u64_le(request + 48U);
  options.on_block_chunk = consume_blocks;
  options.user_data = &state;
  status = av1scope_inspector_create_v2(&options, &inspector, &output_diagnostic);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    write_diagnostic_to_stderr(&output_diagnostic);
    free(frames);
    free(input);
    (void)write_record(RESPONSE_ERROR, status, NULL);
    return 0;
  }
  for (index = UINT64_C(0); index < frame_count; index += UINT64_C(1)) {
    av1scope_bytes_v1 sample = {
      input + (size_t)frames[index].start, frames[index].length
    };
    state.frame_id = frames[index].frame_id;
    state.next_block_id = UINT64_C(0);
    state.final_seen = UINT32_C(0);
    status = av1scope_inspector_decode_frame_v2(
      inspector, state.frame_id, sample, &call, &output_diagnostic
    );
    if (status != AV1SCOPE_STATUS_OK_V1 || state.final_seen == UINT32_C(0)) {
      write_diagnostic_to_stderr(&output_diagnostic);
      av1scope_inspector_destroy_v2(inspector);
      free(frames);
      free(input);
      if (state.output_failed != UINT32_C(0)) return 3;
      (void)write_scalar_record(RESPONSE_ERROR,
        status == AV1SCOPE_STATUS_OK_V1 ? AV1SCOPE_STATUS_ADAPTER_ERROR_V1 : status,
        state.frame_id, state.total_blocks);
      return 0;
    }
    if (!write_scalar_record(
      RESPONSE_FRAME_END, AV1SCOPE_STATUS_OK_V1, state.frame_id, state.next_block_id
    )) {
      av1scope_inspector_destroy_v2(inspector);
      free(frames);
      free(input);
      return 3;
    }
  }
  status = av1scope_inspector_flush_v2(inspector, &call, &output_diagnostic);
  av1scope_inspector_destroy_v2(inspector);
  free(frames);
  free(input);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    write_diagnostic_to_stderr(&output_diagnostic);
    (void)write_record(RESPONSE_ERROR, status, NULL);
    return 0;
  }
  return write_scalar_record(
    RESPONSE_END, AV1SCOPE_STATUS_END_V1, frame_count, state.total_blocks
  ) ? 0 : 3;
}
