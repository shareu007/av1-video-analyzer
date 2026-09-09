# M0 状态记录

## 2026-08-12 — 结构索引参考切片

状态：**Validating（Node reference path）**

### 已交付

- 零依赖 Node.js 20+ reference parser；
- IVF header 与 frame sample index、基于 ffprobe packet 元数据的 MP4/ISOBMFF 精确 sample range、WebM Block payload offset 校正，以及 Xiph/fixed/EBML lacing 解码与 ffprobe 尺寸交叉校验；
- low-overhead OBU header、extension header 与 LEB128 size；
- `AnalysisReport v1`、`FrameRecord v1`、`ObuRecord v1`、`Diagnostic v1`；
- `SyntaxNode v1` 与完整 Sequence Header 字段树（timing/operating point、尺寸、工具开关、order hint、color config、film grain、trailing bits）；
- 确定性 JSON、路径 basename 脱敏、原子文件导出与严格错误退出码；
- 本地 GUI 工作台：时间线、OBU 树、字段检查器、十六进制/结构视图、诊断导航与 FFmpeg 隔离帧预览；
- GUI 像素/叠加分析：亮度直方图、推导 Superblock 网格、版本化外部 Block Overlay 导入与校验、JSON 导出；
- WebGL2 instanced Block Overlay、100k 块空间拾取，以及 Selected Frame Coding State 卡片（Segmentation/Tile、环路工具、预测、Global Motion、Film Grain 与时序）；
- GUI/CLI 对比分析：双流结构预检、逐帧擦拭视图、Y-PSNR/MAE/全局 SSIM/差异直方图、JSON/CSV/PNG 导出；
- FFmpeg `trace_headers` 辅助视图与原生字段自动差分；所有预览、统计、Trace 和比较任务支持客户端取消并终止子进程；
- Frame Header 常见路径：帧类型、显示/韧性、CDF、尺寸、refresh/reference、运动控制、uniform/non-uniform tile、quantization、完整 segmentation feature、delta Q/LF、loop filter、CDEF、loop restoration、TX/reference/skip mode、global motion、film grain，以及 presentation/buffer-removal timing；
- 多 operating point 与 extension temporal/spatial layer 筛选；show-existing-frame 恢复引用类型、Frame ID、几何、order hint 与 Film Grain，并按 KEY reference 刷新全部槽；
- Metadata OBU：HDR CLL、HDR MDCV、ITU-T T.35 国家/扩展码，以及完整 Scalability Structure/Timecode 条件语法、摘要和范围诊断；
- Linux/Windows、Node 20/22/24 的 GitHub Actions CI 配置；
- 合成单测、端到端 CLI 测试和固定种子的 2,000 例 fuzz smoke。
- 可配置记录预算：Node reference 默认 250k FrameRecord / 250k OBU / 500k SyntaxNode，GUI 为 100k / 100k / 200k；预算耗尽保留稳定前缀并输出结构化 incomplete 诊断，CLI 可分别调整。IVF、ISO BMFF 与 Matroska lacing 均有 FrameRecord 预算回归。
- GUI `/api/analyze` 已迁移到一次性 Worker Thread：输入使用 transferable 交接，解析与确定性 JSON 序列化均在线程内完成；任务设 15 秒 deadline、每服务最多 2 个并发 Worker，单 Worker 限 256 MiB old-generation heap。客户端中断先向 Worker/`ffprobe` 传播取消，再强制终止 Worker；超时、取消和容量耗尽分别返回稳定错误码。健康接口公开实际记录预算、并发和 deadline。
- `Snapshot Store v1` reference path：对规范化完整报告计算 SHA-256 snapshot ID，四类集合按 1,000 条分块，chunk 带 SHA-256，临时目录完成后原子 rename；支持分页读取、完整重建、幂等复用和 manifest/内容篡改拒绝。CLI 通过 `--snapshot-dir` 贯通用户路径，stdout 报告契约保持不变。
- 大文件流式索引：CLI `index` 用 64 KiB 文件窗口直接扫描 raw OBU/IVF/MP4/WebM，不读取完整文件、不持有全量记录；MP4/WebM 的 ffprobe 改为文件路径输入，输出仍受 8 MiB 元数据预算。Writer 消费单遍 iterable，从 chunk 流式计算原 report digest；GUI 通过 snapshot ID 打开并以每页 100 条浏览四类集合。首遍 SyntaxNode 明确标记 deferred。
- GUI 大文件直传：超过 64 MiB 自动进入 `/api/index`，HTTP body 流式写入有 4 GiB 上限的临时文件，再复用 CLI file indexer 原子提交 Snapshot 并自动打开分页视图；单服务只允许 1 个索引。取消/断连传播到 upload、ffprobe、raw/IVF/container 文件扫描，返回 499，并清理上传与 Snapshot staging。源文件名使用净化后的浏览器名称，临时路径不进入报告。
- Snapshot 按需语法检查：流式索引保存不含绝对路径的首尾 64 KiB SHA-256 源指纹；GUI 只绑定大小/指纹一致且由用户明确选择的原文件。点击 OBU 后按绝对 payload range 读取最多 256 KiB，Frame OBU 向前查找最近 Sequence Header context，服务端再次核对不可变 snapshot 记录并返回绝对 bit range。
- Derived Syntax Snapshot v1：成功检查以父 snapshot、OBU、客户端提交 payload SHA-256、解析器版本和完整结果计算内容 ID，在独立目录原子发布；读取时重验父 OBU/type/range/source binding 与内容摘要。GUI 可按派生 ID 重放和导出，CLI `replay-derived` 可验证后确定性输出；父 snapshot 保持不变，manifest 明示浏览器采样/服务端 payload digest 的信任边界。
- Syntax Overlay Snapshot v1：按父 Snapshot 查询单 OBU 派生结果，显式选择每个 OBU 的唯一版本后合并；统一重编号 `nodeId`，保留 `sourceNodeId`/`derivedSnapshotId` provenance，并对父/派生集合重建校验。SyntaxNode/Diagnostic 默认每 1,000 条分块，manifest 和 chunk 各自带 SHA-256，HTTP 分页只读取相交 chunk；语义 ID 不受 chunk size 影响并兼容初始 inline v1。GUI 支持选择、构建、按 ID 打开、200 条分页检查和 JSON 导出；CLI 支持 `merge-derived`/`replay-overlay`。单次预算为 10k 派生、500k 字段、100k 诊断。
- Derived parent/OBU 持久索引：以内容目录名集合摘要作为 `storeRevision`，索引自身内容寻址并按 parent 分代保存；查询遇到新增/删除目录、缺失索引或损坏 JSON 时自动扫描经过完整校验的派生 manifest 重建。CLI 提供显式 `rebuild-derived-index` 恢复路径。
- Overlay 有界内存 merge：准备阶段只保存每个 Derived 的 contributor/计数，字段与诊断分别以 async iterator 写 chunk，语义 ID 从落盘 chunk 增量计算；GUI/API 幂等复用逐 chunk、逐记录校验，不聚合完整 overlay。只有明确要求完整 JSON 的 CLI 导出路径按契约聚合集合。
- 引用感知 cache GC：`gc-cache` 输出父/派生/overlay 引用计数和精确候选，默认 dry-run；`--apply` 只删除过期的受识别 staging 事务及旧/损坏 Derived 索引，删除前核对 mtime/文件摘要。GUI 提供同契约的“存储维护”预览与确认，POST 必须携带仍匹配当前 store 的 plan ID。内容 Snapshot 删除数固定为 0，未引用或孤立内容只报告不删除。
- Snapshot Query v1：受限 JSON AST 支持安全 dotted path、`all/any/not`、比较/集合/包含/存在运算与最多 32 个 projection；执行按 immutable collection source order 逐 chunk 扫描，分页 token 绑定 Snapshot/query ID/下一记录 offset 并带自身摘要。CLI 支持 JSON/CSV 与续页，HTTP 支持取消和 10 秒 deadline，GUI Snapshot 卡片提供单条件查询构造器。
- Tile Group Structure v1：Frame Header summary 固化实际 tile 行列和 `TileSizeBytes`；eager parser 关联 layer-scoped Frame Header context，解析显式/隐式 group range、两个 byte alignment、little-endian 非末 tile size 与逐 tile 绝对范围，并诊断乱序、越界、反向范围、截断、size 越界、extension 不一致。完整 OBU_FRAME 的 Snapshot 检查同步生成 Tile Group 字段，GUI OBU inspector 展示范围、布局与 tile sizes；coded tile entropy 保持不透明。
- Batch Analysis Report v1：CLI 以大小写无关扩展白名单和稳定相对路径顺序枚举目录，不跟随 symlink；文件数、单文件字节、每文件记录与并发数均有界。不同 `--jobs` 产生字节一致 canonical JSON；每行保存内容 SHA-256、结构/诊断/Tile 汇总和可选 Snapshot ID，JSON/CSV 原子导出。单文件操作失败以稳定 code 记录并继续，stderr 不泄露绝对根路径；严格诊断与操作失败分别返回 2/1。
- 独立 Tile Group Derived inspection：GUI 在分页 Snapshot 中查找同 layer 的最近 Frame Header 及更早 Sequence Header，三段 payload 均受 256 KiB 完整读取上限。API 重验父 OBU 类型、严格顺序、extension/temporal/spatial 与容器 frame 绑定；Derived manifest 新增 `frameHeaderContext` ID/长度/SHA-256 并在读写时重验，缺失或错层 context 均拒绝。旧 Derived manifest 没有该可选字段时仍按原内容 ID 可读。
- Cache Recovery Rehearsal v1：`rehearse-recovery` 对源 store 只读，将父/Derived/Overlay checkpoint 复制到系统临时隔离克隆；注入损坏 derived index 与三类 staging，执行 dry-run plan ID 精确 apply，要求内容删除为零；随后删除全部 clone index 并验证自动重建 ID/entries 与初建一致，最终重验 clone 和源内容。报告不含绝对路径/时间，finally 清理克隆。本证据只覆盖 reference cache 恢复，不把未来安装包/SQLite 版本回滚标为完成。
- Native ABI v1：`native/include` 冻结 demux/inspection 的窄 C11 接缝，第三方对象、路径和 allocator 不越界；固定宽度 record、`struct_size/abi_version`、取消/deadline、资源预算、borrowed ownership 和 adapter provenance 均显式。C11 smoke 用 `-Werror` 实际编译，并断言 status、BlockRecord、Sample 的 size/offset；test-only mock 进一步链接/运行 open/next/close、decode callback、backpressure、取消和 ABI mismatch 闭环，不伪造真实媒体分析结果。
- Real FFmpeg Demux Adapter v1：custom AVIO 只使用 caller `read_at`，不接收 URL/path/network；AVFormat/AVIO/AVPacket 与 allocator 全部封装在 shared adapter 内。系统 libavformat 61.7.100 上生成 3 帧 IVF/MP4/WebM，所有 stream/sample 的 DTS/PTS/duration/key flag/offset/size 与 ffprobe 逐项一致；open/next cancel、deadline、track、实际累计 probe/sample budget、malformed、EOF/close 通过。93 个确定性截断/bit flip/覆盖/噪声 case 在普通和 ASan/UBSan 构建均通过。它尚未固定依赖/许可证包或接入 Rust Worker。
- FFmpeg Supply Chain Gate v1：自动采集 runtime/compiler/configure、三库 pkg version 与 binary SHA-256；policy 要求固定源码/归档摘要、许可证清单和 SBOM，并禁止 GPL/version3/nonfree flag。当前 Debian build 因 `--enable-gpl` 及发行证据不全被明确阻断，只能用于开发验证。
- Native Demux Worker v1：56-byte request + 16-byte response header + 72-byte scalar record 的定长 IPC；父进程增量重验 status/kind/order/ID/track/flags/range/budget，超时/取消强杀，crash 稳定分类。Worker 无路径输入，限制 64 MiB media、250k records、普通构建 768 MiB address space、30 s CPU、0 core dump、16 FD；Linux x86_64/aarch64 额外启用 parent-death/non-dumpable/`no_new_privs` + seccomp 高风险 syscall denylist，并在 Stream 握手/CLI/GUI provenance 中携带实际 capability 位。父侧启动前/成功后双 SHA-256/size 检查可执行文件并在报告中保存摘要；它是 provenance/竞态检测，不冒充 path exec 的加载时完整性。真实 MP4/WebM 对 ffprobe 逐 packet 及最终 Frame/OBU parity 在普通和 ASan/UBSan Worker 下通过；limits、禁止 path/network 和父进程死亡清理均有独立行为 smoke。GUI/CLI 仅显式 flag 启用，默认 reference 可回滚；Windows Job Object/Tauri owner 未完成。
- Rust Core Source Baseline v1：edition 2024 / MSRV 1.85 workspace 已创建九个 crate；`av1-analysis` 贯通 raw/IVF，`av1-native-guard` 提供纯 safe FFI 数据边界，`av1-native-demux` 包装 demux ABI，`av1-worker-protocol` 纯 safe 解码定长 IPC 并重验 status/order/signed encoding/range/budget。普通核心 crate 禁止 unsafe；FFI 调用集中在两个审计 crate。由于本机没有 Rust 工具链，该项只记源码与静态契约完成，不记 cargo 编译通过。
- Shared Node/Rust Golden v1：OBU/IVF/Worker request/response 四份 TSV 同时由 Node test 与 Rust `include_str!` 读取，共 40 组锁定 record/range/header/layer/diagnostic/provenance/u64 timestamp/budget/deferred status，以及 IPC request bytes/framing/native status/负 timestamp/非规范 signed32/脏 reserved/sandbox capability。Node 端全部实际通过；Rust 端仍等待工具链 CI 执行，不能把源码接入表述为通过。
- GUI Keyboard and Accessibility v1：tabs、帧时间线、OBU、语法字段和诊断使用 roving focus + Arrow/Home/End；诊断采用原生 button，tabpanel/dialog/busy state 有 ARIA 关系；1023/700px 支持高缩放重排，并提供 reduced-motion/forced-colors。纯导航函数与 GUI asset contract 进入自动测试；真实浏览器、屏幕阅读器和截图仍待目标环境。
- GUI Preflight v1：`gui:check` 不监听端口，检查 Node/static assets/FFmpeg/ffprobe、Snapshot 和自动发现/显式配置的 Native Worker；required 失败退出 1、optional 缺失标记 degraded。同一 capability 报告由 health API 和顶栏消费，不可用入口被禁用。默认启用 Git-ignored Snapshot Store，内置可解码 AV1 IVF 可一键完成结构/预览/落盘 smoke。

