#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/codec_id.h>
#include <libavcodec/packet.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavutil/error.h>
#include <libavutil/mem.h>
#include <libavutil/time.h>

#include "av1scope_demux.h"

#define AV1SCOPE_IO_BUFFER_BYTES 32768
#define AV1SCOPE_AV01_FOURCC UINT32_C(0x31307661)

typedef struct av1scope_source_bridge_v1 {
  av1scope_demux_source_v1 source;
  uint64_t position;
  uint64_t bytes_read;
  uint64_t maximum_read_bytes;
  int read_limit_reached;
} av1scope_source_bridge_v1;

struct av1scope_demux {
  av1scope_source_bridge_v1 bridge;
  AVFormatContext *format;
  AVIOContext *io;
  AVPacket *packet;
  int format_opened;
  int stream_index;
  uint64_t next_sample_id;
  uint64_t maximum_sample_bytes;
  av1scope_call_context_v1 active_call;
  int has_active_call;
};

static const uint8_t adapter_name[] = "av1scope-libavformat";
static const uint8_t adapter_build[] = LIBAVFORMAT_IDENT;
static const uint8_t invalid_argument[] = "invalid adapter argument";
static const uint8_t allocation_failed[] = "adapter allocation failed";
static const uint8_t open_failed[] = "libavformat could not open the custom input";
static const uint8_t stream_info_failed[] = "libavformat stream probing failed";
static const uint8_t av1_stream_missing[] = "no AV1 video stream matched the request";
static const uint8_t packet_read_failed[] = "libavformat packet read failed";
static const uint8_t packet_position_missing[] = "packet has no source byte position";
static const uint8_t packet_range_invalid[] = "packet source range is outside input";
static const uint8_t packet_budget_exceeded[] = "packet exceeds the sample byte budget";
static const uint8_t probe_budget_exceeded[] = "input probing exceeded the byte budget";
static const uint8_t identifier_exhausted[] = "sample identifier space exhausted";

static int has_struct_prefix(uint32_t actual, size_t required) {
  return required <= UINT32_MAX && actual >= (uint32_t)required;
}

static void clear_diagnostic(av1scope_diagnostic_v1 *diagnostic) {
  if (diagnostic == NULL || !has_struct_prefix(diagnostic->struct_size, sizeof(*diagnostic))) {
    return;
  }
  diagnostic->status = AV1SCOPE_STATUS_OK_V1;
  diagnostic->message_utf8 = NULL;
  diagnostic->message_bytes = UINT32_C(0);
  diagnostic->reserved = UINT32_C(0);
}

static void set_diagnostic(
  av1scope_diagnostic_v1 *diagnostic,
  av1scope_status_v1 status,
  const uint8_t *message,
  size_t message_bytes
) {
  if (diagnostic == NULL || !has_struct_prefix(diagnostic->struct_size, sizeof(*diagnostic))) {
    return;
  }
  diagnostic->status = status;
  diagnostic->message_utf8 = message;
  diagnostic->message_bytes = message_bytes > UINT32_MAX
    ? UINT32_MAX
    : (uint32_t)message_bytes;
  diagnostic->reserved = UINT32_C(0);
}

#define SET_DIAGNOSTIC(diagnostic, status, message) \
  set_diagnostic((diagnostic), (status), (message), sizeof(message) - 1U)

static int validate_call(const av1scope_call_context_v1 *call) {
  return call == NULL
    || (has_struct_prefix(call->struct_size, sizeof(*call))
        && call->abi_version == AV1SCOPE_ABI_VERSION_V1);
}

static int call_cancelled(const av1scope_call_context_v1 *call) {
  if (call == NULL) {
    return 0;
  }
  if (call->cancelled != NULL && call->cancelled(call->user_data) != UINT32_C(0)) {
    return 1;
  }
  return call->deadline_unix_ms != UINT64_C(0)
    && call->deadline_unix_ms <= (uint64_t)(av_gettime() / INT64_C(1000));
}

static void activate_call(
  av1scope_demux *demux,
  const av1scope_call_context_v1 *call
) {
  if (call == NULL) {
    demux->has_active_call = 0;
    return;
  }
  demux->active_call = *call;
  demux->has_active_call = 1;
}

static int interrupt_callback(void *opaque) {
  const av1scope_demux *demux = (const av1scope_demux *)opaque;
  return demux != NULL && demux->has_active_call
    ? call_cancelled(&demux->active_call)
    : 0;
}

