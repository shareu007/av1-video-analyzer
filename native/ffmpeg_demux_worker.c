#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavformat/version.h>

#include "av1scope_demux.h"
#include "av1scope_worker_limits.h"
#include "av1scope_worker_sandbox.h"

#define REQUEST_BYTES 56U
#define RESPONSE_HEADER_BYTES 16U
#define RESPONSE_RECORD_BYTES 72U
#define MAX_WORKER_INPUT_BYTES (UINT64_C(64) * UINT64_C(1024) * UINT64_C(1024))
#define MAX_WORKER_RECORDS UINT64_C(250000)

enum response_kind {
  RESPONSE_STREAM = 1,
  RESPONSE_SAMPLE = 2,
  RESPONSE_END = 3,
  RESPONSE_ERROR = 4
};

typedef struct memory_source {
  uint8_t *bytes;
  uint64_t length;
} memory_source;

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
    'A', '1', 'D', 'M', 'O', '0', '1', 0,
    0, 0, 0, 0, 0, 0, 0, 0
  };
  write_u32_le(bytes + 8U, AV1SCOPE_ABI_VERSION_V1);
  write_u32_le(bytes + 12U, RESPONSE_RECORD_BYTES);
  return fwrite(bytes, 1U, sizeof(bytes), stdout) == sizeof(bytes);
}

static int write_record(
  uint32_t kind,
  av1scope_status_v1 status,
  const uint64_t values[8]
) {
  uint8_t bytes[RESPONSE_RECORD_BYTES] = {0};
  unsigned int index;
  write_u32_le(bytes, kind);
  write_u32_le(bytes + 4U, status);
  if (values != NULL) {
    for (index = 0; index < 8U; index += 1U) {
      write_u64_le(bytes + 8U + index * 8U, values[index]);
    }
  }
  return fwrite(bytes, 1U, sizeof(bytes), stdout) == sizeof(bytes);
}

static int64_t memory_read_at(
  void *user_data,
  uint64_t offset,
  uint8_t *destination,
  uint64_t capacity
) {
  memory_source *source = (memory_source *)user_data;
  uint64_t available;
  uint64_t count;
  if (source == NULL || destination == NULL || offset > source->length) {
    return INT64_C(-1);
  }
  available = source->length - offset;
  count = capacity < available ? capacity : available;
  if (count > (uint64_t)SIZE_MAX || count > (uint64_t)INT64_MAX) {
    return INT64_C(-1);
  }
  if (count != UINT64_C(0)) {
    memcpy(destination, source->bytes + (size_t)offset, (size_t)count);
  }
  return (int64_t)count;
}

