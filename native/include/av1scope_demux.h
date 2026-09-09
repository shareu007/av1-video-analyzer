#ifndef AV1SCOPE_DEMUX_H
#define AV1SCOPE_DEMUX_H

#include "av1scope_abi.h"

#ifdef __cplusplus
extern "C" {
#endif

#define AV1SCOPE_DEMUX_FEATURE_READ_AT_V1 UINT32_C(1)
#define AV1SCOPE_DEMUX_FEATURE_PACKET_FLAGS_V1 UINT32_C(2)
#define AV1SCOPE_SAMPLE_FLAG_KEYFRAME_V1 UINT32_C(1)
#define AV1SCOPE_SAMPLE_FLAG_DISCARD_V1 UINT32_C(2)
#define AV1SCOPE_SAMPLE_FLAG_CORRUPT_V1 UINT32_C(4)

typedef struct av1scope_demux av1scope_demux;

typedef int64_t (*av1scope_read_at_fn_v1)(
  void *user_data,
  uint64_t offset,
  uint8_t *destination,
  uint64_t capacity
);

/* read_at returns 0..capacity bytes, 0 at EOF, and a negative value on error.
 * The adapter must not retain destination or invoke read_at after close. */

typedef struct av1scope_demux_source_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t source_bytes;
  av1scope_read_at_fn_v1 read_at;
  void *user_data;
} av1scope_demux_source_v1;

typedef struct av1scope_demux_options_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  int32_t requested_track_id;
  uint32_t flags;
  uint64_t maximum_probe_bytes;
  uint64_t maximum_sample_bytes;
} av1scope_demux_options_v1;

typedef struct av1scope_stream_info_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  int32_t track_id;
  uint32_t codec_fourcc;
  uint32_t width;
  uint32_t height;
  int32_t time_base_num;
  int32_t time_base_den;
  uint64_t sample_count;
} av1scope_stream_info_v1;

typedef struct av1scope_sample_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t sample_id;
  int32_t track_id;
  uint32_t flags;
  int64_t dts;
  int64_t pts;
  int64_t duration;
  av1scope_byte_range_v1 source_range;
} av1scope_sample_v1;

AV1SCOPE_API av1scope_status_v1 av1scope_demux_adapter_info_v1(
  av1scope_adapter_info_v1 *out_info
);

AV1SCOPE_API av1scope_status_v1 av1scope_demux_open_v1(
  const av1scope_demux_source_v1 *source,
  const av1scope_demux_options_v1 *options,
  const av1scope_call_context_v1 *call,
  av1scope_demux **out_demux,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API av1scope_status_v1 av1scope_demux_stream_info_v1(
  av1scope_demux *demux,
  av1scope_stream_info_v1 *out_stream,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API av1scope_status_v1 av1scope_demux_next_sample_v1(
  av1scope_demux *demux,
  const av1scope_call_context_v1 *call,
  av1scope_sample_v1 *out_sample,
  av1scope_diagnostic_v1 *out_diagnostic
);

AV1SCOPE_API void av1scope_demux_close_v1(av1scope_demux *demux);

/* close accepts NULL. Every successful open transfers exactly one handle to
 * the caller. No AVPacket/AVFrame/AVFormatContext pointer crosses this ABI. */

#ifdef __cplusplus
}
#endif

#endif
