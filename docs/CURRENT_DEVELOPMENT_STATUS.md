# AV1Scope 当前开发现状

更新时间：2026-08-21
项目状态：**Validating（Node reference path 可运行，最终 Rust/Tauri 产品迁移中）**

## 1. 当前结论

AV1Scope 已经形成一套可以运行和自动验证的 AV1 码流分析参考产品，覆盖 raw low-overhead OBU、IVF、MP4/ISOBMFF、WebM/Matroska，具备结构解析、时间线、字段检查、帧预览、比较分析、Snapshot、查询、批处理和 CLI。Linux 上已经有真实 libavformat C adapter 和独立 Native Demux Worker，可由 GUI/CLI 显式启用。

当前实现适合作为：

- AV1 结构分析器、交互设计和数据契约的参考基线；
- 后续 Rust/Tauri、SQLite 和 libaom inspection producer 的差分 oracle；
- M0/M1 大部分能力及部分 M2/M3 能力的可运行验证版本。

当前实现还不适合作为正式发行产品。主要原因是 Rust workspace 尚未获得本机编译证据、Tauri 桌面壳和 SQLite 生产存储尚未接入，项目自身仍为 `UNLICENSED`，真实浏览器与安装包验收也尚未完成。固定 FFmpeg 发行依赖的工程供应链门禁已经通过，但仍需法律审查。

## 2. 已完成的工作

### 2.1 AV1 输入与结构解析

- 支持 raw low-overhead OBU、IVF、MP4/ISOBMFF、WebM/Matroska；
- 支持 eager 分析和大文件 streaming index；
- MP4/WebM packet/sample byte range 与 ffprobe 做逐项差分；
- 支持 Matroska none、Xiph、fixed、EBML 四种 lacing；
- 解析 OBU header、extension header 和 LEB128 size；
- 解析 Sequence Header，包括 operating point、尺寸、工具开关、order hint、颜色配置、film grain 和 trailing bits；
- 解析常见 Frame Header 路径，包括参考帧、tile、quantization、segmentation、loop filter、CDEF、restoration、global motion、film grain 和 timing；
- 解析 Metadata OBU，包括 HDR CLL、HDR MDCV、ITU-T T.35、Scalability Structure 和 Timecode；
- 解析 Tile Group 结构、tile range、tile size 和 source mapping；tile entropy 保持为不透明 payload；
- 字段、OBU、帧和诊断均携带可追溯 source byte/bit range；
- 对截断、越界、保留位、预算耗尽和结构错误返回稳定的结构化诊断。

### 2.2 GUI 与分析体验

- 本地分析工作台：文件打开、帧时间线、OBU 树、字段检查器、十六进制/结构视图、诊断导航；
- FFmpeg 隔离帧预览和亮度直方图；
- Selected Frame Coding State，展示量化、分块、预测、环路工具、Global Motion 和 Film Grain；
- 双码流比较、帧擦拭、Y-PSNR、MAE、全局 SSIM 和差异直方图；
- JSON、CSV、PNG 导出；
- WebGL2 instanced Block Overlay consumer、空间拾取，以及 mode/partition/Q/Q-delta + MV arrow 图层；MV 支持 precision→pixel 显式换算、双参考着色、缩放/过滤、统计和选中块高亮；
- Block Statistics 默认隔离 luma plane，区分记录数和面积占比，计算精确矩形 union coverage、重叠/重复面积，并展示 QIndex 直方图、模式/分区/尺寸/Segment/Transform/Reference/Filter 分布；可按 intra/inter/skip/compound/MV/非零系数或全部 plane 过滤可视块；
- GUI 显示 parser、container demux、adapter、版本、feature flags、Worker sandbox capability 和 Worker binary SHA-256/size；
- tabs、时间线、OBU、字段和诊断支持 roving focus、Arrow/Home/End；
- 已加入 ARIA、busy state、dialog、reduced-motion、forced-colors 和窄屏/高缩放样式契约。

### 2.3 Snapshot、查询和批处理

