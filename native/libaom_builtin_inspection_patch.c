#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "config/aom_config.h"

#if !CONFIG_INSPECTION
#error "libaom must be built with CONFIG_INSPECTION=1"
#endif

#include "aom/aom_codec.h"
#include "aom/aom_decoder.h"
#include "aom/aomdx.h"
#include "av1/common/common_data.h"
#include "av1/decoder/inspection.h"

#include "av1scope_libaom_patch.h"

#define AV1SCOPE_LIBAOM_BUILTIN_FEATURES_V1 \
  (AV1SCOPE_INSPECTION_FEATURE_PARTITION_V1 \
   | AV1SCOPE_INSPECTION_FEATURE_MODE_V1 \
   | AV1SCOPE_INSPECTION_FEATURE_MOTION_VECTOR_V1 \
   | AV1SCOPE_INSPECTION_FEATURE_TRANSFORM_V1 \
   | AV1SCOPE_INSPECTION_FEATURE_COEFFICIENT_V1 \
   | AV1SCOPE_INSPECTION_FEATURE_QINDEX_V1 \
   | AV1SCOPE_INSPECTION_FEATURE_FILTER_V1)

struct av1scope_libaom_patch_decoder {
  aom_codec_ctx_t codec;
  insp_frame_data frame;
  av1scope_libaom_patch_options_v1 options;
  const av1scope_libaom_decode_context_v1 *active_context;
  av1scope_status_v1 callback_status;
  uint8_t *visited;
  size_t visited_capacity;
  int codec_initialized;
  int frame_initialized;
  int inspection_ready;
};

static const uint8_t invalid_argument[] = "invalid libaom inspection argument";
static const uint8_t allocation_failed[] = "libaom inspection allocation failed";
static const uint8_t invalid_inspection[] = "libaom inspection emitted invalid mode-info data";
static const uint8_t inspection_no_progress[] = "libaom inspection decoder did not consume the temporal unit";
static const uint8_t multiple_show_frames[] = "libaom temporal unit produced multiple show frames";

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

static uint64_t unix_time_ms(void) {
  struct timespec now;
  uint64_t seconds;
  if (timespec_get(&now, TIME_UTC) != TIME_UTC || now.tv_sec < 0) return UINT64_C(0);
  seconds = (uint64_t)now.tv_sec;
  if (seconds > UINT64_MAX / UINT64_C(1000)) return UINT64_MAX;
  return seconds * UINT64_C(1000) + (uint64_t)now.tv_nsec / UINT64_C(1000000);
}

static int cancelled(const av1scope_libaom_decode_context_v1 *context) {
  return context != NULL && context->cancelled != NULL
    && context->cancelled(context->cancel_user_data) != UINT32_C(0);
}

static int deadline_expired(const av1scope_libaom_decode_context_v1 *context) {
  uint64_t now;
  if (context == NULL || context->deadline_unix_ms == UINT64_C(0)) return 0;
  now = unix_time_ms();
  return now != UINT64_C(0) && now >= context->deadline_unix_ms;
}

