# Rust Core Source Baseline v1

状态：Source baseline（2026-08-13）；本机尚未进行 Rust toolchain 编译验证。

## 目的

该基线把已经由 Node reference 和 Golden 冻结的最底层结构契约迁入 Rust 2024，同时不声称已替代生产路径。workspace 固定 edition 2024、MSRV 1.85、resolver 2，并暂时保持零第三方 crate，便于在隔离 CI 中首先验证语言、布局和错误边界。

## Crates

- `av1-analysis`：把 format detection、IVF frame range、逐帧绝对 OBU range、frame→OBU ID 和统一预算贯通为一个 structural result；
- `av1-model`：checked byte range、bit range、OBU/诊断/语法状态模型；
- `av1-bits`：只读 MSB-first 有界 bit reader 和零位对齐检查；
- `av1-ivf`：IVF header、codec/尺寸/timebase 和逐帧 sample/payload range 索引，保留截断与 frame-budget stable prefix；
- `av1-structural`：low-overhead OBU header、extension、LEB128、payload range、稳定诊断和记录预算；
- `av1-native-sys`：`native/include` C ABI v1 的手写 FFI。外部 status 以 `u32` 接收，再显式转换为已知枚举，未知值保持为数据而不构造非法 Rust enum。
- `av1-native-guard`：纯 safe Rust 信任边界，验证 status、ABI prefix、sample source range/budget、BlockRecord geometry/value 与 chunk pointer/count metadata；它不解引用 adapter pointer。
- `av1-native-demux`：集中审计的 demux unsafe wrapper；RAII 关闭 handle、固定 source callback lifetime、捕获 callback panic、复制 borrowed diagnostic，并校验 adapter/stream/sample。handle 有意为 `!Send + !Sync`。
- `av1-worker-protocol`：纯 safe Worker v1 stdout decoder，验证固定 framing、status/kind/order、canonical signed32、sample ID/flags/range/budget、End/Error reserved。

普通 crate 使用 `#![forbid(unsafe_code)]`。`av1-native-sys` 只允许 raw FFI declaration，`av1-native-demux` 是唯一调用 demux 的窄 unsafe 边界，复制后的数据通过 `av1-native-guard`。未来 inspection callback record 仍需独立的小型审计 wrapper。sys crate 不声明 Cargo `links`；生产 loader/静态链接策略尚未固定。

## 已执行门禁

本环境实际执行：

- `npm run check` 静态核对 workspace 成员、版本、safe crate 禁止 unsafe、C/Rust 关键布局断言和结构 parser 必需诊断；
- C11 smoke 以 `-pedantic -Wall -Wextra -Werror` 编译，确认 status 为 4 bytes、BlockRecord 为 88 bytes、Sample 为 64 bytes及关键 offset；
- Node 全量测试继续作为行为 oracle。

`test/fixtures/obu-structural-golden-v1.tsv` 的 14 组覆盖 OBU；`ivf-index-golden-v1.tsv` 的 10 组覆盖 IVF；`native-demux-worker-golden-v1.tsv` 的 10 组覆盖 IPC response（含 Worker sandbox capability 位）；`native-demux-request-golden-v1.tsv` 的 6 组覆盖 request header 与预算错误。Node 端当前实际执行全部 40 行；Rust `include_str!` 读取相同字节文件，工具链 CI 才能提供 Rust 端通过证据。

本环境没有 `cargo`/`rustc`，所以下列门禁仍为待验证，而不是通过：

```bash
npm run check:rust
```

该命令执行 `cargo fmt --check`、workspace 全 target Clippy `-D warnings` 和 workspace tests。GitHub CI 的独立 `rust-core` job 安装 1.85.0 + rustfmt + clippy 后执行同一命令。

## 切换生产路径前的退出条件

1. Rust CI 实际通过，并消除所有 compiler/rustfmt/clippy 反馈；
2. 将当前 low-overhead 共享 Golden 扩展到 raw/IVF/MP4/WebM sample table，并对 Node reference 做逐 OBU range、header、诊断差分；
3. fuzz/property 测试覆盖 LEB128、offset overflow、truncation 和 budget stable-prefix；
4. demux safe wrapper 的真实 adapter 集成测试通过；inspection wrapper 拒绝未知 status、ABI/struct size 不匹配、越界 sample 和无效 callback chunk；
5. 仅在性能与兼容性门禁通过后，Rust core 才成为默认分析路径。