static int read_packet(void *opaque, uint8_t *buffer, int buffer_size) {
  av1scope_source_bridge_v1 *bridge = (av1scope_source_bridge_v1 *)opaque;
  uint64_t remaining;
  uint64_t requested;
  int64_t result;
  if (bridge == NULL || buffer == NULL || buffer_size <= 0) {
    return AVERROR(EINVAL);
  }
  if (bridge->position >= bridge->source.source_bytes) {
    return AVERROR_EOF;
  }
  remaining = bridge->source.source_bytes - bridge->position;
  requested = (uint64_t)buffer_size < remaining ? (uint64_t)buffer_size : remaining;
  if (bridge->bytes_read >= bridge->maximum_read_bytes) {
    bridge->read_limit_reached = 1;
    return AVERROR(ENOMEM);
  }
  if (requested > bridge->maximum_read_bytes - bridge->bytes_read) {
    requested = bridge->maximum_read_bytes - bridge->bytes_read;
  }
  if (requested == UINT64_C(0)) {
    bridge->read_limit_reached = 1;
    return AVERROR(ENOMEM);
  }
  result = bridge->source.read_at(
    bridge->source.user_data,
    bridge->position,
    buffer,
    requested
  );
  if (result < INT64_C(0)) {
    return AVERROR(EIO);
  }
  if (result == INT64_C(0)) {
    return AVERROR(EIO);
  }
  if ((uint64_t)result > requested || result > INT_MAX) {
    return AVERROR(EIO);
  }
  bridge->position += (uint64_t)result;
  bridge->bytes_read += (uint64_t)result;
  return (int)result;
}

static int64_t seek_source(void *opaque, int64_t offset, int whence) {
  av1scope_source_bridge_v1 *bridge = (av1scope_source_bridge_v1 *)opaque;
  int origin;
  int64_t base;
  int64_t target;
  if (bridge == NULL || bridge->source.source_bytes > (uint64_t)INT64_MAX) {
    return AVERROR(EOVERFLOW);
  }
  if ((whence & AVSEEK_SIZE) != 0) {
    return (int64_t)bridge->source.source_bytes;
  }
  origin = whence & ~AVSEEK_FORCE;
  if (origin == SEEK_SET) {
    base = INT64_C(0);
  } else if (origin == SEEK_CUR) {
    base = (int64_t)bridge->position;
  } else if (origin == SEEK_END) {
    base = (int64_t)bridge->source.source_bytes;
  } else {
    return AVERROR(EINVAL);
  }
  if ((offset > 0 && base > INT64_MAX - offset)
      || (offset < 0 && base < INT64_MIN - offset)) {
    return AVERROR(EOVERFLOW);
  }
  target = base + offset;
  if (target < INT64_C(0) || (uint64_t)target > bridge->source.source_bytes) {
    return AVERROR(EINVAL);
  }
  bridge->position = (uint64_t)target;
  return target;
}

static void destroy_demux(av1scope_demux *demux) {
  if (demux == NULL) {
    return;
  }
  av_packet_free(&demux->packet);
  if (demux->format != NULL) {
    if (demux->format_opened) {
      avformat_close_input(&demux->format);
    } else {
      avformat_free_context(demux->format);
      demux->format = NULL;
    }
  }
  avio_context_free(&demux->io);
  free(demux);
}

