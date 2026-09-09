#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "av1scope_demux.h"

typedef struct memory_source {
  uint8_t *bytes;
  uint64_t length;
} memory_source;

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
    size_t index;
    for (index = 0; index < (size_t)count; index += 1U) {
      destination[index] = source->bytes[(size_t)offset + index];
    }
  }
  return (int64_t)count;
}

static uint32_t cancellation(void *user_data) {
  return user_data == NULL ? UINT32_C(0) : *(const uint32_t *)user_data;
}

static int load_file(const char *path, memory_source *source) {
  FILE *file;
  long size;
  if (path == NULL || source == NULL) {
    return 0;
  }
  file = fopen(path, "rb");
  if (file == NULL) {
    return 0;
  }
  if (fseek(file, 0L, SEEK_END) != 0) {
    (void)fclose(file);
    return 0;
  }
  size = ftell(file);
  if (size < 0 || fseek(file, 0L, SEEK_SET) != 0) {
    (void)fclose(file);
    return 0;
  }
  source->length = (uint64_t)size;
  source->bytes = (uint8_t *)malloc((size_t)(source->length == 0 ? 1 : source->length));
  if (source->bytes == NULL) {
    (void)fclose(file);
    return 0;
  }
  if (source->length != 0
      && fread(source->bytes, 1U, (size_t)source->length, file) != source->length) {
    free(source->bytes);
    source->bytes = NULL;
    (void)fclose(file);
    return 0;
  }
  return fclose(file) == 0;
}

static av1scope_call_context_v1 make_call(uint32_t *cancelled) {
  av1scope_call_context_v1 call = {
    (uint32_t)sizeof(call),
    AV1SCOPE_ABI_VERSION_V1,
    UINT64_C(0),
    cancellation,
    cancelled
  };
  return call;
}

static av1scope_demux_source_v1 make_source(memory_source *memory) {
  av1scope_demux_source_v1 source = {
    (uint32_t)sizeof(source),
    AV1SCOPE_ABI_VERSION_V1,
    memory->length,
    memory_read_at,
    memory
  };
  return source;
}

static av1scope_demux_options_v1 make_options(uint64_t maximum_sample_bytes) {
  av1scope_demux_options_v1 options = {
    (uint32_t)sizeof(options),
    AV1SCOPE_ABI_VERSION_V1,
    INT32_C(-1),
    UINT32_C(0),
    UINT64_C(16) * UINT64_C(1024) * UINT64_C(1024),
    maximum_sample_bytes
  };
  return options;
}

static av1scope_diagnostic_v1 make_diagnostic(void) {
  av1scope_diagnostic_v1 diagnostic = {
    (uint32_t)sizeof(diagnostic),
    UINT32_C(0),
    NULL,
    UINT32_C(0),
    UINT32_C(0)
  };
  return diagnostic;
}

static int fail_status(
  const char *operation,
  av1scope_status_v1 status,
  const av1scope_diagnostic_v1 *diagnostic
) {
  (void)fprintf(
    stderr,
    "%s failed with status %" PRIu32 ": %.*s\n",
    operation,
    status,
    diagnostic == NULL ? 0 : (int)diagnostic->message_bytes,
    diagnostic == NULL || diagnostic->message_utf8 == NULL
      ? ""
      : (const char *)diagnostic->message_utf8
  );
  return 1;
}

static int fuzz_failure_status(av1scope_status_v1 status) {
  return status == AV1SCOPE_STATUS_UNSUPPORTED_V1
    || status == AV1SCOPE_STATUS_MALFORMED_INPUT_V1
    || status == AV1SCOPE_STATUS_RESOURCE_LIMIT_V1
    || status == AV1SCOPE_STATUS_ADAPTER_ERROR_V1;
}