### 实测证据

使用本机 FFmpeg 7.1.3 + libaom 生成 16×16 单帧 AV1 IVF：

- ffprobe：AV1、16×16、1 frame；
- AV1Scope：1 frame、3 OBU、0 warning、0 error；
- OBU 顺序：Temporal Delimiter → Sequence Header → Frame；
- Sequence Header：profile 0、reduced still-picture、level 0、最大尺寸 16×16；
- 所有 OBU 使用绝对文件 byte range，报告 `complete=true`。

`complete=true` 表示输入结构与 OBU 字节完整；Sequence Header 另以 `syntaxStatus=complete` 表示 payload 字段和 trailing bits 已完整消费。

另使用同一 FFmpeg 生成 64×36、3 帧的 IVF/MP4/WebM：三种容器均得到 KEY/INTER/INTER、参考关系 Frame 1→0 与 Frame 2→1/0、0 warning、0 error；MP4 sample offset 为 48/376/434，WebM Block payload offset 校正为 463/797/861。单帧亮度分析验证 16×16 = 256 个灰度样本。

Frame Header 尾部以 FFmpeg `trace_headers` 作为独立 oracle：三帧 `base_q_idx` 为 87/127/128，P 帧 loop filter 为 `[4,4,6,0]` 和 `[8,8,10,0]`，原生 parser 的值与绝对 bit range 回归断言通过。同一码流的 IVF→MP4 三帧比较为 3/3 像素一致（MAE 0、SSIM 1）；16×16 黑白极端样本得到 MAE 255、PSNR 0 dB、SSIM 0.00009999。

