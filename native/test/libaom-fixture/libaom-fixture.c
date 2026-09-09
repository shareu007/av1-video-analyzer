#include <stdarg.h>
#include <stdlib.h>
#include <string.h>

#include "aom/aom_decoder.h"
#include "aom/aomdx.h"
#include "av1/common/enums.h"
#include "av1/decoder/inspection.h"

struct aom_codec_iface {
  int unused;
};

typedef struct fixture_decoder {
  unsigned int width;
  unsigned int height;
  int show_existing;
  int show_frame;
} fixture_decoder;

const int mi_size_wide[BLOCK_SIZES_ALL] = {2, 2, 1};
const int mi_size_high[BLOCK_SIZES_ALL] = {2, 1, 1};

static struct aom_codec_iface interface_value;
static fixture_decoder decoded = {16U, 8U, 0, 1};
static aom_image_t image = {16U, 8U};

static insp_mi_data make_mi(
  int16_t mode,
  int16_t bsize,
  int16_t qindex,
  int16_t ref0,
  int16_t ref1,
  int16_t partition,
  int32_t coeff_non_zero
) {
  insp_mi_data value;
  (void)memset(&value, 0, sizeof(value));
  value.mode = mode;
  value.bsize = bsize;
  value.current_qindex = qindex;
  value.ref_frame[0] = ref0;
  value.ref_frame[1] = ref1;
  value.segment_id = 2;
  value.filter[0] = 1;
  value.filter[1] = 2;
  value.cdef_level = 3;
  value.cdef_strength = 4;
  value.tx_size = 2;
  value.tx_type = 1;
  value.mv[0].row = -2;
  value.mv[0].col = 4;
  value.mv[1].row = 6;
  value.mv[1].col = -8;
  value.compound_type = 5;
  value.partition = partition;
  value.coeff_non_zero = coeff_non_zero;
  return value;
}

aom_codec_iface_t *aom_codec_av1_dx(void) {
  return &interface_value;
}

aom_codec_err_t aom_codec_dec_init(
  aom_codec_ctx_t *codec,
  aom_codec_iface_t *interface_pointer,
  const aom_codec_dec_cfg_t *config,
  unsigned long flags
) {
  (void)interface_pointer;
  (void)flags;
  if (codec == NULL || config == NULL || config->threads != 1U) return AOM_CODEC_INVALID_PARAM;
  (void)memset(codec, 0, sizeof(*codec));
  return AOM_CODEC_OK;
}

aom_codec_err_t aom_codec_control(aom_codec_ctx_t *codec, int control, ...) {
  va_list arguments;
  aom_inspect_init *inspection;
  if (codec == NULL || control != AV1_SET_INSPECTION_CALLBACK) return AOM_CODEC_INVALID_PARAM;
  va_start(arguments, control);
  inspection = va_arg(arguments, aom_inspect_init *);
  va_end(arguments);
  if (inspection == NULL || inspection->inspect_cb == NULL) return AOM_CODEC_INVALID_PARAM;
  codec->inspect_cb = inspection->inspect_cb;
  codec->inspect_ctx = inspection->inspect_ctx;
  return AOM_CODEC_OK;
}

aom_codec_err_t aom_codec_decode(
  aom_codec_ctx_t *codec,
  const uint8_t *data,
  size_t data_size,
  void *user_priv
) {
  Av1DecodeReturn *result = (Av1DecodeReturn *)user_priv;
  if (codec == NULL) return AOM_CODEC_INVALID_PARAM;
  if (data == NULL && data_size == 0U) return AOM_CODEC_OK;
  if (data == NULL || data_size == 0U || user_priv == NULL) return AOM_CODEC_INVALID_PARAM;
  if (data[0] == UINT8_C(0xee)) {
    codec->detail = "fixture malformed frame";
    return AOM_CODEC_CORRUPT_FRAME;
  }
  if (data[0] == UINT8_C(0x67)) {
    result->buf = data + 1U;
    result->idx = -1;
    result->show_existing = 0;
    return AOM_CODEC_OK;
  }
  decoded.show_existing = data[0] == UINT8_C(0x55);
  decoded.show_frame = data[0] != UINT8_C(0x66);
  if (codec->inspect_cb == NULL) return AOM_CODEC_INCAPABLE;
  codec->inspect_cb(&decoded, codec->inspect_ctx);
  result->buf = data + (data[0] == UINT8_C(0x66) ? 1U : data_size);
  result->idx = -1;
  result->show_existing = decoded.show_existing;
  codec->frame_available = 1;
  return AOM_CODEC_OK;
}

aom_image_t *aom_codec_get_frame(aom_codec_ctx_t *codec, aom_codec_iter_t *iterator) {
  if (codec == NULL || iterator == NULL || !codec->frame_available) return NULL;
  codec->frame_available = 0;
  return &image;
}

const char *aom_codec_error(const aom_codec_ctx_t *codec) {
  (void)codec;
  return "fixture libaom error";
}

const char *aom_codec_error_detail(const aom_codec_ctx_t *codec) {
  return codec == NULL ? NULL : codec->detail;
}

aom_codec_err_t aom_codec_destroy(aom_codec_ctx_t *codec) {
  if (codec != NULL) (void)memset(codec, 0, sizeof(*codec));
  return AOM_CODEC_OK;
}

void ifd_init(insp_frame_data *frame, int frame_width, int frame_height) {
  (void)frame_width;
  (void)frame_height;
  (void)memset(frame, 0, sizeof(*frame));
  frame->mi_grid = (insp_mi_data *)calloc(1U, sizeof(*frame->mi_grid));
  frame->mi_rows = 1;
  frame->mi_cols = 1;
}

void ifd_clear(insp_frame_data *frame) {
  free(frame->mi_grid);
  frame->mi_grid = NULL;
}

int ifd_inspect(insp_frame_data *frame, void *decoder, int skip_not_transform) {
  insp_mi_data *grid;
  insp_mi_data first;
  insp_mi_data second;
  insp_mi_data third;
  (void)skip_not_transform;
  if (frame == NULL || decoder != &decoded) return 0;
  grid = (insp_mi_data *)realloc(frame->mi_grid, 8U * sizeof(*grid));
  if (grid == NULL) return 0;
  frame->mi_grid = grid;
  frame->mi_rows = 2;
  frame->mi_cols = 4;
  frame->frame_width = (int)decoded.width;
  frame->frame_height = (int)decoded.height;
  frame->show_frame = decoded.show_frame;
  frame->base_qindex = 90;
  frame->show_existing_frame = decoded.show_existing;
  first = make_mi(1, 0, 92, -1, -1, PARTITION_SPLIT, 4);
  second = make_mi(14, 1, 255, 1, 7, PARTITION_HORZ, 2);
  third = make_mi(13, 1, 80, 2, -1, PARTITION_VERT, 3);
  grid[0] = first;
  grid[1] = first;
  grid[2] = second;
  grid[3] = second;
  grid[4] = first;
  grid[5] = first;
  grid[6] = third;
  grid[7] = third;
  return 1;
}