static av1scope_status_v1 map_aom_status(aom_codec_err_t status) {
  switch (status) {
    case AOM_CODEC_OK:
      return AV1SCOPE_STATUS_OK_V1;
    case AOM_CODEC_INVALID_PARAM:
      return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
    case AOM_CODEC_UNSUP_BITSTREAM:
    case AOM_CODEC_CORRUPT_FRAME:
      return AV1SCOPE_STATUS_MALFORMED_INPUT_V1;
    case AOM_CODEC_MEM_ERROR:
      return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
    default:
      return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
}

static void set_aom_diagnostic(
  av1scope_libaom_patch_decoder *decoder,
  av1scope_status_v1 status,
  av1scope_diagnostic_v1 *diagnostic
) {
  const char *detail = aom_codec_error_detail(&decoder->codec);
  if (detail == NULL || detail[0] == '\0') detail = aom_codec_error(&decoder->codec);
  if (detail == NULL) return;
  set_diagnostic(diagnostic, status, (const uint8_t *)detail, (uint32_t)strlen(detail));
}

static void inspect_frame(void *decoder_data, void *user_data) {
  av1scope_libaom_patch_decoder *decoder = (av1scope_libaom_patch_decoder *)user_data;
  if (decoder == NULL || decoder->active_context == NULL) return;
  if (cancelled(decoder->active_context) || deadline_expired(decoder->active_context)) {
    decoder->callback_status = AV1SCOPE_STATUS_CANCELLED_V1;
    return;
  }
  if (ifd_inspect(&decoder->frame, decoder_data, 0) == 0) {
    decoder->callback_status = AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    return;
  }
  decoder->inspection_ready = 1;
}

static int ensure_visited(av1scope_libaom_patch_decoder *decoder, size_t required) {
  uint8_t *replacement;
  if (required <= decoder->visited_capacity) return 1;
  replacement = (uint8_t *)realloc(decoder->visited, required);
  if (replacement == NULL) return 0;
  decoder->visited = replacement;
  decoder->visited_capacity = required;
  return 1;
}

static int valid_reference(int16_t reference) {
  return reference >= INT16_C(-1) && reference <= INT16_C(7);
}

static uint8_t map_reference(int16_t reference) {
  return reference >= INT16_C(1) && reference <= INT16_C(7)
    ? (uint8_t)reference
    : AV1SCOPE_BLOCK_NONE_U8;
}

static int map_partition(int16_t partition, uint8_t *mapped) {
  if (mapped == NULL) return 0;
  switch (partition) {
    case PARTITION_NONE: *mapped = (uint8_t)AV1SCOPE_PARTITION_NONE_V1; return 1;
    case PARTITION_SPLIT: *mapped = (uint8_t)AV1SCOPE_PARTITION_SPLIT_V1; return 1;
    case PARTITION_HORZ: *mapped = (uint8_t)AV1SCOPE_PARTITION_HORZ_V1; return 1;
    case PARTITION_VERT: *mapped = (uint8_t)AV1SCOPE_PARTITION_VERT_V1; return 1;
    case PARTITION_HORZ_A: *mapped = (uint8_t)AV1SCOPE_PARTITION_HORZ_A_V1; return 1;
    case PARTITION_HORZ_B: *mapped = (uint8_t)AV1SCOPE_PARTITION_HORZ_B_V1; return 1;
    case PARTITION_VERT_A: *mapped = (uint8_t)AV1SCOPE_PARTITION_VERT_A_V1; return 1;
    case PARTITION_VERT_B: *mapped = (uint8_t)AV1SCOPE_PARTITION_VERT_B_V1; return 1;
    case PARTITION_HORZ_4: *mapped = (uint8_t)AV1SCOPE_PARTITION_HORZ_4_V1; return 1;
    case PARTITION_VERT_4: *mapped = (uint8_t)AV1SCOPE_PARTITION_VERT_4_V1; return 1;
    default: return 0;
  }
}

static int pack_filter_summary(const insp_mi_data *mi, int32_t *summary) {
  uint32_t filter_0;
  uint32_t filter_1;
  uint32_t cdef_level;
  uint32_t cdef_strength;
  if (mi->filter[0] < 0 || mi->filter[0] > 15
      || mi->filter[1] < 0 || mi->filter[1] > 15
      || mi->cdef_level < 0 || mi->cdef_level > 255
      || mi->cdef_strength < 0 || mi->cdef_strength > 255) return 0;
  filter_0 = (uint32_t)mi->filter[0];
  filter_1 = (uint32_t)mi->filter[1];
  cdef_level = (uint32_t)mi->cdef_level;
  cdef_strength = (uint32_t)mi->cdef_strength;
  *summary = (int32_t)(filter_0 | (filter_1 << 4U)
    | (cdef_level << 8U) | (cdef_strength << 16U));
  return 1;
}

static av1scope_status_v1 emit_frame(
  av1scope_libaom_patch_decoder *decoder,
  uint32_t frame_width,
  uint32_t frame_height,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *diagnostic
) {
  size_t cells;
  int row;
  int column;
  if (decoder->frame.mi_rows <= 0 || decoder->frame.mi_cols <= 0
      || decoder->frame.mi_grid == NULL
      || decoder->frame.base_qindex < 0 || decoder->frame.base_qindex > 255) {
    set_diagnostic(diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
      invalid_inspection, (uint32_t)(sizeof(invalid_inspection) - 1U));
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  if ((size_t)decoder->frame.mi_rows > SIZE_MAX / (size_t)decoder->frame.mi_cols) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if ((uint32_t)decoder->frame.mi_rows > UINT32_MAX / UINT32_C(4)
      || (uint32_t)decoder->frame.mi_cols > UINT32_MAX / UINT32_C(4)) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  cells = (size_t)decoder->frame.mi_rows * (size_t)decoder->frame.mi_cols;
  if (!ensure_visited(decoder, cells)) {
    set_diagnostic(diagnostic, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1,
      allocation_failed, (uint32_t)(sizeof(allocation_failed) - 1U));
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  (void)memset(decoder->visited, 0, cells);
  if (frame_width == UINT32_C(0)) frame_width = (uint32_t)decoder->frame.mi_cols * UINT32_C(4);
  if (frame_height == UINT32_C(0)) frame_height = (uint32_t)decoder->frame.mi_rows * UINT32_C(4);

  for (row = 0; row < decoder->frame.mi_rows; row += 1) {
    for (column = 0; column < decoder->frame.mi_cols; column += 1) {
      const size_t index = (size_t)row * (size_t)decoder->frame.mi_cols + (size_t)column;
      const insp_mi_data *mi;
      int block_columns;
      int block_rows;
      int mark_row;
      int mark_column;
      uint32_t x;
      uint32_t y;
      uint32_t width;
      uint32_t height;
      av1scope_libaom_block_event_v1 event;
      av1scope_status_v1 status;
      if (decoder->visited[index] != UINT8_C(0)) continue;
      if (cancelled(context) || deadline_expired(context)) return AV1SCOPE_STATUS_CANCELLED_V1;
      mi = &decoder->frame.mi_grid[index];
      if (mi->bsize < 0 || mi->bsize >= BLOCK_SIZES_ALL
          || !valid_reference(mi->ref_frame[0]) || !valid_reference(mi->ref_frame[1])
          || mi->mode < 0 || mi->segment_id < 0 || mi->segment_id > 7
          || mi->current_qindex < 0 || mi->current_qindex > 255
          || mi->coeff_non_zero < 0) {
        set_diagnostic(diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
          invalid_inspection, (uint32_t)(sizeof(invalid_inspection) - 1U));
        return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
      }
      block_columns = mi_size_wide[mi->bsize];
      block_rows = mi_size_high[mi->bsize];
      if (block_columns <= 0 || block_rows <= 0) {
        set_diagnostic(diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
          invalid_inspection, (uint32_t)(sizeof(invalid_inspection) - 1U));
        return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
      }
      for (mark_row = row;
           mark_row < decoder->frame.mi_rows && mark_row < row + block_rows;
           mark_row += 1) {
        for (mark_column = column;
             mark_column < decoder->frame.mi_cols && mark_column < column + block_columns;
             mark_column += 1) {
          decoder->visited[(size_t)mark_row * (size_t)decoder->frame.mi_cols
            + (size_t)mark_column] = UINT8_C(1);
        }
      }
      x = (uint32_t)column * UINT32_C(4);
      y = (uint32_t)row * UINT32_C(4);
      if (x >= frame_width || y >= frame_height) continue;
      width = (uint32_t)block_columns * UINT32_C(4);
      height = (uint32_t)block_rows * UINT32_C(4);
      if (width > frame_width - x) width = frame_width - x;
      if (height > frame_height - y) height = frame_height - y;

      (void)memset(&event, 0, sizeof(event));
      event.struct_size = (uint32_t)sizeof(event);
      event.abi_version = AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1;
      event.x = x;
      event.y = y;
      event.width = width;
      event.height = height;
      event.partition = (uint8_t)AV1SCOPE_PARTITION_UNKNOWN_V1;
      event.segment_id = (uint8_t)mi->segment_id;
      event.reference_0 = AV1SCOPE_BLOCK_NONE_U8;
      event.reference_1 = AV1SCOPE_BLOCK_NONE_U8;
      event.intra_mode = AV1SCOPE_BLOCK_NONE_I16;
      event.inter_mode = AV1SCOPE_BLOCK_NONE_I16;
      event.tx_size = AV1SCOPE_BLOCK_NONE_I16;
      event.tx_type = AV1SCOPE_BLOCK_NONE_I16;
      event.coeff_non_zero = AV1SCOPE_BLOCK_NONE_I32;
      event.filter_summary = AV1SCOPE_BLOCK_NONE_I32;
      event.detail_flags = AV1SCOPE_BLOCK_DETAIL_MI_COORDINATES_V2;
      event.mi_row = (uint32_t)row;
      event.mi_column = (uint32_t)column;

      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_PARTITION_V1) != 0U
          && !map_partition(mi->partition, &event.partition)) {
        set_diagnostic(diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
          invalid_inspection, (uint32_t)(sizeof(invalid_inspection) - 1U));
        return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
      }

      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_MODE_V1) != 0U) {
        if (mi->mode < INTRA_MODES) {
          event.mode = (uint8_t)AV1SCOPE_BLOCK_MODE_INTRA_V1;
          event.intra_mode = mi->mode;
        } else {
          event.mode = (uint8_t)AV1SCOPE_BLOCK_MODE_INTER_V1;
          event.inter_mode = mi->mode;
        }
        if (mi->skip != 0) event.flags |= AV1SCOPE_BLOCK_FLAG_SKIP_V1;
      }
      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_MOTION_VECTOR_V1) != 0U) {
        unsigned int slot;
        event.reference_0 = map_reference(mi->ref_frame[0]);
        event.reference_1 = map_reference(mi->ref_frame[1]);
        for (slot = 0U; slot < 2U; slot += 1U) {
          if (map_reference(mi->ref_frame[slot]) != AV1SCOPE_BLOCK_NONE_U8) {
            event.motion_vectors[slot].row = mi->mv[slot].row;
            event.motion_vectors[slot].column = mi->mv[slot].col;
            event.motion_vectors[slot].precision = UINT8_C(3);
            event.motion_vectors[slot].valid = UINT8_C(1);
          }
        }
        if (event.reference_1 != AV1SCOPE_BLOCK_NONE_U8) {
          event.detail_flags |= AV1SCOPE_BLOCK_DETAIL_COMPOUND_TYPE_V2;
          event.compound_type = mi->compound_type;
        }
      }
      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_TRANSFORM_V1) != 0U) {
        event.tx_size = mi->tx_size;
        event.tx_type = mi->tx_type;
      }
      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_COEFFICIENT_V1) != 0U) {
        event.coeff_non_zero = mi->coeff_non_zero;
      }
      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_QINDEX_V1) != 0U) {
        event.flags |= AV1SCOPE_BLOCK_FLAG_QINDEX_VALID_V1;
        event.qindex = (uint8_t)mi->current_qindex;
        event.detail_flags |= AV1SCOPE_BLOCK_DETAIL_QUANT_DELTA_V2;
        event.quant_delta = (int16_t)(mi->current_qindex - decoder->frame.base_qindex);
      }
      if ((decoder->options.feature_flags & AV1SCOPE_INSPECTION_FEATURE_FILTER_V1) != 0U
          && !pack_filter_summary(mi, &event.filter_summary)) {
        set_diagnostic(diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
          invalid_inspection, (uint32_t)(sizeof(invalid_inspection) - 1U));
        return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
      }
      status = context->emit_block(context->emit_user_data, &event);
      if (status != AV1SCOPE_STATUS_OK_V1) return status;
    }
  }
  return AV1SCOPE_STATUS_OK_V1;
}

