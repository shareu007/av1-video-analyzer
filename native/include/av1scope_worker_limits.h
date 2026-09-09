#ifndef AV1SCOPE_WORKER_LIMITS_H
#define AV1SCOPE_WORKER_LIMITS_H

#ifdef __cplusplus
extern "C" {
#endif

/* Installs the v1 address-space, CPU, core-dump and file-descriptor limits. */
int av1scope_apply_worker_limits(void);

#ifdef __cplusplus
}
#endif

#endif
