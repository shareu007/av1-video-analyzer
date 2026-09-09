#ifndef AV1SCOPE_WORKER_SANDBOX_H
#define AV1SCOPE_WORKER_SANDBOX_H

#ifdef __cplusplus
extern "C" {
#endif

#define AV1SCOPE_WORKER_SANDBOX_NO_NEW_PRIVS_V1 1U
#define AV1SCOPE_WORKER_SANDBOX_SECCOMP_V1 2U
#define AV1SCOPE_WORKER_SANDBOX_DENYLIST_V1 4U
#define AV1SCOPE_WORKER_SANDBOX_PARENT_DEATH_V1 8U
#define AV1SCOPE_WORKER_SANDBOX_NON_DUMPABLE_V1 16U
#define AV1SCOPE_WORKER_SANDBOX_LINUX_V1 \
  (AV1SCOPE_WORKER_SANDBOX_NO_NEW_PRIVS_V1 \
    | AV1SCOPE_WORKER_SANDBOX_SECCOMP_V1 \
    | AV1SCOPE_WORKER_SANDBOX_DENYLIST_V1 \
    | AV1SCOPE_WORKER_SANDBOX_PARENT_DEATH_V1 \
    | AV1SCOPE_WORKER_SANDBOX_NON_DUMPABLE_V1)

/* Returns 1 when the platform has the v1 sandbox implementation. */
int av1scope_worker_sandbox_is_supported(void);

/* Returns 1 after installing the sandbox, or 0 on failure/unsupported. */
int av1scope_apply_worker_sandbox(void);

#ifdef __cplusplus
}
#endif

#endif