static av1scope_status_v1 validate_output_prefix(
  uint32_t struct_size,
  uint32_t abi_version
) {
  if (abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  return struct_size == UINT32_C(0)
    ? AV1SCOPE_STATUS_INVALID_ARGUMENT_V1
    : AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_adapter_info_v1(
  av1scope_adapter_info_v1 *out_info
) {
  av1scope_status_v1 status;
  if (out_info == NULL || !has_struct_prefix(out_info->struct_size, sizeof(*out_info))) {
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  status = validate_output_prefix(out_info->struct_size, out_info->abi_version);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    return status;
  }
  out_info->name_utf8 = adapter_name;
  out_info->name_bytes = (uint32_t)(sizeof(adapter_name) - 1U);
  out_info->reserved_0 = UINT32_C(0);
  out_info->build_utf8 = adapter_build;
  out_info->build_bytes = (uint32_t)(sizeof(adapter_build) - 1U);
  out_info->feature_flags = AV1SCOPE_DEMUX_FEATURE_READ_AT_V1
    | AV1SCOPE_DEMUX_FEATURE_PACKET_FLAGS_V1;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_open_v1(
  const av1scope_demux_source_v1 *source,
  const av1scope_demux_options_v1 *options,
  const av1scope_call_context_v1 *call,
  av1scope_demux **out_demux,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  av1scope_demux *demux;
  uint8_t *io_buffer;
  AVDictionary *format_options = NULL;
  int result;
  unsigned int stream_index;
  clear_diagnostic(out_diagnostic);
  if (out_demux == NULL) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, invalid_argument);
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  *out_demux = NULL;
  if (source == NULL || options == NULL
      || !has_struct_prefix(source->struct_size, sizeof(*source))
      || !has_struct_prefix(options->struct_size, sizeof(*options))
      || source->read_at == NULL || !validate_call(call)) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, invalid_argument);
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (source->abi_version != AV1SCOPE_ABI_VERSION_V1
      || options->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if (options->requested_track_id < INT32_C(-1) || options->flags != UINT32_C(0)) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, invalid_argument);
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (source->source_bytes > (uint64_t)INT64_MAX
      || options->maximum_probe_bytes < UINT64_C(32)
      || options->maximum_probe_bytes > AV1SCOPE_MAX_PROBE_BYTES_V1
      || options->maximum_sample_bytes == UINT64_C(0)
      || options->maximum_sample_bytes > AV1SCOPE_MAX_SAMPLE_BYTES_V1) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1, packet_budget_exceeded);
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if (call_cancelled(call)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }

  demux = (av1scope_demux *)calloc(1U, sizeof(*demux));
  if (demux == NULL) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, allocation_failed);
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  demux->bridge.source = *source;
  demux->bridge.maximum_read_bytes = options->maximum_probe_bytes;
  demux->maximum_sample_bytes = options->maximum_sample_bytes;
  demux->stream_index = -1;
  io_buffer = (uint8_t *)av_malloc(AV1SCOPE_IO_BUFFER_BYTES);
  if (io_buffer == NULL) {
    destroy_demux(demux);
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, allocation_failed);
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  demux->io = avio_alloc_context(
    io_buffer,
    AV1SCOPE_IO_BUFFER_BYTES,
    0,
    &demux->bridge,
    read_packet,
    NULL,
    seek_source
  );
  if (demux->io == NULL) {
    av_free(io_buffer);
    destroy_demux(demux);
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, allocation_failed);
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  demux->io->seekable = AVIO_SEEKABLE_NORMAL;
  demux->format = avformat_alloc_context();
  if (demux->format == NULL) {
    destroy_demux(demux);
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, allocation_failed);
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  demux->format->pb = demux->io;
  demux->format->flags |= AVFMT_FLAG_CUSTOM_IO;
  demux->format->interrupt_callback.callback = interrupt_callback;
  demux->format->interrupt_callback.opaque = demux;
  activate_call(demux, call);
  (void)av_dict_set_int(
    &format_options,
    "probesize",
    (int64_t)options->maximum_probe_bytes,
    0
  );
  result = avformat_open_input(&demux->format, NULL, NULL, &format_options);
  av_dict_free(&format_options);
  if (result < 0) {
    const int cancelled = interrupt_callback(demux);
    const int probe_limited = demux->bridge.read_limit_reached;
    demux->has_active_call = 0;
    destroy_demux(demux);
    if (cancelled) {
      return AV1SCOPE_STATUS_CANCELLED_V1;
    }
    if (probe_limited) {
      SET_DIAGNOSTIC(
        out_diagnostic,
        AV1SCOPE_STATUS_RESOURCE_LIMIT_V1,
        probe_budget_exceeded
      );
      return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
    }
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_MALFORMED_INPUT_V1, open_failed);
    return AV1SCOPE_STATUS_MALFORMED_INPUT_V1;
  }
  demux->format_opened = 1;
  result = avformat_find_stream_info(demux->format, NULL);
  if (result < 0) {
    const int cancelled = interrupt_callback(demux);
    const int probe_limited = demux->bridge.read_limit_reached;
    demux->has_active_call = 0;
    destroy_demux(demux);
    if (cancelled) {
      return AV1SCOPE_STATUS_CANCELLED_V1;
    }
    if (probe_limited) {
      SET_DIAGNOSTIC(
        out_diagnostic,
        AV1SCOPE_STATUS_RESOURCE_LIMIT_V1,
        probe_budget_exceeded
      );
      return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
    }
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_MALFORMED_INPUT_V1, stream_info_failed);
    return AV1SCOPE_STATUS_MALFORMED_INPUT_V1;
  }
  demux->has_active_call = 0;
  demux->bridge.maximum_read_bytes = UINT64_MAX;
  for (stream_index = 0; stream_index < demux->format->nb_streams; stream_index += 1U) {
    const AVStream *stream = demux->format->streams[stream_index];
    if (stream->codecpar->codec_id != AV_CODEC_ID_AV1) {
      continue;
    }
    if (options->requested_track_id >= 0
        && options->requested_track_id != (int32_t)stream_index) {
      continue;
    }
    demux->stream_index = (int)stream_index;
    break;
  }
  if (demux->stream_index < 0) {
    destroy_demux(demux);
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_UNSUPPORTED_V1, av1_stream_missing);
    return AV1SCOPE_STATUS_UNSUPPORTED_V1;
  }
  demux->packet = av_packet_alloc();
  if (demux->packet == NULL) {
    destroy_demux(demux);
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, allocation_failed);
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  *out_demux = demux;
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_stream_info_v1(
  av1scope_demux *demux,
  av1scope_stream_info_v1 *out_stream,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  const AVStream *stream;
  clear_diagnostic(out_diagnostic);
  if (demux == NULL || out_stream == NULL
      || !has_struct_prefix(out_stream->struct_size, sizeof(*out_stream))) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, invalid_argument);
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (out_stream->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  stream = demux->format->streams[demux->stream_index];
  if (stream->codecpar->width < 0 || stream->codecpar->height < 0) {
    return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
  }
  out_stream->track_id = demux->stream_index;
  out_stream->codec_fourcc = AV1SCOPE_AV01_FOURCC;
  out_stream->width = (uint32_t)stream->codecpar->width;
  out_stream->height = (uint32_t)stream->codecpar->height;
  out_stream->time_base_num = stream->time_base.num;
  out_stream->time_base_den = stream->time_base.den;
  out_stream->sample_count = stream->nb_frames > INT64_C(0)
    ? (uint64_t)stream->nb_frames
    : UINT64_C(0);
  return AV1SCOPE_STATUS_OK_V1;
}

