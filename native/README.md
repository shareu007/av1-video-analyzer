# AV1Scope native adapter ABI v1

该目录冻结 Rust core 与版本敏感 C/C++ 库之间的窄 C11 接缝，包含真实 libavformat demux adapter，以及可承载有状态解码会话的 inspection Worker。固定 libaom v3.12.1 producer 已实现完整 feature 127，并通过真实 AV1 Block Golden。

## 文件

- `include/av1scope_abi.h`：共同状态、范围、取消/deadline 与 adapter provenance；
- `include/av1scope_demux.h`：只读 `read_at` 输入、stream info、逐 sample source range；
- `include/av1scope_inspection.h`：固定布局 BlockRecord 与有界 chunk callback；
- `include/av1scope_libaom_patch.h` + `libaom_inspection_adapter.c`：固定 instrumented fork 的逐块私有事件接缝，以及公共 ABI 的校验/chunk/backpressure/provenance bridge；
- `libaom_builtin_inspection_patch.c`：消费 `AV1_SET_INSPECTION_CALLBACK`/`insp_mi_data`，处理 temporal-unit 子帧游标，并输出 partition 与真实 luma non-zero coefficient count；
- `inspection_worker.c`：一次进程处理完整帧序列、校验 chunk/BlockRecord 并输出有界 little-endian IPC；
- `abi-smoke.c`：C11 类型、callback 和关键 size/offset 编译断言；
- `ffmpeg_demux_adapter.c`：真实 custom-AVIO libavformat producer；不接收路径，不暴露第三方对象；
- `ffmpeg_demux_worker.c`：版本化固定记录 IPC 的专用进程；不接收路径，限制输入/记录/address-space/CPU/core dump；
- `worker_sandbox.c` / `include/av1scope_worker_sandbox.h`：Linux x86_64/aarch64 的 `no_new_privs` + seccomp 高风险 syscall denylist；禁用路径打开、网络、进程创建/执行、跨进程内存、mount/namespace、BPF/keyring/io_uring 等入口；
- `worker_limits.c` / `include/av1scope_worker_limits.h`：Worker 共享的 address-space/CPU/core/file-descriptor rlimit 实现；
- `CMakeLists.txt`：生成隐藏符号的 shared adapter library 与运行时 harness；
- `test/ffmpeg-demux-smoke.c`：真实 adapter 的 sample、取消、deadline、track、预算、malformed 和有界 fuzz-drain 验收；
- `test/mock_adapters.c`、`test/libaom-patch-stub.c` 与 smoke：仅用于测试的 ABI/bridge 闭环，不产生或伪造 FFmpeg/libaom 分析结果；`test/libaom-fixture` 另外以确定性 MI grid 编译生产映射源码，验证上游字段适配和 Worker IPC；
- `test/worker-sandbox-smoke.c`：证明安装过滤器后 stdout 仍可用，`open`/`socket` 均以 `EPERM` 被拒绝；非 Linux 只报告 unsupported；
- `test/worker-limits-smoke.c` 与 `test/worker-parent-death-smoke.c`：回验 CPU/core/FD limits，并证明父进程退出会实际清除子 Worker；
- `scripts/check-native-abi.mjs`：选择 `CC/cc/gcc/clang`，只在系统临时目录生成 object 并清理。

`npm run check` 在有 C11 compiler 的平台用 `-std=c11 -pedantic -Wall -Wextra -Werror` 编译 ABI smoke 和 test-only mock；如果 libavformat development/runtime tools 可用，还生成三种真实 AV1 容器，运行 adapter↔ffprobe 逐 packet 差分和 93 例确定性 malformed smoke。`npm run check:ffmpeg-adapter:sanitize` 追加 ASan/UBSan。Status 的 ABI 类型是固定 4-byte `uint32_t`，命名 enum 仅作为常量集合。当前 Linux x86_64 冻结：`ByteRange=16`、`MotionVector=12`、`BlockRecordV1=88`、`BlockRecordV2=104`、`Sample=64` bytes；v2 detail tail offset 88。Rust FFI 必须重复 layout assertions，并把未知 status 当成 adapter failure 数据处理。

`npm run native:build:ffmpeg` 从固定本地 upstream checkout 构建 FFmpeg 7.1.5
LGPL release bundle；`npm run check:ffmpeg-release` 验证完整 inventory、许可证、SBOM、
ELF 依赖/RUNPATH 和实际 decode/demux。详细契约见
[`FFMPEG_BUNDLE_V1.md`](../docs/implementation/FFMPEG_BUNDLE_V1.md)。

## 兼容和所有权

- 每个公开输入/输出 struct 首字段为 `struct_size`、`abi_version`；调用者清零未知尾字段，实现按双方已知的最小 size 读取；v1 函数只接受 ABI version 1；
- 函数名包含 `_v1`，破坏布局或语义时新增符号，不修改既有符号；
- demux 仅持有 opaque handle，通过 caller `read_at` 读取；任何 `AVFormatContext`/`AVPacket` 不出适配器；
- inspection 每个成功 create 拥有独立 decoder；libaom 对象和 entropy state 不出进程/适配器；
- inspection Worker 保持单 decoder session，逐帧传入编码 sample；父侧校验 executable digest、响应顺序、块预算和 GUI 几何后才接受 overlay；
- diagnostic text 是短期 borrowed bytes；adapter info 是 process-lifetime borrowed bytes；Block chunk 只在 callback 内有效；
- callback 返回非 OK 即停止 producer。输入 sample、probe、frame 和 chunk 都有硬预算；调用可携带 cancel callback 与 deadline；
- adapter 不接收路径、不拥有源文件、不进行网络访问。绝对路径和 payload 不写日志。

## 实现门禁

正式产品接入前必须：

1. pin FFmpeg/libaom 版本与构建选项，记录源码 commit、patch digest、compiler 与 feature flags；
2. demux adapter 对 Node/FFprobe Golden 的 sample offset/DTS/PTS/keyframe 逐项差分（当前 Linux IVF/MP4/WebM smoke 已满足，完整语料仍需扩展）；
3. inspection adapter 对固定 libaom build 生成 Block Golden，并由现有 `Block Overlay v1` validator 消费；
4. ASan/UBSan、损坏输入、取消/deadline、callback backpressure、重复 create/destroy 和 worker crash/retry 通过；
5. Windows/Linux x64 ABI layout 和 calling convention 均编译验证。
