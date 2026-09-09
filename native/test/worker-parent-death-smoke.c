#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#if defined(__linux__) && (defined(__x86_64__) || defined(__aarch64__))
#include <sys/types.h>
#include <unistd.h>
#endif

#include "av1scope_worker_sandbox.h"

int main(void) {
#if defined(__linux__) && (defined(__x86_64__) || defined(__aarch64__))
  int ready[2];
  pid_t child;
  uint8_t marker = 0U;
  if (pipe(ready) != 0) {
    return 2;
  }
  child = fork();
  if (child < (pid_t)0) {
    return 3;
  }
  if (child == (pid_t)0) {
    (void)close(ready[0]);
    if (!av1scope_apply_worker_sandbox()) {
      _exit(4);
    }
    marker = 1U;
    if (write(ready[1], &marker, sizeof(marker)) != (ssize_t)sizeof(marker)) {
      _exit(5);
    }
    (void)close(ready[1]);
    for (;;) {
      pause();
    }
  }
  (void)close(ready[1]);
  if (read(ready[0], &marker, sizeof(marker)) != (ssize_t)sizeof(marker) || marker != 1U) {
    return 6;
  }
  (void)close(ready[0]);
  printf("%ld\n", (long)child);
  return fflush(stdout) == 0 ? 0 : 7;
#else
  puts("unsupported");
  return 0;
#endif
}
