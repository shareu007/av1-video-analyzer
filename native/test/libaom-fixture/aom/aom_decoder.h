#ifndef AOM_DECODER_H_
#define AOM_DECODER_H_

#include "aom/aom_codec.h"

typedef struct aom_codec_dec_cfg {
  unsigned int threads;
  unsigned int w;
  unsigned int h;
  unsigned int allow_lowbitdepth;
} aom_codec_dec_cfg_t;

typedef struct aom_image {
  unsigned int d_w;
  unsigned int d_h;
} aom_image_t;

typedef void *aom_codec_iter_t;

aom_codec_err_t aom_codec_dec_init(
  aom_codec_ctx_t *codec,
  aom_codec_iface_t *interface_value,
  const aom_codec_dec_cfg_t *config,
  unsigned long flags
);
aom_codec_err_t aom_codec_decode(
  aom_codec_ctx_t *codec,
  const uint8_t *data,
  size_t data_size,
  void *user_priv
);
aom_image_t *aom_codec_get_frame(aom_codec_ctx_t *codec, aom_codec_iter_t *iterator);

#endif
