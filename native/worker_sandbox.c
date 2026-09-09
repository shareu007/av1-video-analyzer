#include "av1scope_worker_sandbox.h"

#if defined(__linux__) && (defined(__x86_64__) || defined(__aarch64__))

#include <errno.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>

#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define AV1SCOPE_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AV1SCOPE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#endif

#define DENY_SYSCALL(name) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (uint32_t)__NR_##name, 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (uint32_t)EPERM)

int av1scope_worker_sandbox_is_supported(void) {
  return 1;
}

int av1scope_apply_worker_sandbox(void) {
  const pid_t parent_pid = getppid();
  static const struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AV1SCOPE_AUDIT_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, nr)),
#ifdef __NR_open
    DENY_SYSCALL(open),
#endif
#ifdef __NR_openat
    DENY_SYSCALL(openat),
#endif
#ifdef __NR_openat2
    DENY_SYSCALL(openat2),
#endif
#ifdef __NR_creat
    DENY_SYSCALL(creat),
#endif
#ifdef __NR_socket
    DENY_SYSCALL(socket),
#endif
#ifdef __NR_socketpair
    DENY_SYSCALL(socketpair),
#endif
#ifdef __NR_connect
    DENY_SYSCALL(connect),
#endif
#ifdef __NR_bind
    DENY_SYSCALL(bind),
#endif
#ifdef __NR_listen
    DENY_SYSCALL(listen),
#endif
#ifdef __NR_accept
    DENY_SYSCALL(accept),
#endif
#ifdef __NR_accept4
    DENY_SYSCALL(accept4),
#endif
#ifdef __NR_execve
    DENY_SYSCALL(execve),
#endif
#ifdef __NR_execveat
    DENY_SYSCALL(execveat),
#endif
#ifdef __NR_fork
    DENY_SYSCALL(fork),
#endif
#ifdef __NR_vfork
    DENY_SYSCALL(vfork),
#endif
#ifdef __NR_clone
    DENY_SYSCALL(clone),
#endif
#ifdef __NR_clone3
    DENY_SYSCALL(clone3),
#endif
#ifdef __NR_ptrace
    DENY_SYSCALL(ptrace),
#endif
#ifdef __NR_process_vm_readv
    DENY_SYSCALL(process_vm_readv),
#endif
#ifdef __NR_process_vm_writev
    DENY_SYSCALL(process_vm_writev),
#endif
#ifdef __NR_mount
    DENY_SYSCALL(mount),
#endif
#ifdef __NR_umount2
    DENY_SYSCALL(umount2),
#endif
#ifdef __NR_pivot_root
    DENY_SYSCALL(pivot_root),
#endif
#ifdef __NR_chroot
    DENY_SYSCALL(chroot),
#endif
#ifdef __NR_setns
    DENY_SYSCALL(setns),
#endif
#ifdef __NR_unshare
    DENY_SYSCALL(unshare),
#endif
#ifdef __NR_bpf
    DENY_SYSCALL(bpf),
#endif
#ifdef __NR_userfaultfd
    DENY_SYSCALL(userfaultfd),
#endif
#ifdef __NR_io_uring_setup
    DENY_SYSCALL(io_uring_setup),
#endif
#ifdef __NR_memfd_create
    DENY_SYSCALL(memfd_create),
#endif
#ifdef __NR_keyctl
    DENY_SYSCALL(keyctl),
#endif
#ifdef __NR_add_key
    DENY_SYSCALL(add_key),
#endif
#ifdef __NR_request_key
    DENY_SYSCALL(request_key),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
  };
  const struct sock_fprog program = {
    (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    (struct sock_filter *)filter
  };
  if (parent_pid <= (pid_t)1
      || prctl(PR_SET_PDEATHSIG, (unsigned long)SIGKILL, 0UL, 0UL, 0UL) != 0
      || getppid() != parent_pid
      || prctl(PR_SET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) != 0
      || prctl(PR_SET_NO_NEW_PRIVS, 1UL, 0UL, 0UL, 0UL) != 0) {
    return 0;
  }
  return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) == 0;
}

#else

int av1scope_worker_sandbox_is_supported(void) {
  return 0;
}

int av1scope_apply_worker_sandbox(void) {
  return 0;
}

#endif
