# Native Demux Worker v1

## 状态

Linux reference Worker 已实现并实际贯通：Node 父进程 → 固定二进制 IPC → 独立 C 进程 → custom-AVIO libavformat adapter → 固定 scalar records → 父进程二次校验 → 现有 MP4/WebM structural parser。默认仍是 ffprobe reference，只有 GUI/CLI 显式传入 `--native-demux-worker PATH` 才启用；失败不会静默回退。

## IPC

父进程 stdin 请求由 56-byte v1 header 和原始媒体 bytes 组成。header 包含 ABI/结构大小、输入长度、probe/sample/record budgets、track selector 和 reserved。Worker stdout 首先返回 16-byte protocol header，随后是 72-byte 定长记录：Stream、Sample、End 或 Error。Stream 最后一个 u64 的低 32 位是 adapter feature flags，高 32 位是 Worker sandbox capability flags；未知位必须拒绝，0 保持早期 v1/非 Linux 兼容。

IPC 不包含文件路径、FFmpeg 指针、diagnostic text 或媒体 payload 回显。时间戳保留有符号 64-bit；父侧用 BigInt 接收。未知 status/kind、错误顺序、重复 Stream、非连续 sample ID、track 改变、未知 flag、range/budget escape、缺 End 和多余 bytes 全部作为 protocol error 拒绝。父进程使用增量状态机直接消费 stdout；16-byte header 和 72-byte record 可跨任意 pipe chunk 边界，不再先聚合完整响应或建立 `Buffer.concat` 整包副本。每条完整记录到达即执行状态、顺序、预算和 source range 校验，End/Error 后出现的任何字节立即拒绝。

## 资源与故障域

- 输入：64 MiB；sample records：250,000；父侧 stdout 按协议上限计费并增量解码、stderr 64 KiB；父侧只额外保留固定 16/72-byte staging buffer；
- Linux/macOS 普通构建：address space 768 MiB、CPU 30 s、core dump 0、open file descriptors 16；父侧 wall deadline 默认 15 s。ASan 需要大范围虚拟地址映射，因此 sanitizer 构建有意跳过 `RLIMIT_AS`，但仍保留 CPU/core/FD/wall-time 门禁；独立 limits smoke 从同一生产实现回读 CPU/core/FD 值；
- Linux x86_64/aarch64 在读取任何请求前设置 `PR_SET_PDEATHSIG(SIGKILL)`、non-dumpable、`PR_SET_NO_NEW_PRIVS` 并安装 seccomp BPF denylist，路径打开、网络、进程创建/执行、跨进程内存、mount/namespace、BPF/keyring/io_uring/memfd 等入口返回 `EPERM`；独立 smoke 验证 `open`/`socket` 被阻止且 stdout 可继续写，另一个双进程 smoke 证明父进程退出后子 Worker 实际消失。当前是高风险 syscall denylist，不冒充最小 allowlist；当前环境因 `ptrace EPERM` 无法采集足够 syscall trace，不能无证据切换为 allowlist；其他平台不标记为受 seccomp 保护；
- 父侧在启动前和成功结束后对指定 Worker regular file 计算 SHA-256/size（最大 256 MiB），两次不一致返回 `NATIVE_DEMUX_EXECUTABLE_CHANGED`；报告和 GUI 记录启动前摘要。由于内核仍按 path 执行，该摘要是 provenance/竞态检测，不是消除 hash→exec TOCTOU 的加载时完整性保证；
- 取消/超时使用强制终止；非零 exit 或 signal 分类为 `NATIVE_DEMUX_CRASHED`；
- C worker 自身不重试。调用方可在新进程中重试一次，但必须保留第一次 crash diagnostic，且不得对同一确定性 crash 无限循环；
- Windows 尚需 Job Object/mitigation policy，对应当前 `setrlimit` 不生效，不能据此宣称 Windows 沙箱完成。

## 验证

自动测试编译真实 Worker，生成三帧 AV1 MP4/WebM，逐项对照 ffprobe 的 stream、DTS/PTS/duration/key/offset/size；再比较 native 与 reference 产出的 Frame/OBU 记录。普通与 ASan/UBSan Worker 构建均执行该路径。另覆盖共享 Node/Rust request/response Golden、所有 1-byte 到整包以上的流式 chunk size、header/record 提前 EOF、End/Error 后附加数据、2,000 例固定种子协议 bit-flip/截断/分块 fuzz smoke、畸形输入 status、协议 range 拒绝、预取消、25 ms timeout、非零退出 crash 分类、可执行文件中途改变、父进程死亡清理和 CMake target。

```bash
npm run check:native-worker
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --parallel
npm run gui -- --native-demux-worker build/native/av1scope_ffmpeg_demux_worker
node bin/av1scope.mjs analyze input.mp4 --native-demux-worker build/native/av1scope_ffmpeg_demux_worker
```

该 Worker 是从 reference 到生产架构的隔离切片，不是最终沙箱。Native demux 已有一次 crash retry、Linux denylist 与行为 smoke；生产仍需固定 FFmpeg、最小 syscall allowlist/更窄 OS 权限、Tauri supervisor policy、Windows Job Object 和 Rust/Tauri owner。