static int fuzz_smoke(
  av1scope_status_v1 open_status,
  av1scope_demux *demux,
  uint64_t source_bytes,
  av1scope_call_context_v1 *call,
  av1scope_diagnostic_v1 *diagnostic
) {
  av1scope_stream_info_v1 stream = {
    (uint32_t)sizeof(stream),
    AV1SCOPE_ABI_VERSION_V1,
    INT32_C(0), UINT32_C(0), UINT32_C(0), UINT32_C(0),
    INT32_C(0), INT32_C(0), UINT64_C(0)
  };
  uint64_t expected_sample_id = UINT64_C(0);
  av1scope_status_v1 status;
  if (open_status != AV1SCOPE_STATUS_OK_V1) {
    av1scope_demux_close_v1(demux);
    return demux == NULL && fuzz_failure_status(open_status)
      ? 0
      : fail_status("fuzz_open", open_status, diagnostic);
  }
  if (demux == NULL) {
    return fail_status("fuzz_open_handle", open_status, diagnostic);
  }
  status = av1scope_demux_stream_info_v1(demux, &stream, diagnostic);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    av1scope_demux_close_v1(demux);
    return fail_status("fuzz_stream_info", status, diagnostic);
  }
  while (expected_sample_id < UINT64_C(4096)) {
    av1scope_sample_v1 sample = {
      (uint32_t)sizeof(sample),
      AV1SCOPE_ABI_VERSION_V1,
      UINT64_C(0), INT32_C(0), UINT32_C(0),
      INT64_C(0), INT64_C(0), INT64_C(0),
      {UINT64_C(0), UINT64_C(0)}
    };
    status = av1scope_demux_next_sample_v1(demux, call, &sample, diagnostic);
    if (status == AV1SCOPE_STATUS_END_V1 || fuzz_failure_status(status)) {
      av1scope_demux_close_v1(demux);
      return 0;
    }
    if (status != AV1SCOPE_STATUS_OK_V1
        || sample.sample_id != expected_sample_id
        || sample.track_id != stream.track_id
        || (sample.flags & ~UINT32_C(7)) != UINT32_C(0)
        || sample.source_range.start > source_bytes
        || sample.source_range.length > source_bytes - sample.source_range.start) {
      av1scope_demux_close_v1(demux);
      return fail_status("fuzz_sample", status, diagnostic);
    }
    expected_sample_id += UINT64_C(1);
  }
  av1scope_demux_close_v1(demux);
  return 0;
}