Node 20.19.2 / Linux x64 性能门禁连续两轮通过（每个计时样本前主动 GC，GC 时间不计入，用于隔离单次操作成本）：10,000 OBU、260,000 bytes 的索引 P95 6.67/5.64 ms；100,000 条 BlockRecord 完整契约验证 P95 54.86/50.40 ms；WebGL 实例 buffer 构建 P95 7.10/3.69 ms。门禁预算分别为 80/150/30 ms。普通 `npm run benchmark` 仍使用 natural-heap 口径；实例 buffer 数据不等同于浏览器绘制 FPS。

独立 snapshot 磁盘基准（`/tmp`、10,000 OBU、10 个 chunk）：落盘 4,604,761 bytes，单遍 writer 原子提交 141.40 ms，末页 1,000 条读取 3.46 ms，完整报告重建与全量校验 112.25 ms。1 GiB 稀疏 raw OBU 为 19.09 ms / 0.09 MiB heap，1 GiB IVF 双遍为 6.56 ms / 0.02 MiB heap；100k 高密度 OBU 为 1.20 s / 0.12 MiB heap、100 chunks。该基准记录本机 `/tmp` 与 GC 后 heap delta，不作为跨机器 CI 硬门禁。

下面的测试计数与六类 Golden 描述是当时的 M0 采样快照；当前权威证据见 `docs/CURRENT_DEVELOPMENT_STATUS.md`（47/47、109 个 JavaScript 文件、九类真实 Golden、供应链与 crash replay 已通过）。

