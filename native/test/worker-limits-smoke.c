#include <stdint.h>
#include <stdio.h>

#if defined(__unix__) || defined(__APPLE__)
#include <sys/resource.h>
#endif

#include "av1scope_worker_limits.h"

int main(void) {
  if (!av1scope_apply_worker_limits()) {
    return 2;
  }
#if defined(__unix__) || defined(__APPLE__)
  {
    struct rlimit limit;
    if (getrlimit(RLIMIT_CPU, &limit) != 0
        || limit.rlim_cur != (rlim_t)30 || limit.rlim_max != (rlim_t)30) {
      return 3;
    }
    if (getrlimit(RLIMIT_CORE, &limit) != 0
        || limit.rlim_cur != (rlim_t)0 || limit.rlim_max != (rlim_t)0) {
      return 4;
    }
#if defined(RLIMIT_NOFILE)
    if (getrlimit(RLIMIT_NOFILE, &limit) != 0
        || limit.rlim_cur != (rlim_t)16 || limit.rlim_max != (rlim_t)16) {
      return 5;
    }
#endif
  }
#endif
  puts("worker resource limits verified");
  return 0;
}