int main(int argument_count, char **arguments) {
  memory_source memory = {NULL, UINT64_C(0)};
  uint32_t cancelled = UINT32_C(0);
  av1scope_call_context_v1 call = make_call(&cancelled);
  av1scope_demux_source_v1 source;
  av1scope_demux_options_v1 options;
  av1scope_diagnostic_v1 diagnostic = make_diagnostic();
  av1scope_adapter_info_v1 adapter_info = {
    (uint32_t)sizeof(adapter_info),
    AV1SCOPE_ABI_VERSION_V1,
    NULL,
    UINT32_C(0),
    UINT32_C(0),
    NULL,
    UINT32_C(0),
    UINT32_C(0)
  };
  av1scope_demux *demux = NULL;
  av1scope_stream_info_v1 stream = {
    (uint32_t)sizeof(stream),
    AV1SCOPE_ABI_VERSION_V1,
    INT32_C(0),
    UINT32_C(0),
    UINT32_C(0),
    UINT32_C(0),
    INT32_C(0),
    INT32_C(0),
    UINT64_C(0)
  };
  av1scope_status_v1 status;
  const char *input_path;
  int expected_open_status = -1;
  int fuzz_mode = 0;
  uint64_t expected_probe_budget = UINT64_C(0);
  if (argument_count == 2) {
    input_path = arguments[1];
  } else if (argument_count == 3 && strcmp(arguments[1], "--fuzz-smoke") == 0) {
    fuzz_mode = 1;
    input_path = arguments[2];
  } else if (argument_count == 4
      && strcmp(arguments[1], "--expect-open-status") == 0) {
    char *end = NULL;
    long value = strtol(arguments[2], &end, 10);
    if (end == arguments[2] || *end != '\0' || value < 0 || value > 8) {
      (void)fprintf(stderr, "invalid expected status\n");
      return 2;
    }
    expected_open_status = (int)value;
    input_path = arguments[3];
  } else if (argument_count == 4
      && strcmp(arguments[1], "--expect-probe-budget") == 0) {
    char *end = NULL;
    unsigned long long value;
    errno = 0;
    value = strtoull(arguments[2], &end, 10);
    if (errno != 0 || end == arguments[2] || *end != '\0'
        || value < UINT64_C(32) || value > AV1SCOPE_MAX_PROBE_BYTES_V1) {
      (void)fprintf(stderr, "invalid probe budget\n");
      return 2;
    }
    expected_probe_budget = (uint64_t)value;
    input_path = arguments[3];
  } else {
    (void)fprintf(
      stderr,
      "usage: ffmpeg-demux-smoke [--fuzz-smoke | --expect-open-status STATUS"
      " | --expect-probe-budget BYTES] INPUT\n"
    );
    return 2;
  }
  if (!load_file(input_path, &memory)) {
    (void)fprintf(stderr, "could not read input\n");
    return 2;
  }
  source = make_source(&memory);
  options = make_options(AV1SCOPE_MAX_SAMPLE_BYTES_V1);
  if (expected_probe_budget != UINT64_C(0)) {
    options.maximum_probe_bytes = expected_probe_budget;
  }

  status = av1scope_demux_adapter_info_v1(&adapter_info);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    free(memory.bytes);
    return fail_status("adapter_info", status, &diagnostic);
  }
  (void)printf(
    "ADAPTER\t%.*s\t%.*s\n",
    (int)adapter_info.name_bytes,
    (const char *)adapter_info.name_utf8,
    (int)adapter_info.build_bytes,
    (const char *)adapter_info.build_utf8
  );

  cancelled = UINT32_C(1);
  status = av1scope_demux_open_v1(&source, &options, &call, &demux, &diagnostic);
  if (status != AV1SCOPE_STATUS_CANCELLED_V1 || demux != NULL) {
    free(memory.bytes);
    return fail_status("cancelled_open", status, &diagnostic);
  }
  cancelled = UINT32_C(0);
  call.deadline_unix_ms = UINT64_C(1);
  status = av1scope_demux_open_v1(&source, &options, &call, &demux, &diagnostic);
  if (status != AV1SCOPE_STATUS_CANCELLED_V1 || demux != NULL) {
    free(memory.bytes);
    return fail_status("expired_open", status, &diagnostic);
  }
  call.deadline_unix_ms = UINT64_C(0);
  status = av1scope_demux_open_v1(&source, &options, &call, &demux, &diagnostic);
  if (expected_open_status >= 0) {
    av1scope_demux_close_v1(demux);
    free(memory.bytes);
    return status == (av1scope_status_v1)expected_open_status
      ? 0
      : fail_status("expected_open_status", status, &diagnostic);
  }
  if (expected_probe_budget != UINT64_C(0)) {
    av1scope_demux_close_v1(demux);
    free(memory.bytes);
    return status == AV1SCOPE_STATUS_RESOURCE_LIMIT_V1 && demux == NULL
      ? 0
      : fail_status("expected_probe_budget", status, &diagnostic);
  }
  if (fuzz_mode) {
    const int fuzz_result = fuzz_smoke(
      status,
      demux,
      memory.length,
      &call,
      &diagnostic
    );
    free(memory.bytes);
    return fuzz_result;
  }
  if (status != AV1SCOPE_STATUS_OK_V1 || demux == NULL) {
    free(memory.bytes);
    return fail_status("open", status, &diagnostic);
  }
  status = av1scope_demux_stream_info_v1(demux, &stream, &diagnostic);
  if (status != AV1SCOPE_STATUS_OK_V1) {
    av1scope_demux_close_v1(demux);
    free(memory.bytes);
    return fail_status("stream_info", status, &diagnostic);
  }
  (void)printf(
    "STREAM\t%" PRId32 "\t%" PRIu32 "\t%" PRIu32 "\t%" PRId32
    "\t%" PRId32 "\t%" PRIu64 "\n",
    stream.track_id,
    stream.width,
    stream.height,
    stream.time_base_num,
    stream.time_base_den,
    stream.sample_count
  );
  cancelled = UINT32_C(1);
  {
    av1scope_sample_v1 cancelled_sample = {
      (uint32_t)sizeof(cancelled_sample),
      AV1SCOPE_ABI_VERSION_V1,
      UINT64_C(0), INT32_C(0), UINT32_C(0),
      INT64_C(0), INT64_C(0), INT64_C(0),
      {UINT64_C(0), UINT64_C(0)}
    };
    status = av1scope_demux_next_sample_v1(
      demux,
      &call,
      &cancelled_sample,
      &diagnostic
    );
  }
  if (status != AV1SCOPE_STATUS_CANCELLED_V1) {
    av1scope_demux_close_v1(demux);
    free(memory.bytes);
    return fail_status("cancelled_next", status, &diagnostic);
  }
  cancelled = UINT32_C(0);
  for (;;) {
    av1scope_sample_v1 sample = {
      (uint32_t)sizeof(sample),
      AV1SCOPE_ABI_VERSION_V1,
      UINT64_C(0),
      INT32_C(0),
      UINT32_C(0),
      INT64_C(0),
      INT64_C(0),
      INT64_C(0),
      {UINT64_C(0), UINT64_C(0)}
    };
    status = av1scope_demux_next_sample_v1(demux, &call, &sample, &diagnostic);
    if (status == AV1SCOPE_STATUS_END_V1) {
      break;
    }
    if (status != AV1SCOPE_STATUS_OK_V1) {
      av1scope_demux_close_v1(demux);
      free(memory.bytes);
      return fail_status("next_sample", status, &diagnostic);
    }
    (void)printf(
      "SAMPLE\t%" PRIu64 "\t%" PRId32 "\t%" PRIu32 "\t%" PRId64
      "\t%" PRId64 "\t%" PRId64 "\t%" PRIu64 "\t%" PRIu64 "\n",
      sample.sample_id,
      sample.track_id,
      sample.flags,
      sample.dts,
      sample.pts,
      sample.duration,
      sample.source_range.start,
      sample.source_range.length
    );
  }
  av1scope_demux_close_v1(demux);

  options = make_options(AV1SCOPE_MAX_SAMPLE_BYTES_V1);
  options.requested_track_id = INT32_C(999);
  demux = NULL;
  status = av1scope_demux_open_v1(&source, &options, &call, &demux, &diagnostic);
  if (status != AV1SCOPE_STATUS_UNSUPPORTED_V1 || demux != NULL) {
    free(memory.bytes);
    return fail_status("missing_track", status, &diagnostic);
  }

  options = make_options(AV1SCOPE_MAX_SAMPLE_BYTES_V1);
  options.maximum_probe_bytes = UINT64_C(31);
  demux = NULL;
  status = av1scope_demux_open_v1(&source, &options, &call, &demux, &diagnostic);
  if (status != AV1SCOPE_STATUS_RESOURCE_LIMIT_V1 || demux != NULL) {
    free(memory.bytes);
    return fail_status("probe_budget", status, &diagnostic);
  }

  options = make_options(UINT64_C(1));
  demux = NULL;
  status = av1scope_demux_open_v1(&source, &options, &call, &demux, &diagnostic);
  if (status != AV1SCOPE_STATUS_OK_V1 || demux == NULL) {
    free(memory.bytes);
    return fail_status("budget_open", status, &diagnostic);
  }
  {
    av1scope_sample_v1 sample = {
      (uint32_t)sizeof(sample),
      AV1SCOPE_ABI_VERSION_V1,
      UINT64_C(0), INT32_C(0), UINT32_C(0),
      INT64_C(0), INT64_C(0), INT64_C(0),
      {UINT64_C(0), UINT64_C(0)}
    };
    status = av1scope_demux_next_sample_v1(demux, &call, &sample, &diagnostic);
  }
  av1scope_demux_close_v1(demux);
  free(memory.bytes);
  if (status != AV1SCOPE_STATUS_RESOURCE_LIMIT_V1) {
    return fail_status("sample_budget", status, &diagnostic);
  }
  return 0;
}
