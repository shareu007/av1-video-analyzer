#ifndef AOMDX_H_
#define AOMDX_H_

#include "aom/aom_decoder.h"

typedef void (*aom_inspect_cb)(void *decoder, void *ctx);

typedef struct aom_inspect_init {
  aom_inspect_cb inspect_cb;
  void *inspect_ctx;
} aom_inspect_init;

typedef struct Av1DecodeReturn {
  const unsigned char *buf;
  int idx;
  int show_existing;
} Av1DecodeReturn;

#define AV1_SET_INSPECTION_CALLBACK 256

aom_codec_iface_t *aom_codec_av1_dx(void);

#endif