当前全量测试 45/45 通过，102 个 JavaScript 文件通过语法检查，C ABI v1 由本机 `cc` 以 C11 严格告警编译并运行 runtime smoke，真实 FFmpeg adapter 和独立 Worker 普通与 ASan/UBSan 差分通过，Rust source baseline 静态契约检查通过；覆盖率重采样为 90.73% lines、81.89% branches、92.80% functions，Native Demux Worker 父侧为 88.37% lines/88.19% branches。流式索引与 eager path 对 raw/IVF/MP4/WebM 的 Frame/OBU range 做逐记录 parity，Matroska none/Xiph/fixed/EBML lacing 均覆盖。新增 libaom `aq-mode=1`、loop restoration 与平移 ROTZOOM 固定语料，分别与 FFmpeg `trace_headers` 的 `su(9)`、restoration type/unit shift、global-motion subexp code 和 bit offset 核对；另有双 operating point 完整合成位流、extension header 截断/保留位、show-existing 非法引用与 Frame ID、三种 Matroska lacing、reference-order-hint invalidation、重复 Sequence Header 状态、共享 OBU/IVF/Worker Golden、GUI 键盘导航、Tile Group range/size/alignment/OBU_FRAME/独立 Derived context、batch 并发确定性/预算/逐文件 Snapshot，以及隔离 cache 损坏/精确 GC/全索引丢失重建回归。Native Demux Worker 父侧已改为逐 chunk 增量协议解码，所有 1-byte 至整包以上边界、提前 EOF 与终止后附加数据均回归；2,000 例 IPC 变异 smoke、sandbox/limits/parent-death 行为和 executable digest 变化也均回归。Native Inspection Worker 已验证有状态多帧 session、BlockRecord flags/qindex 无损语义、任意响应 chunk 边界、进程隔离、executable digest 与 GUI 自动接入；mock 只验证链路。instrumented libaom 的私有逐块事件 ABI、公共 adapter bridge、固定 build manifest 和六类 Block Golden release gate 已实现，test stub 覆盖 event 校验/chunk/backpressure/cancel/IPC，但不冒充真实解码数据。Block Overlay Snapshot 已覆盖 parent binding、原子/幂等 chunk 写入、分页、损坏检测、GC 引用和隔离恢复；Snapshot Frame 可按源指纹绑定、最近随机访问帧和 Sequence Header 前缀构建有界解码窗口，并按原 frameId 回写分页结果。真实单帧 FFmpeg Header Trace 中 22 个唯一可比字段全部一致，0 mismatch；数组索引、Segmentation 矩阵与 Global Motion coded value 使用显式映射，歧义叶名不参与比较。