- 内容寻址 Snapshot Store，分块写入、chunk SHA-256、临时目录原子发布和完整性重验；
- Snapshot 分页读取和确定性完整重建；
- 大文件流式索引不要求把完整文件或完整记录集合放入内存；
- Snapshot Frame 可从最近随机访问帧规划不超过 64 MiB/10k 帧的解码窗口，按需拼接源 sample 与已索引 Sequence Header，在有状态 inspection Worker 中顺序分析并按原始 frameId 持久化；
- 源文件首尾指纹绑定和按 OBU range 的按需语法检查；
- Derived Syntax Snapshot 和多 OBU Syntax Overlay Snapshot；
- Derived parent/OBU 持久索引、损坏自动重建和显式重建 CLI；
- Snapshot Query v1，支持受限 AST、稳定分页 token、projection、CLI/API/GUI；
- Snapshot Query sidecar v1，可对常用等值/范围/存在性条件做 chunk pruning，损坏自动重建并由 cache GC 安全回收；
- 引用感知 cache GC，默认 dry-run，apply 前必须再次验证 plan ID；
- 隔离 Cache Recovery Rehearsal，可验证 staging 清理、索引重建和内容不被误删；
- 确定性 batch report、有界并发、逐文件失败记录、JSON/CSV、可选逐文件 Snapshot。
- GUI 帧分析表支持 Frame/Type/PTS/DTS/Duration/Size/Bitrate/Q/GOP/Refs/OBU/Diagnostics 列、组合筛选、稳定排序、100 行有界分页、选帧联动和筛选结果 CSV/JSON；Snapshot 模式使用服务端 100 帧分页。

### 2.4 Native ABI、FFmpeg adapter 和 Worker

- 冻结 C ABI v1：固定宽度结构、ABI version、ownership、取消、deadline、预算和 adapter provenance；
- C11 layout/runtime smoke 实际编译和运行；
- 真实 custom-AVIO libavformat adapter 只通过 caller `read_at` 读取，不接收媒体路径或 URL；
- IVF、MP4、WebM 的 stream/sample DTS、PTS、duration、key flag、offset 和 size 与 ffprobe 一致；
- 真实 adapter 在普通及 ASan/UBSan 构建下通过 93 个确定性 malformed cases；
- 独立 C Native Demux Worker：56-byte request、16-byte response header、72-byte scalar records；
- 父进程逐 chunk 增量解码 stdout，不再先聚合完整响应；
- 对任意 pipe chunk boundary 即时校验 status、kind、record order、ID、track、flags、budget 和 source range；
- 输入限制 64 MiB，record 限制 250k，普通构建地址空间 768 MiB，CPU 30 秒，FD 16，core dump 0，父侧 wall timeout 默认 15 秒；
- 取消/超时强制终止；crash 最多用新进程重试一次并保留第一次 crash；
- Linux x86_64/aarch64 启用 parent-death、non-dumpable、`no_new_privs` 和 seccomp 高风险 syscall denylist；
- 独立行为 smoke 证明 `open`/`socket` 被拒绝、limits 生效、父进程退出后不遗留 Worker；
- Worker 启动前和成功后计算 SHA-256/size，变化时拒绝结果；报告中的摘要属于 provenance/竞态检测，不等于消除 path-exec TOCTOU；
- GUI Worker Thread → C Worker、CLI → C Worker 和最终 Frame/OBU parity 均有真实容器回归。
- 固定 FFmpeg 7.1.5 LGPL-only bundle 已绑定 upstream commit、Git archive、compiler、configure flags、libaom/zlib、六个运行库、许可证、CycloneDX 1.6 SBOM 和完整目录 inventory；ELF SONAME/RUNPATH/依赖、PNG decode、Trace 与 24-sample demux gate 通过；GUI 自动验证 build ID 后使用 bundle 内 ffmpeg/ffprobe/Worker。
- 独立 Native Inspection Worker v2：有状态多帧 decoder session、112-byte 固定 IPC record、增量响应解码、预算/顺序/ABI/几何校验、取消/超时、crash 新进程重试和 executable digest 校验；
- BlockRecord v1 的 88-byte ABI 保持不变；104-byte v2 追加 MI coordinates、compound type 与 quant delta，C/Rust/Worker/Node/Snapshot/GUI 已同步；
- inspection 结果自动进入 GUI，并可写入独立的内容寻址 Block Overlay Snapshot，支持 parent binding、chunk checksum、分页读取、GC 引用和恢复演练；
- inspection 端到端证据包含 test-only mock 以及确定性 libaom MI fixture；后者会编译生产映射源码并贯通 adapter/Worker/Node，但仍不代表真实 AV1 解码 Golden。
- 已实现 `av1scope_libaom_patch` 私有逐块事件 ABI 和公共 inspection adapter bridge，覆盖 event 校验、连续 block ID、chunk/backpressure、取消/deadline、feature flags 与固定 build ID；test stub 只验证 bridge mechanics；
- 已加入固定 libaom build manifest、artifact/license/SBOM provenance 校验和真实 Block Golden release gate；缺少真实 fork/Worker/Golden 时门禁明确保持 blocked。
- 已固定 libaom v3.12.1 commit `10aece…`，自动应用 inspection patch `6520bc…` 并完成 static/PIC Worker 构建；feature mask 127 已包含 partition 与真实 luma non-zero coefficient count。
- 已修正 `Av1DecodeReturn.buf` temporal-unit 游标处理，可连续解码 hidden/alt-ref/show-existing 子帧并只为显示帧输出块记录。
- 两个项目生成的 CC0 AV1 Golden 覆盖 32 个 packet、1,086 个块和九类语义门禁，完整 BlockRecord 回归已通过。
- 固定构建会生成 schema v2 manifest，绑定 Git archive、patch/producer、toolchain、`SOURCE_DATE_EPOCH`、三个 native artifact、BSD-2-Clause、AOM PATENTS、license inventory 与 CycloneDX 1.6 SBOM；门禁会重新读取每个文件并校验摘要。当前实证 build ID 为 `ae7b8e5e6a2603fd9055ec50527bfa5469fbd3ce`。

