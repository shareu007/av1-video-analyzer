# Native Inspection Worker v1

> 已由 [Native Inspection Worker v2](./NATIVE_INSPECTION_WORKER_V2.md) 取代；本文只保留旧 framing 记录。

`av1scope.native-inspection-worker.v1` 把 instrumented decoder 隔离在一次性进程中，并在同一个 decoder session 内按 decode order 处理整组 frame sample，保留 AV1 reference/CDF 状态。

## Request

- 56-byte little-endian header：magic `A1INX01\0`、ABI、input bytes、frame count、总 BlockRecord 上限、chunk 上限、feature flags、单帧字节上限；
- 每帧 24-byte descriptor：`frame_id/start/length`；
- 原始输入 bytes。descriptor 必须是从 0 开始的连续 frame ID，range 必须落在输入内。

## Response

- 16-byte header：magic `A1INO01\0`、ABI、96-byte record size；
- adapter info；
- 逐 BlockRecord；
- 每帧 end；
- session end 或稳定 status error。

Worker 逐字段编码 88-byte BlockRecord，不复制 C struct padding；父侧增量解码，不累积原始 stdout。双方验证顺序、ABI、flags、enum、MV、frame/block ID、保留位和总预算。父侧随后用实际报告尺寸执行 `validateBlockOverlayDocument()`，越界几何不能进入 GUI。

## Trust boundary

- 最大输入 64 MiB、250,000 frames、1,000,000 blocks、单 chunk 65,536 blocks；
- deadline/cancel 由父侧终止一次性进程；崩溃最多干净重试一次；
- executable 分析前后计算 SHA-256，运行中替换会拒绝结果；
- Linux 使用与 demux Worker 相同的资源上限、parent-death 和 syscall sandbox；
- adapter name/build 是结果 provenance，必须来自固定构建。

GUI 使用 `--native-inspection-worker PATH` 显式启用。未配置时保留外部 Block Overlay 导入，不推导或伪造块数据。当前仓库的 mock worker 仅用于 ABI/IPC 测试。