av1scope_status_v1 av1scope_demux_next_sample_v1(
  av1scope_demux *demux,
  const av1scope_call_context_v1 *call,
  av1scope_sample_v1 *out_sample,
  av1scope_diagnostic_v1 *out_diagnostic
) {
  int result;
  clear_diagnostic(out_diagnostic);
  if (demux == NULL || out_sample == NULL || !validate_call(call)
      || !has_struct_prefix(out_sample->struct_size, sizeof(*out_sample))) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, invalid_argument);
    return AV1SCOPE_STATUS_INVALID_ARGUMENT_V1;
  }
  if (out_sample->abi_version != AV1SCOPE_ABI_VERSION_V1) {
    return AV1SCOPE_STATUS_ABI_MISMATCH_V1;
  }
  if (call_cancelled(call)) {
    return AV1SCOPE_STATUS_CANCELLED_V1;
  }
  activate_call(demux, call);
  for (;;) {
    av_packet_unref(demux->packet);
    result = av_read_frame(demux->format, demux->packet);
    if (result < 0) {
      const int cancelled = interrupt_callback(demux);
      demux->has_active_call = 0;
      if (cancelled) {
        return AV1SCOPE_STATUS_CANCELLED_V1;
      }
      if (result == AVERROR_EOF) {
        return AV1SCOPE_STATUS_END_V1;
      }
      SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, packet_read_failed);
      return AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
    }
    if (demux->packet->stream_index == demux->stream_index) {
      break;
    }
  }
  demux->has_active_call = 0;
  if (demux->packet->size < 0
      || (uint64_t)demux->packet->size > demux->maximum_sample_bytes) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1, packet_budget_exceeded);
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  if (demux->packet->pos < INT64_C(0)) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_UNSUPPORTED_V1, packet_position_missing);
    return AV1SCOPE_STATUS_UNSUPPORTED_V1;
  }
  if ((uint64_t)demux->packet->pos > demux->bridge.source.source_bytes
      || (uint64_t)demux->packet->size
        > demux->bridge.source.source_bytes - (uint64_t)demux->packet->pos) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_MALFORMED_INPUT_V1, packet_range_invalid);
    return AV1SCOPE_STATUS_MALFORMED_INPUT_V1;
  }
  if (demux->next_sample_id == UINT64_MAX) {
    SET_DIAGNOSTIC(out_diagnostic, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1, identifier_exhausted);
    return AV1SCOPE_STATUS_RESOURCE_LIMIT_V1;
  }
  out_sample->sample_id = demux->next_sample_id;
  out_sample->track_id = demux->stream_index;
  out_sample->flags = UINT32_C(0);
  if ((demux->packet->flags & AV_PKT_FLAG_KEY) != 0) {
    out_sample->flags |= AV1SCOPE_SAMPLE_FLAG_KEYFRAME_V1;
  }
  if ((demux->packet->flags & AV_PKT_FLAG_DISCARD) != 0) {
    out_sample->flags |= AV1SCOPE_SAMPLE_FLAG_DISCARD_V1;
  }
  if ((demux->packet->flags & AV_PKT_FLAG_CORRUPT) != 0) {
    out_sample->flags |= AV1SCOPE_SAMPLE_FLAG_CORRUPT_V1;
  }
  out_sample->dts = demux->packet->dts;
  out_sample->pts = demux->packet->pts;
  out_sample->duration = demux->packet->duration;
  out_sample->source_range.start = (uint64_t)demux->packet->pos;
  out_sample->source_range.length = (uint64_t)demux->packet->size;
  demux->next_sample_id += UINT64_C(1);
  return AV1SCOPE_STATUS_OK_V1;
}

void av1scope_demux_close_v1(av1scope_demux *demux) {
  destroy_demux(demux);
}
