# Rust Native Demux Bridge v1

## 状态

`av1-native-demux` 是 `av1scope_demux_*_v1` 与未来 Rust Worker 之间的窄桥接层。当前已完成源码、mock adapter 单测和静态契约检查；本机没有 `cargo`/`rustc`，所以尚未把它标记为已编译，也尚未接入默认 GUI 分析路径。

## 所有权

- `DemuxHandle` RAII 独占一个非空 native handle，`Drop` 恰好调用一次对应 dispatch table 的 `close`；
- `SourceBridge` 由固定地址的 `Box` 持有，内部 `Arc<dyn ReadAtSource>` 至少存活到 native handle 关闭之后；
- native adapter 只能临时借用 `read_at` destination、call context 和 diagnostic output；
- adapter 名称、build identity 和 diagnostic message 在返回 Rust API 前立即复制为 owned `String`；
- dispatch table 必须来自同一个仍在进程中加载的 ABI v1 动态库。未来 loader 必须让 library guard 比所有 `DemuxHandle` 活得更久。

## 线程与故障边界

`DemuxHandle` 通过 `PhantomData<Rc<()>>` 明确为 `!Send + !Sync`，只允许所属 Worker 串行操作。取消状态放在稳定的 `Arc<AtomicBool>` allocation 中。`read_at` callback 使用 `catch_unwind`，Rust panic、I/O error、越界 offset、过大返回值都转换为 `-1`，不会展开越过 C ABI。

这层只能约束调用方内存安全，无法证明第三方库内部没有崩溃或任意内存访问。因此生产架构仍要求 demux 在可终止、可重启的专用 Worker 进程内运行，主进程只接收经过 schema/budget 校验的标量记录。

## 入站校验

- options：track 非负或自动选择；probe 为 32 bytes–256 MiB；sample 为 1 byte–1 GiB；source 不超过 `i64::MAX`；
- adapter identity：ABI、reserved、borrowed pointer/length 和字符串上限；
- stream：ABI、AV1 fourcc、非负 track、非零尺寸、正 time base；
- sample：ABI、已知 flags、checked range、source 边界、sample budget、固定 track 和从 0 连续的 sample ID；
- status：未知 `u32` 永远作为 contract error，不构造非法 Rust enum。

## 验证

Rust mock adapter 测试覆盖 source callback、adapter identity、stream、两个 sample、EOF、取消 callback 以及 Drop 关闭。真实 libavformat adapter 目前由 C harness 验证 IVF/MP4/WebM 与 ffprobe 的逐 packet parity，并通过 93 个确定性畸形输入的普通及 ASan/UBSan smoke。Rust 工具链可用后执行：

```bash
npm run check:rust
```

合入默认路径前仍需：真实动态库 loader/lifetime guard、Worker IPC schema、崩溃重启与重试上限、Linux/Windows/macOS 固定 FFmpeg 构建和许可证/SBOM。