### 2.5 Rust 迁移基线

- 建立 edition 2024、MSRV 1.85 的九 crate workspace；
- `av1-model`、`av1-bitstream`、`av1-structural`、`av1-ivf`、`av1-analysis` 提供纯 safe 核心起点；
- `av1-native-sys` 集中原始 FFI 定义；
- `av1-native-guard` 提供 safe 数据边界；
- `av1-native-demux` 提供 RAII handle、稳定 source ownership、取消和 sample 校验；
- `av1-worker-protocol` 提供纯 safe request encoder 和 response decoder；
- Node/Rust 共用四份 TSV、40 组 Golden，覆盖 OBU、IVF、Worker request/response 和 sandbox capability；
- CI 已配置 Rust 1.85 fmt、clippy 和 workspace tests。

注意：当前机器没有 `rustc`/`cargo`，所以上述 Rust 部分只标记为 source baseline，不能表述为已在本机编译通过。

### 2.6 质量、性能和供应链门禁

2026-08-21 当前实测：

- `npm run ci`：50/50 测试文件通过；
- 116 个 JavaScript 文件通过语法检查；
- 全量覆盖率：90.73% lines、81.89% branches、92.80% functions；
- Native Demux Worker 父侧：88.37% lines、88.19% branches；
- 固定种子 2,000 例 AV1 parser fuzz smoke；
- 固定种子 2,000 例 IPC bit-flip、截断和随机分块 mutation smoke；
- Native Worker 普通与 ASan/UBSan 回归通过；
- CMake 可构建 shared adapter、Worker、ABI/limits/sandbox/parent-death smoke；
- libaom release gate：artifact/license/PATENTS/CycloneDX、1,086-block Golden 与 11,911-byte/24-frame crash replay 通过；
- 性能门禁连续两轮通过：10k OBU P95 6.67/5.64 ms，100k BlockRecord validation P95 54.86/50.40 ms，实例 buffer P95 7.10/3.69 ms；
- MV buffer 门禁覆盖 100k blocks / 76,190 vectors，本轮 P95 19.24/10.26 ms（CPU buffer，不代表浏览器绘制 FPS）；
- Block Statistics 门禁覆盖 100k blocks 的精确 rectangle union，本轮 P95 191.47/213.44 ms；
- 当前系统 FFmpeg 7.1.5 development build 的 provenance 已采集，并因 `--enable-gpl` 和证据缺失被正确阻止；独立固定 FFmpeg 7.1.5 release bundle 的工程门禁已通过，build ID 为 `140c0659911fc800f3633584ab552fa2110787fd`。

## 3. 尚未完成的工作

### 3.1 最终 Rust/Tauri 产品架构

- 在实际 Rust 工具链执行 `cargo fmt`、`cargo clippy -D warnings`、workspace tests；
- 让 Rust owner 实际加载/拥有 native adapter 和 Worker，而不只是保留源码接缝；
- 实现 Tauri 2 + React/TypeScript 桌面壳；
- 将 Node HTTP GUI 从默认产品路径降级为 reference/oracle；
- 实现桌面 session supervisor、权限策略、崩溃恢复和正式 Feature Flag 管理。

### 3.2 libaom 深层块分析

- 在真实浏览器验证完整 producer 的 WebGL Block Overlay。

