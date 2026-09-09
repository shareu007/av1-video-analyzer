#ifndef AV1SCOPE_ABI_H
#define AV1SCOPE_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  if defined(AV1SCOPE_ADAPTER_BUILD)
#    define AV1SCOPE_API __declspec(dllexport)
#  else
#    define AV1SCOPE_API __declspec(dllimport)
#  endif
#else
#  define AV1SCOPE_API __attribute__((visibility("default")))
#endif

#define AV1SCOPE_ABI_VERSION_V1 UINT32_C(1)
#define AV1SCOPE_MAX_DIAGNOSTIC_BYTES_V1 UINT32_C(4096)
#define AV1SCOPE_MAX_BLOCKS_PER_CHUNK_V1 UINT32_C(65536)
#define AV1SCOPE_MAX_SAMPLE_BYTES_V1 UINT64_C(1073741824)
#define AV1SCOPE_MAX_PROBE_BYTES_V1 UINT64_C(268435456)

typedef uint32_t av1scope_status_v1;

enum av1scope_status_code_v1 {
  AV1SCOPE_STATUS_OK_V1 = 0,
  AV1SCOPE_STATUS_END_V1 = 1,
  AV1SCOPE_STATUS_CANCELLED_V1 = 2,
  AV1SCOPE_STATUS_INVALID_ARGUMENT_V1 = 3,
  AV1SCOPE_STATUS_UNSUPPORTED_V1 = 4,
  AV1SCOPE_STATUS_MALFORMED_INPUT_V1 = 5,
  AV1SCOPE_STATUS_RESOURCE_LIMIT_V1 = 6,
  AV1SCOPE_STATUS_ADAPTER_ERROR_V1 = 7,
  AV1SCOPE_STATUS_ABI_MISMATCH_V1 = 8
};

typedef struct av1scope_byte_range_v1 {
  uint64_t start;
  uint64_t length;
} av1scope_byte_range_v1;

typedef struct av1scope_bytes_v1 {
  const uint8_t *data;
  uint64_t length;
} av1scope_bytes_v1;

typedef struct av1scope_diagnostic_v1 {
  uint32_t struct_size;
  uint32_t status;
  const uint8_t *message_utf8;
  uint32_t message_bytes;
  uint32_t reserved;
} av1scope_diagnostic_v1;

/* message_utf8 is borrowed and remains valid only until the next call on the
 * same adapter object. It is never NUL-terminated by contract. */

typedef uint32_t (*av1scope_cancelled_fn_v1)(void *user_data);

typedef struct av1scope_call_context_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t deadline_unix_ms;
  av1scope_cancelled_fn_v1 cancelled;
  void *user_data;
} av1scope_call_context_v1;

typedef struct av1scope_adapter_info_v1 {
  uint32_t struct_size;
  uint32_t abi_version;
  const uint8_t *name_utf8;
  uint32_t name_bytes;
  uint32_t reserved_0;
  const uint8_t *build_utf8;
  uint32_t build_bytes;
  uint32_t feature_flags;
} av1scope_adapter_info_v1;

/* Adapter info strings are borrowed, immutable process-lifetime bytes. */

#ifdef __cplusplus
}
#endif

#endif
