# AV1Scope 项目完成度审计

审计基线：`AV1Scope_System_Design.docx`、`DEVELOPMENT_WORKFLOW.md`、当前源码、自动化测试与实测命令。2026-08-21 本环境没有可用浏览器或 Rust/cargo；因此 GUI 视觉/FPS 和 Rust 生产工具链不计为已验证。

## 已有直接证据

| 设计能力 | 当前证据 | 结论 |
|---|---|---|
| IVF/raw/MP4/WebM 结构索引 | 四格式 streaming/eager parity、Matroska 四种 lacing、1 GiB 规模探针 | Node reference 已实现 |
| OBU、Sequence/Frame Header、Tile Group、Metadata 与 source range | parser、Golden、FFmpeg trace 差分、Derived Syntax | Tile Group 结构边界已实现；熵语法仍由 libaom producer 承担 |
| 损坏输入诊断、预算、取消 | property/fuzz smoke、结构化诊断、一次性分析 Worker、FFmpeg abort | Node 进程内参考隔离已实现 |
| 时间线、帧分析表、字段树、帧预览、直方图、比较、PSNR/SSIM | GUI/API/静态测试和 FFmpeg 集成测试；帧表具备组合筛选、稳定排序、100 行分页、联动与筛选导出 | 功能已实现；键盘/ARIA/responsive contract 已自动化；sandbox 对 `127.0.0.1:4173` listen 返回 `EPERM`，真实浏览器/读屏视觉证据仍缺失 |
| Block Overlay 链路 | v1/v2 合约、有状态 Worker v2、内容寻址 chunk store/分页 API、WebGL2 mode/partition/Q/Q-delta/MV arrows；luma union/overlap、Q 直方图和多维分布；100k block + 76,190 MV CPU gate | 固定 libaom v3.12.1、feature 127、temporal-unit hidden/compound 解码、1,086-block Golden、供应链 manifest 与完整请求 crash replay已通过；真实浏览器 FPS 仍待验收 |
| 固定 Snapshot 导出与分页 | 内容寻址 chunk store、Derived/Overlay、完整性验证、GC | reference store 已实现；非 SQLite/WAL |
| 查询 | Snapshot Query v1、稳定 token、CLI/API/GUI、chunk-level sidecar pruning、损坏重建与 GC | reference store 已实现；首次索引构建仍为 O(n)，非通用数据库索引 |
| JSON/CSV/PNG、确定性 batch report 与 CLI | 端到端测试、Batch Analysis Report v1 | Node reference 已实现 |
| 原生进程接缝与 Rust 起点 | C ABI v1；真实 libavformat adapter 对 IVF/MP4/WebM 逐 packet 匹配 ffprobe，普通与 ASan/UBSan 下通过 93 个畸形输入；有界 Linux Worker 通过固定 IPC 接入 GUI/CLI 并与 reference Frame/OBU parity；固定 FFmpeg 7.1.5 LGPL bundle 绑定源码、六库、许可证、SBOM、完整 inventory，并通过 ELF/runtime/decode/demux gate；GUI 自动验证后使用 bundle；Rust 2024 九 crate source baseline、RAII demux wrapper、纯 safe IPC request/response codec 与 40 组共享 Golden | Linux demux producer/Worker 与 FFmpeg 工程供应链已实现；seccomp 仍是 denylist；本机无 Rust 编译证据，Tauri/Windows/安装包仍未完成 |

## 未满足的最终产品要求

1. Rust 2024 workspace、窄 C ABI、Linux libavformat adapter、有界 Worker/IPC feature path 和 `av1-native-demux` safe handle 源码已创建，固定 FFmpeg 7.1.5 LGPL 工程 bundle 也已通过；但 Rust 工具链编译、真实 adapter↔Rust wrapper 集成、Windows Job Object、Tauri 2 + React/TypeScript 桌面壳和安装包尚未完成；当前本地 HTTP/Node 实现仍是默认差分基线，不是最终生产安全边界。
2. 有状态 inspection Worker v2、固定 IPC、取消/超时、新进程全请求重放、私有事件 ABI、公共 v1/v2 adapter bridge、固定 libaom v3.12.1、partition/coeff hooks、真实 Block Golden 以及 artifact/license/SBOM manifest 已实现；发行门禁证明首次进程完整接收 11,911-byte 请求后崩溃，第二个新进程用真实 libaom 对 24 帧产生逐块一致结果，并在成功 provenance 中保留首个 crash。该证据验证 supervisor 边界，不声称人为触发了 libaom 内部缺陷。
3. Node reference 已有 parent-bound 内容寻址 Block Overlay chunk store、完整性验证和分页 API；SQLite WAL + zstd/列式生产缓存、事件游标订阅、按字节调度/背压和共享像素句柄尚未实现。
4. Tile Group header、size 与 tile-level source mapping 已在 Node reference eager、OBU_FRAME 和独立 Tile Group Derived inspection 路径实现；熵解码和真实 BlockRecord producer 尚未实现。
5. 1 GB 高密度真实容器首屏 P95 <2 s、随机跳转 P95 <250 ms、4K 深度分析 <1.5 GB、10 万 overlay 浏览器 P95 ≥45 FPS 均缺少目标环境证据。
6. FFmpeg/libaom SBOM 与依赖许可证 inventory 已完成；项目自身许可证/法律审查、Windows/Linux 安装包、签名、升级/卸载、8h fuzz、24h 压力和 beta 用户验证尚未完成。
7. 插件 SDK/权限/沙箱、更多封装或实时输入属于 M4，尚未实现。

## 当前优先顺序

Node reference 的隔离缓存损坏/重建演练、Snapshot Query sidecar/GC、Block Overlay 分页回放和固定 FFmpeg bundle gate 已自动化；它不冒充桌面二进制/SQLite 版本回滚。下一关键路径是 Rust/Tauri、SQLite 通用索引、真实浏览器验收和真正的安装包迁移/回滚。
