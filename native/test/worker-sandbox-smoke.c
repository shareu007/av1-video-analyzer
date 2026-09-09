#include <errno.h>
#include <fcntl.h>
#include <stdio.h>

#if defined(__linux__)
#include <signal.h>
#include <sys/socket.h>
#include <sys/prctl.h>
#include <unistd.h>
#endif

#include "av1scope_worker_sandbox.h"

int main(void) {
  if (!av1scope_worker_sandbox_is_supported()) {
    puts("sandbox unsupported");
    return 0;
  }
  if (!av1scope_apply_worker_sandbox()) {
    return 2;
  }
#if defined(__linux__)
  {
    int parent_death_signal = 0;
    if (prctl(PR_GET_PDEATHSIG, &parent_death_signal) != 0
        || parent_death_signal != SIGKILL
        || prctl(PR_GET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) != 0) {
      return 3;
    }
  }
  errno = 0;
  if (open("/dev/null", O_RDONLY) != -1 || errno != EPERM) {
    return 4;
  }
  errno = 0;
  if (socket(AF_INET, SOCK_STREAM, 0) != -1 || errno != EPERM) {
    return 5;
  }
#endif
  puts("sandbox blocked path and network syscalls");
  return fflush(stdout) == 0 ? 0 : 6;
}
