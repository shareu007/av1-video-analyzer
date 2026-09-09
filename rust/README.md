# AV1Scope Rust 2024 workspace

这是生产核心迁移的最小、零第三方依赖起点，不是已发布的 Rust/Tauri 产品。

## Crates

- `av1-analysis`：format detection → raw/IVF frame → OBU record/diagnostic/budget 的纵向 structural facade；
- `av1-model`：稳定范围、OBU、诊断与语法状态模型；所有范围加法可检查；
- `av1-bits`：MSB-first 有界 bit reader 与零位对齐验证；
- `av1-ivf`：IVF header/timebase 与逐帧 sample/payload range 索引，保留截断和预算稳定前缀；
- `av1-structural`：low-overhead OBU header/extension/LEB128/range 参考迁移，保留稳定前缀与预算诊断；
- `av1-native-sys`：手写 C ABI v1 bindings 和 C/Rust size/offset 对照测试。
- `av1-native-guard`：纯 safe Rust 的 status、ABI prefix、sample range、BlockRecord 与 chunk metadata 信任边界；不解引用 adapter 指针。
- `av1-native-demux`：真实 demux ABI 的窄 audited wrapper；RAII 持有 native handle 与 `read_at` source，callback 捕获 panic，复制诊断字符串，并校验 stream/sample/预算/连续 ID。handle 有意为 `!Send + !Sync`，只能由所属 Worker 线程串行调用。
- `av1-worker-protocol`：纯 safe Rust 的固定 Worker v1 stdout decoder，和 Node 共用 10 组 IPC response Golden；拒绝 framing/status/order/signed encoding/adapter 与 sandbox flags/range/budget/reserved 漂移。

Workspace 固定 edition 2024、MSRV 1.85，普通 crates 禁止 unsafe；`av1-native-sys` 只声明裸 ABI，`av1-native-demux` 是调用 demux 所需的第二个、集中审计的 unsafe 边界。`av1-native-guard` 先验证所有复制后的标量和 pointer metadata。inspection callback records 仍没有解引用 wrapper。当前没有外部 crate，便于工具链离线建立后先运行基础门禁：

```bash
cd rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

本环境没有 `cargo`/`rustc`，上述命令尚未执行，因此 Rust workspace 状态是 **source baseline / pending toolchain validation**。C 对应 ABI 已由仓库 `npm run check` 实际编译。Node 与 Rust 已分别接入同一份 14 组 OBU Golden 和 10 组 IVF index Golden；工具链可用后的首要工作是修复所有 fmt/clippy/compiler 反馈并实际执行 Rust 端向量，再扩展 MP4/WebM sample table。验证前不能切换生产默认路径。