固定、干净的 v3.12.1 源码、Block Golden、供应链 manifest 与 11,911-byte 完整请求 crash replay 已验证；剩余验证是真实浏览器 WebGL 链路。crash gate 验证 supervisor 在进程崩溃后的确定性重放，不声称人为触发了 libaom 内部缺陷。

### 3.3 生产存储与大规模调度

- SQLite WAL session database；
- 以 SQLite WAL + zstd/列式缓存替换当前 Node 内容寻址 JSON chunk reference store；
- schema migration 和版本回滚；
- 事件游标订阅；
- 按估算字节调度、队列背压和会话级资源配额；
- 跨进程共享像素句柄；
- SQLite 通用二级/表达式索引，替换当前首次 O(n) 构建、后续 chunk-level pruning 的 sidecar。

### 3.4 平台安全和依赖发行

- 将 Linux seccomp 从高风险 denylist 收敛为有真实 syscall trace 证据的 allowlist；当前环境禁止 ptrace/strace，不能无证据完成；
- 消除 Worker path-exec 的 hash→exec TOCTOU，改用受打包器控制的固定 FD/handle 或等价加载策略；
- Windows Job Object、mitigation policy、handle allowlist 和进程生命周期验证；
- 为项目自有 Native/Node 代码确定对外许可证并完成法律审查；
- 将已验收的 LGPL FFmpeg bundle 纳入最终安装包、升级和回滚流程；
- 固定 libaom fork、补丁摘要和可重复构建证据。

### 3.5 GUI、性能和发布验收

- 在真实浏览器完成焦点、键盘、读屏、截图和视觉回归；
- 在目标 GPU/浏览器测量 100k overlay 实际绘制和交互 FPS；
- 验证 1 GB 高密度真实容器首屏 P95 < 2 s；
- 验证随机跳转 P95 < 250 ms；
- 验证 4K 深度分析内存 < 1.5 GB；
- Windows/Linux 安装包、签名、升级、卸载和回滚；
- 8 小时 fuzz、24 小时压力测试和目标用户 beta；
- 插件 SDK、权限模型、更多封装和实时输入属于后续 M4。

当前执行环境的 Browser 列表为空，并且监听 `127.0.0.1:4173` 返回 `EPERM`，所以不能把真实浏览器/读屏/WebGL FPS 标记为通过。

## 4. 当前风险和外部阻塞

| 项目 | 当前状态 | 解除条件 |
|---|---|---|
| Rust 编译证据 | 阻塞 | 提供 Rust 1.85+、rustfmt、clippy、cargo |
| libaom Block producer | feature/Golden/供应链/crash replay 已通 | 验证真实浏览器 WebGL |
| GUI 真实浏览器证据 | 阻塞 | 允许本地监听并提供可用 Browser/Chrome |
| FFmpeg 依赖供应链 | 工程门禁已通 | 项目许可证、法律审查及安装包集成 |
| Windows 隔离/安装包 | 未开始 | Windows 构建与签名环境、Job Object owner |
| Tauri/SQLite 产品迁移 | 待实施 | Rust 工具链和桌面构建环境 |

## 5. 下一阶段建议顺序

1. 在可用 Rust 1.85 工具链中执行 workspace fmt/clippy/test，修复所有实际编译问题；
2. 实现 Rust/Tauri owner，迁移 Native Demux Worker lifecycle 和 provenance；
3. 建立 SQLite WAL/zstd 生产存储和 migration/recovery；
4. 在真实浏览器和目标 GPU 完成 GUI E2E、视觉与 FPS 验收；
5. 确定项目许可证并完成 Windows/Linux 安装包、签名、升级/卸载、长 fuzz/stress 和 beta。

## 6. 当前阶段的完成定义

当前阶段可以表述为：

> 已完成 AV1Scope 的可运行 Node reference analyzer、GUI/CLI、Snapshot/Query/Batch、Linux libavformat Native Demux Worker，以及有状态 inspection Worker → Block Overlay Snapshot → GUI 纵向链路；固定 libaom 3.12.1 producer、真实 Golden和固定 FFmpeg 7.1.5 LGPL 工程供应链门禁已通过。项目仍处于 Rust/Tauri、生产存储和安装包发行体系的过程中。

不能表述为：

- 最终产品已完成；
- Rust core 已在本机编译通过；
- 已具有通过真实 AV1 Golden 验证的完整 libaom 块级 producer；
- Linux seccomp 已是最小 allowlist；
- Windows 沙箱、安装包和签名已完成；
- GUI 真实浏览器、读屏和 WebGL FPS 已验收；
- 工程门禁通过即可替代项目许可证和正式法律审查。
