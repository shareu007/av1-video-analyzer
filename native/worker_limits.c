#include <stdint.h>

#if defined(__unix__) || defined(__APPLE__)
#include <sys/resource.h>
#endif

#include "av1scope_worker_limits.h"

#define MAX_WORKER_ADDRESS_SPACE (UINT64_C(768) * UINT64_C(1024) * UINT64_C(1024))
#define MAX_WORKER_FILE_DESCRIPTORS 16U

#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define AV1SCOPE_ADDRESS_SANITIZER 1
#endif
#endif
#if defined(__SANITIZE_ADDRESS__)
#define AV1SCOPE_ADDRESS_SANITIZER 1
#endif

int av1scope_apply_worker_limits(void) {
#if defined(__unix__) || defined(__APPLE__)
  struct rlimit limit;
#if !defined(AV1SCOPE_ADDRESS_SANITIZER)
  limit.rlim_cur = (rlim_t)MAX_WORKER_ADDRESS_SPACE;
  limit.rlim_max = (rlim_t)MAX_WORKER_ADDRESS_SPACE;
  if (setrlimit(RLIMIT_AS, &limit) != 0) {
    return 0;
  }
#endif
  limit.rlim_cur = (rlim_t)30;
  limit.rlim_max = (rlim_t)30;
  if (setrlimit(RLIMIT_CPU, &limit) != 0) {
    return 0;
  }
  limit.rlim_cur = (rlim_t)0;
  limit.rlim_max = (rlim_t)0;
  if (setrlimit(RLIMIT_CORE, &limit) != 0) {
    return 0;
  }
#if defined(RLIMIT_NOFILE)
  limit.rlim_cur = (rlim_t)MAX_WORKER_FILE_DESCRIPTORS;
  limit.rlim_max = (rlim_t)MAX_WORKER_FILE_DESCRIPTORS;
  if (setrlimit(RLIMIT_NOFILE, &limit) != 0) {
    return 0;
  }
#endif
#endif
  return 1;
}
