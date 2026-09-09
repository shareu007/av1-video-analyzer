#ifndef AOM_CODEC_H_
#define AOM_CODEC_H_

#include <stddef.h>
#include <stdint.h>

typedef enum aom_codec_err {
  AOM_CODEC_OK = 0,
  AOM_CODEC_ERROR = 1,
  AOM_CODEC_MEM_ERROR = 2,
  AOM_CODEC_ABI_MISMATCH = 3,
  AOM_CODEC_INCAPABLE = 4,
  AOM_CODEC_UNSUP_BITSTREAM = 5,
  AOM_CODEC_UNSUP_FEATURE = 6,
  AOM_CODEC_CORRUPT_FRAME = 7,
  AOM_CODEC_INVALID_PARAM = 8
} aom_codec_err_t;

typedef struct aom_codec_iface aom_codec_iface_t;

typedef void (*aom_inspect_cb_fixture)(void *decoder, void *ctx);

typedef struct aom_codec_ctx {
  aom_inspect_cb_fixture inspect_cb;
  void *inspect_ctx;
  int frame_available;
  const char *detail;
} aom_codec_ctx_t;

const char *aom_codec_error(const aom_codec_ctx_t *codec);
const char *aom_codec_error_detail(const aom_codec_ctx_t *codec);
aom_codec_err_t aom_codec_destroy(aom_codec_ctx_t *codec);
aom_codec_err_t aom_codec_control(aom_codec_ctx_t *codec, int control, ...);

#endif