Overlay 独立观测基准（`/tmp`、50 个 Derived、每个 200 字段、合计 10,000 字段、10 chunks）：首次流式创建 501.37 ms / 18,496,000 bytes 采样 peak heap delta；幂等复用逐记录验证 1,016.71 ms / 23,678,704 bytes。两条路径均返回 `manifest=null`，证明 GUI/API 未构造完整 overlay 文档。该 1 ms heap sampler 受 V8 自然 GC 时机影响，只作为趋势观测，不是跨机器硬门禁。

GUI 静态资源、键盘索引函数、ARIA/responsive contract、API、FFmpeg 预览/统计测试均通过；本轮按浏览器插件流程确认可用浏览器列表为空，且沙箱监听 `127.0.0.1:4173` 返回 EPERM，因此没有把真实焦点行为、读屏、视觉回归和 WebGL 绘制 FPS 标记为通过。

高密度 Padding OBU 规模探针：未限额时 1 MiB/40,329 OBU 用时 37.89 ms、heap 增量 25.35 MiB；10 MiB/403,298 OBU 用时 219.42 ms、heap 增量 187.13 MiB，更高档被执行环境中断。加入预算后，20 MiB/806,596 OBU 输入在 100k 上限下发布 100k 条、41.21 ms、heap 增量 49.53 MiB；250k 上限下发布 250k 条、119.15 ms、heap 增量 122.72 MiB。该结果证明 eager JSON model 的成本主要随记录数增长；`index` 已以分块 snapshot 消除该大文件内存增长，单 OBU 深层语法和多 OBU 流式 overlay 均可独立持久化。

### 环境决策

当前工作区没有 `rustc`/`cargo`，但已有 FFmpeg development package 和固定 libaom v3.12.1 inspection 构建。Rust 2024 workspace 仍只能标记为 source baseline；inspection 的真实 producer/Worker/IPC/GUI consumer 已完成，不改变系统设计中的 Rust + Tauri 最终架构。

### 下一切片

1. Rust 工具链可用后执行 fmt/clippy/test，让 `av1-structural` 实际跑通当前共享 Golden，再扩展到容器 sample table 差分；
2. 固定 FFmpeg 源码/config/license/SBOM，实际编译 Rust demux handle/Worker protocol 并接入 Tauri owner；
3. libaom inspection 构建可用后实现 Block Overlay producer 与 Block Golden；
4. 在可启动浏览器会话的环境完成 GUI 视觉回归和真实 WebGL 绘制 benchmark；
5. 启动 Tauri/SQLite 生产壳、安装包和版本迁移/回滚验收；
6. 明确保留期限和用户确认 UX 后，再扩展内容 Snapshot 回收；当前 `gc-cache` 有意只回收可重建缓存。