static av1scope_diagnostic_v1 diagnostic(void) {
  av1scope_diagnostic_v1 value = {
    (uint32_t)sizeof(value), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  return value;
}

int main(void) {
  uint8_t request[REQUEST_BYTES];
  memory_source memory = {NULL, UINT64_C(0)};
  av1scope_demux_source_v1 source;
  av1scope_demux_options_v1 options;
  av1scope_call_context_v1 call = {
    (uint32_t)sizeof(call), AV1SCOPE_ABI_VERSION_V1,
    UINT64_C(0), NULL, NULL
  };
  av1scope_diagnostic_v1 output_diagnostic = diagnostic();
  av1scope_demux *demux = NULL;
  av1scope_stream_info_v1 stream = {
    (uint32_t)sizeof(stream), AV1SCOPE_ABI_VERSION_V1,
    INT32_C(0), UINT32_C(0), UINT32_C(0), UINT32_C(0),
    INT32_C(0), INT32_C(0), UINT64_C(0)
  };
  av1scope_adapter_info_v1 adapter_info = {
    (uint32_t)sizeof(adapter_info), AV1SCOPE_ABI_VERSION_V1,
    NULL, UINT32_C(0), UINT32_C(0), NULL, UINT32_C(0), UINT32_C(0)
  };
  av1scope_status_v1 status;
  uint64_t maximum_records;
  uint64_t record_count = UINT64_C(0);
  uint32_t worker_sandbox_flags = UINT32_C(0);
  int32_t requested_track;

  if (!write_response_header()) {
    return 3;
  }
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
      || memcmp(request, "A1DMX01", 7U) != 0
      || request[7] != 0
      || read_u32_le(request + 8U) != AV1SCOPE_ABI_VERSION_V1
      || read_u32_le(request + 12U) != REQUEST_BYTES
      || read_u32_le(request + 52U) != UINT32_C(0)) {
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, NULL);
    return 0;
  }
  memory.length = read_u64_le(request + 16U);
  maximum_records = read_u64_le(request + 40U);
  requested_track = (int32_t)read_u32_le(request + 48U);
  if (memory.length > MAX_WORKER_INPUT_BYTES
      || maximum_records == UINT64_C(0)
      || maximum_records > MAX_WORKER_RECORDS) {
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1, NULL);
    return 0;
  }
  memory.bytes = (uint8_t *)malloc((size_t)(memory.length == 0 ? 1 : memory.length));
  if (memory.bytes == NULL) {
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_ADAPTER_ERROR_V1, NULL);
    return 0;
  }
  if (!read_exact(memory.bytes, (size_t)memory.length)) {
    free(memory.bytes);
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_MALFORMED_INPUT_V1, NULL);
    return 0;
  }
  if (fgetc(stdin) != EOF) {
    free(memory.bytes);
    (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_INVALID_ARGUMENT_V1, NULL);
    return 0;
  }

  source.struct_size = (uint32_t)sizeof(source);
  source.abi_version = AV1SCOPE_ABI_VERSION_V1;
  source.source_bytes = memory.length;
  source.read_at = memory_read_at;
  source.user_data = &memory;
  options.struct_size = (uint32_t)sizeof(options);
  options.abi_version = AV1SCOPE_ABI_VERSION_V1;
  options.requested_track_id = requested_track;
  options.flags = UINT32_C(0);
  options.maximum_probe_bytes = read_u64_le(request + 24U);
  options.maximum_sample_bytes = read_u64_le(request + 32U);

  status = av1scope_demux_open_v1(
    &source, &options, &call, &demux, &output_diagnostic
  );
  if (status != AV1SCOPE_STATUS_OK_V1) {
    free(memory.bytes);
    (void)write_record(RESPONSE_ERROR, status, NULL);
    return 0;
  }
  status = av1scope_demux_stream_info_v1(demux, &stream, &output_diagnostic);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    av1scope_demux_close_v1(demux);
    free(memory.bytes);
    (void)write_record(RESPONSE_ERROR, status, NULL);
    return 0;
  }
  status = av1scope_demux_adapter_info_v1(&adapter_info);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    av1scope_demux_close_v1(demux);
    free(memory.bytes);
    (void)write_record(RESPONSE_ERROR, status, NULL);
    return 0;
  }
  {
    const uint64_t values[8] = {
      (uint64_t)(int64_t)stream.track_id,
      stream.width,
      stream.height,
      (uint64_t)(int64_t)stream.time_base_num,
      (uint64_t)(int64_t)stream.time_base_den,
      stream.sample_count,
      LIBAVFORMAT_VERSION_INT,
      (uint64_t)adapter_info.feature_flags | ((uint64_t)worker_sandbox_flags << 32U)
    };
    if (!write_record(RESPONSE_STREAM, AV1SCOPE_STATUS_OK_V1, values)) {
      av1scope_demux_close_v1(demux);
      free(memory.bytes);
      return 3;
    }
  }

  for (;;) {
    av1scope_sample_v1 sample = {
      (uint32_t)sizeof(sample), AV1SCOPE_ABI_VERSION_V1,
      UINT64_C(0), INT32_C(0), UINT32_C(0),
      INT64_C(0), INT64_C(0), INT64_C(0),
      {UINT64_C(0), UINT64_C(0)}
    };
    status = av1scope_demux_next_sample_v1(
      demux, &call, &sample, &output_diagnostic
    );
    if (status == AV1SCOPE_STATUS_END_V1) {
      const uint64_t values[8] = {
        record_count, UINT64_C(0), UINT64_C(0), UINT64_C(0),
        UINT64_C(0), UINT64_C(0), UINT64_C(0), UINT64_C(0)
      };
      av1scope_demux_close_v1(demux);
      free(memory.bytes);
      return write_record(RESPONSE_END, status, values) ? 0 : 3;
    }
    if (status != AV1SCOPE_STATUS_OK_V1) {
      av1scope_demux_close_v1(demux);
      free(memory.bytes);
      (void)write_record(RESPONSE_ERROR, status, NULL);
      return 0;
    }
    if (record_count >= maximum_records) {
      av1scope_demux_close_v1(demux);
      free(memory.bytes);
      (void)write_record(RESPONSE_ERROR, AV1SCOPE_STATUS_RESOURCE_LIMIT_V1, NULL);
      return 0;
    }
    {
      const uint64_t values[8] = {
        sample.sample_id,
        (uint64_t)(int64_t)sample.track_id,
        sample.flags,
        (uint64_t)sample.dts,
        (uint64_t)sample.pts,
        (uint64_t)sample.duration,
        sample.source_range.start,
        sample.source_range.length
      };
      if (!write_record(RESPONSE_SAMPLE, status, values)) {
        av1scope_demux_close_v1(demux);
        free(memory.bytes);
        return 3;
      }
    }
    record_count += UINT64_C(1);
  }
}