uint32_t av1scope_libaom_patch_feature_flags_v1(void) {
  return AV1SCOPE_LIBAOM_BUILTIN_FEATURES_V1;
}

av1scope_status_v1 av1scope_libaom_patch_decoder_create_v1(
  const av1scope_libaom_patch_options_v1 *options,
  av1scope_libaom_patch_decoder **out_decoder,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_libaom_patch_decoder *decoder;
  aom_codec_dec_cfg_t config;
  aom_inspect_init inspection;
  aom_codec_err_t aom_status;
  if (options == NULL || out_decoder == NULL || options->struct_size < sizeof(*options)
      || options->reserved != UINT32_C(0)
      || options->maximum_frame_bytes == UINT64_C(0)
      || options->maximum_frame_bytes > AV1SCOPE_MAX_SAMPLE_BYTES_V1
      || (options->feature_flags & ~AV1SCOPE_LIBAOM_BUILTIN_FEATURES_V1) != UINT32_C(0)) {
    set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1,
      invalid_argument, (uint32_t)(sizeof(invalid_argument) - 1U));
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_decoder = NULL;
  if (options->abi_version != AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  decoder = (av1scope_libaom_patch_decoder *)calloc(1U, sizeof(*decoder));
  if (decoder == NULL) return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  decoder->options = *options;
  if (decoder->options.feature_flags == UINT32_C(0)) {
    decoder->options.feature_flags = AV1SCOPE_LIBAOM_BUILTIN_FEATURES_V1;
  }
  (void)memset(&config, 0, sizeof(config));
  config.threads = 1U;
  config.allow_lowbitdepth = 1U;
  aom_status = aom_codec_dec_init(&decoder->codec, aom_codec_av1_dx(), &config, 0U);
  if (aom_status != AOM_CODEC_OK) {
    av1scope_status_v1 status = map_aom_status(aom_status);
    set_aom_diagnostic(decoder, status, out_diagnostic);
    av1scope_libaom_patch_decoder_destroy_v1(decoder);
    return status;
  }
  decoder->codec_initialized = 1;
  ifd_init(&decoder->frame, 4, 4);
  decoder->frame_initialized = 1;
  inspection.inspect_cb = inspect_frame;
  inspection.inspect_ctx = decoder;
  aom_status = aom_codec_control(
    &decoder->codec, AV1_SET_INSPECTION_CALLBACK, &inspection
  );
  if (aom_status != AOM_CODEC_OK) {
    av1scope_status_v1 status = map_aom_status(aom_status);
    set_aom_diagnostic(decoder, status, out_diagnostic);
    av1scope_libaom_patch_decoder_destroy_v1(decoder);
    return status;
  }
  *out_decoder = decoder;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_libaom_patch_decode_frame_v1(
  av1scope_libaom_patch_decoder *decoder,
  av1scope_bytes_v1 sample,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  const uint8_t *cursor;
  const uint8_t *end;
  aom_codec_iter_t iterator = NULL;
  aom_image_t *image;
  int emitted_show_frame = 0;
  if (decoder == NULL || context == NULL || context->struct_size < sizeof(*context)
      || context->emit_block == NULL || sample.data == NULL || sample.length == UINT64_C(0)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (context->abi_version != AV1SCOPE_LIBAOM_PATCH_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if (sample.length > decoder->options.maximum_frame_bytes || sample.length > SIZE_MAX) {
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if (cancelled(context) || deadline_expired(context)) return AV1SCOPE_STATUS_CANCELLED_V1;
  decoder->active_context = context;
  cursor = sample.data;
  end = sample.data + (size_t)sample.length;
  while (cursor < end) {
    Av1DecodeReturn decode_return;
    aom_codec_err_t aom_status;
    av1scope_status_v1 status;
    decoder->callback_status = AV1SCOPE_STATUS_OK_V1;
    decoder->inspection_ready = 0;
    (void)memset(&decode_return, 0, sizeof(decode_return));
    aom_status = aom_codec_decode(
      &decoder->codec, cursor, (size_t)(end - cursor), &decode_return
    );
    if (aom_status != AOM_CODEC_OK) {
      status = map_aom_status(aom_status);
      decoder->active_context = NULL;
      set_aom_diagnostic(decoder, status, out_diagnostic);
      return status;
    }
    if (decoder->callback_status != AV1SCOPE_STATUS_OK_V1) {
      decoder->active_context = NULL;
      return decoder->callback_status;
    }
    if (decode_return.buf == NULL || decode_return.buf <= cursor || decode_return.buf > end) {
      decoder->active_context = NULL;
      set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
        inspection_no_progress, (uint32_t)(sizeof(inspection_no_progress) - 1U));
      return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    }
    if (decoder->inspection_ready
        && !decoder->frame.show_existing_frame && decoder->frame.show_frame) {
      if (emitted_show_frame) {
        decoder->active_context = NULL;
        set_diagnostic(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1,
          multiple_show_frames, (uint32_t)(sizeof(multiple_show_frames) - 1U));
        return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
      }
      status = emit_frame(
        decoder,
        decoder->frame.frame_width > 0 ? (uint32_t)decoder->frame.frame_width : UINT32_C(0),
        decoder->frame.frame_height > 0 ? (uint32_t)decoder->frame.frame_height : UINT32_C(0),
        context,
        out_diagnostic
      );
      if (status != AV1SCOPE_STATUS_OK_V1) {
        decoder->active_context = NULL;
        return status;
      }
      emitted_show_frame = 1;
    }
    cursor = decode_return.buf;
  }
  decoder->active_context = NULL;
  do {
    image = aom_codec_get_frame(&decoder->codec, &iterator);
  } while (image != NULL);
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_libaom_patch_flush_v1(
  av1scope_libaom_patch_decoder *decoder,
  const av1scope_libaom_decode_context_v1 *context,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  aom_codec_err_t aom_status;
  av1scope_status_v1 status;
  if (decoder == NULL || context == NULL || context->struct_size < sizeof(*context)) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (cancelled(context) || deadline_expired(context)) return AV1SCOPE_STATUS_CANCELLED_V1;
  aom_status = aom_codec_decode(&decoder->codec, NULL, 0U, NULL);
  status = map_aom_status(aom_status);
  if (status != AV1SCOPE_STATUS_OK_V1) set_aom_diagnostic(decoder, status, out_diagnostic);
  return status;
}

void av1scope_libaom_patch_decoder_destroy_v1(
  av1scope_libaom_patch_decoder *decoder
) {
  if (decoder == NULL) return;
  if (decoder->frame_initialized) ifd_clear(&decoder->frame);
  if (decoder->codec_initialized) (void)aom_codec_destroy(&decoder->codec);
  free(decoder->visited);
  free(decoder);
}
