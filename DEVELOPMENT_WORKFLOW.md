# AV1Scope 开发 Workflow

> 文档状态：Proposed
> 适用范围：AV1Scope Core、Parser、Runtime、UI、QA、Release
> 基线设计：`AV1Scope_System_Design.docx`
> 最后更新：2026-08-12

## 1. 目的

本 workflow 将系统设计中的 M0–M4 路线转换为可执行的研发流程。它用于统一需求进入、技术验证、契约设计、实现、评审、测试、发布和复盘方式，并确保每项功能都满足以下底线：

- **可追溯**：字段、事件、诊断和可视化结果能够回到输入文件的字节/位范围与具体解析规则。
- **分层可信**：结构解析、像素解码和深度块分析分别标明来源，不以推导结果替代原始码流事实。
- **故障隔离**：不可信输入只影响受限 Worker；主 UI 不因解析器或解码器异常崩溃。
- **按需计算**：先索引、后解析，先当前视窗、后后台补全；长任务可取消并受资源预算约束。
- **契约稳定**：UI、CLI、导出和插件只依赖版本化事件模型，不依赖 FFmpeg/libaom 内部对象。
- **可重复验证**：同一输入与工具版本产生确定性的记录顺序、摘要和回归结果。

## 2. 总体开发闭环

```text
需求/缺陷进入
    ↓
分诊与风险分级
    ↓
Ready Gate（范围、契约、样本、验收标准齐备）
    ↓
纵向切片实现（Core → Worker/IPC → Store → UI/CLI）
    ↓
本地验证（单测、Golden、差分、性能与安全）
    ↓
代码评审与契约评审
    ↓
CI Gate（跨平台构建、回归、Fuzz smoke、SBOM）
    ↓
Nightly / Beta 验证
    ↓
Release Gate 与签名发布
    ↓
监测、反馈与复盘 → 回到需求池
```

开发采用“**小步纵向切片 + Feature Flag + 可度量退出条件**”。一个切片应尽可能从真实输入贯通到用户可见结果，而不是长期分别堆积 Parser、Worker 或 UI 的孤立模块。

## 3. 工作项类型与状态

### 3.1 工作项类型

- **Probe**：验证高风险技术假设；必须有结论、数据和去留建议，不以产品化代码为目标。
- **Feature**：用户可感知能力；必须包含端到端验收场景。
- **Core/Contract**：事件模型、存储 schema、IPC、公共 API 或插件接口变更。
- **Bug**：已实现行为与规范、契约或验收标准不一致。
- **Performance**：有基线、目标设备、样本和统计口径的性能工作。
- **Security/Dependency**：不可信输入边界、沙箱、FFI、FFmpeg/libaom 或供应链更新。
- **Documentation**：架构决策、字段映射、测试向量、操作手册或发布说明。

### 3.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
|---|---|---|---|
| Proposed | 已记录，尚未承诺 | 有问题描述与来源 | 完成分诊，决定拒绝、暂缓或进入设计 |
| Designing | 正在收敛方案 | 指定 Owner 和目标里程碑 | 通过 Ready Gate |
| Ready | 可被开发领取 | 范围、契约影响、样本、验收与风险齐备 | Owner 开始实施 |
| In Progress | 正在实现 | 分支/PR 已关联工作项 | 自测完成并提交评审 |
| In Review | 代码与行为评审 | PR 描述和证据完整 | 评审通过或退回修改 |
| Validating | 已合入，进行集成验证 | 主干 CI 通过 | Nightly/Beta 验收通过 |
| Done | 已满足完成定义 | 文档、测试、遥测/日志与发布说明已闭环 | 无 |
| Blocked | 有明确外部阻塞 | 记录阻塞原因、Owner、解除条件 | 阻塞解除后回到原状态 |

禁止将“代码已写完”直接视为 Done。未补齐样本、回归测试、契约版本和诊断信息的功能仍处于 In Review 或 Validating。

## 4. Ready Gate：开始编码前必须具备

每个工作项至少包含一张简短的实现卡：

1. **用户问题**：谁在什么场景下需要解决什么问题。
2. **范围与非范围**：本次明确做什么、暂不做什么。
3. **用户路径**：从打开样本到得到结论的最短操作路径。
4. **数据来源**：Structural Parser、FFmpeg、libaom、推导指标或插件，并说明 provenance。
5. **契约影响**：涉及的 `ParseEvent`、`SyntaxNode`、`Diagnostic`、`FrameRecord`、`BlockRecord`、IPC 或缓存 schema。
6. **测试样本**：最小合法样本、边界样本、损坏样本和至少一个真实故障样本；样本须可合法纳入测试集。
7. **验收标准**：正确性、性能、取消/恢复、错误展示和平台范围，均使用可测量描述。
8. **风险与降级**：失败时关闭哪个 Feature Flag，用户还能使用哪些结构分析能力。
9. **Owner/Reviewer**：至少明确主责人与对应领域 Reviewer。

下列变更必须在编码前先形成 ADR 或 RFC：

- 修改跨组件数据契约、缓存键或记录 ID 稳定性；
- 新增/变更进程边界、IPC 所有权、共享内存布局或沙箱权限；
- 引入新的 C/C++ FFI、容器库、解码器 fork 或 GPU 渲染路径；
- 更改输入支持范围、许可证策略、遥测/联网行为或插件权限；
- 会使现有缓存、导出或插件不兼容的主版本变化。

## 5. 单个 Feature 的标准实现流程

### Step 1 — 建立可复现样本和期望结果

- 将输入归类为 conformance、synthetic、regression、fuzz-crash 或 customer-private。
- 公共/可再分发样本进入测试资产清单；私有样本只保存脱敏元数据、哈希和最小化复现，不提交仓库。
- 为结构字段记录规范路径、期望值、presence condition 和 bit range；为像素结果记录固定 decoder build 下的 hash。
- Bug 必须先增加失败测试或最小复现，再修改实现。

### Step 2 — 契约先行

- 先更新事件/记录定义、版本策略和向后兼容行为，再写生产逻辑。
- 新增字段优先使用可选字段；未知主版本必须拒绝，未知可选字段必须可忽略。
- 每个推导指标携带算法名和版本；每个深度分析记录携带 decoder/adapter provenance。
- 定义 source range、record ID、事件顺序、错误码、取消语义和 payload 上限。

### Step 3 — 实现最小纵向切片

按以下顺序贯通一条真实路径：

1. Input/Demux 输出稳定 sample span；
2. Structural Parser 产生字段与诊断；
3. Normalizer 排序、校验并版本化事件；
4. Session Store 事务提交索引与 chunk；
5. Worker/IPC 按需返回像素或块记录；
6. UI/CLI 展示结果、来源、错误与取消状态；
7. 导出从固定 `snapshot_id` 读取一致结果。

不要求每项功能都触达全部七层；但任何跨层字段都必须完成生产者、消费者和持久化兼容验证。

### Step 4 — 内建诊断、取消和预算

- 所有长任务接受 `cancellation_token` 与 `deadline`。
- 队列按估算字节计费，明确单消息、单帧、单会话和 Worker 的内存上限。
- 非法 offset/length、LEB128、tile 尺寸和数组索引使用 checked arithmetic。
- Worker 超时或崩溃返回结构化诊断；结构解析结果继续可用。
- 日志不得记录码流 payload；绝对路径默认哈希或截断。

### Step 5 — 本地验证

开发者在提交评审前至少完成：

- 受影响模块的格式化、静态检查和单元测试；
- 新增/更新 Golden 快照，并人工检查差异不是误接受；
- 与固定版本 libaom/FFmpeg 的差分检查（适用时）；
- 损坏样本、取消、Worker 重启和缓存失效路径；
- 性能敏感变更的同设备前后对比；
- UI 变更的关键截图或短录屏，以及键盘/高 DPI/缩放基本检查。

### Step 6 — 评审与合入

PR 保持单一目标，描述中必须包含：工作项链接、设计/ADR、用户路径、契约变化、测试证据、性能数据、风险、回滚方式和 UI 证据（适用时）。

评审至少覆盖：

- **领域正确性**：AV1 规范解释、presence condition、参考关系与 bit range；
- **系统边界**：FFI/IPC 所有权、背压、取消、事务和版本兼容；
- **用户体验**：时间线、字段树、叠加层、错误与来源是否可理解；
- **质量门禁**：样本覆盖、Golden/差分、性能、安全和可诊断性。

契约、解析器、FFI/沙箱和缓存 schema 变更要求对应领域 Reviewer 批准。合入采用 squash 或保持语义清晰的少量提交；禁止直接向受保护主干推送。

### Step 7 — 验证、启用和关闭

- 新的高风险能力默认置于 Feature Flag 后，先进入 internal nightly。
- Nightly 通过后向 3–5 名目标用户提供 beta，记录定位耗时、外部脚本数量、崩溃与误判。
- 指标与反馈达到工作项验收标准后再默认启用。
- 若出现回归，优先关闭对应 Feature Flag 或回退适配器；缓存版本不兼容时使用重建工具，不静默读取旧数据。

## 6. 分支、提交与 PR 约定

### 6.1 分支

- 主干：`main`，始终保持可构建、可运行、可发布 nightly。
- 短分支：`probe/<id>-<topic>`、`feat/<id>-<topic>`、`fix/<id>-<topic>`、`perf/<id>-<topic>`、`docs/<id>-<topic>`。
- 分支应在数天内合入；大功能使用 Feature Flag 和多个纵向切片，避免长期分叉。

### 6.2 提交

建议使用 Conventional Commits：

```text
feat(parser): expose frame header bit ranges
fix(worker): bound block-record payload size
perf(renderer): batch partition overlay instances
test(demux): add truncated MP4 sample table regression
docs(adr): pin libaom instrumentation baseline
```

生成文件、第三方二进制和测试样本不得混入普通源码提交；必须在 PR 中说明来源、许可证、生成命令和体积变化。

### 6.3 PR 尺寸与合入策略

- 优先小于约 500 行人工评审代码；机械生成、Golden 和依赖锁文件单独统计。
- 超大 PR 在提交前拆分为契约、核心实现、适配层、UI 和测试等可独立验证切片。
- 主干 CI 全绿、必需 Reviewer 批准、无未解决 P0/P1 反馈后方可合入。

## 7. CI/CD Pipeline

CI 按“快速反馈 → 深度正确性 → 安全与交付”分层执行。

| 层级 | 触发 | 必跑内容 | 失败处理 |
|---|---|---|---|
| PR Fast | 每次推送 | format、lint、单测、schema/ABI 检查、Linux smoke build、UI typecheck | 阻止合入 |
| PR Domain | 相关路径变化 | AV1 Golden、差分测试、UI E2E、缓存 migration、IPC compatibility | 阻止合入 |
| Main | 合入主干 | Windows/Linux 构建、集成测试、fuzz smoke、基准 smoke、安装包 smoke | 标记主干红并优先修复 |
| Nightly | 每晚 | 全量 Golden、长 fuzz、样本语料回归、性能趋势、依赖漏洞与许可证扫描 | 禁止提升到 beta |
| Release Candidate | 候选版本 | 24h 压力、8h fuzz、跨平台安装/升级/卸载、缓存重建、SBOM、签名验证 | 阻止发布 |

性能结果记录机器型号、OS、构建类型、样本哈希、冷/热缓存、重复次数和 P50/P95。仅报告单次最快结果无效。

## 8. 测试资产与验证矩阵

### 8.1 测试层次

- **Unit**：位读取、LEB128、range arithmetic、OBU/头字段、排序、缓存键和查询表达式。
- **Golden**：`SyntaxNode`、`FrameRecord`、`Diagnostic` 和 BlockRecord 摘要的规范化快照。
- **Differential**：与固定版本 libaom/FFmpeg 的可观测字段、帧像素 hash 对照。
- **Property**：range 不越界、父子范围包含、事件游标单调、排序稳定、缓存失效安全。
- **Fuzz**：容器 sample table、OBU length/header、frame header、tile group、IPC decoder。
- **Performance**：1080p/4K/8K、1 GB 文件、百万帧、极多小 OBU、10 万 overlay primitive。
- **UI E2E**：打开、跳转、缩放、图层、双视图、查询、取消、导出和崩溃恢复。

### 8.2 样本治理

测试资产清单至少记录：sample ID、来源/许可证、SHA-256、容器、编码特性、预期用途、最小工具版本和公开性。Fuzz crash 样本先最小化再入库；任何真实客户样本默认视为私有，不进入 CI 或诊断包。

Golden 更新必须由领域 Reviewer 检查语义差异。批量“接受所有新快照”不得作为解析器改动的验证方式。

## 9. 依赖与分析解码器更新流程

FFmpeg、libaom fork、Tauri、WebGL 相关库或 Rust/Node 核心依赖更新单独开 PR：

1. 记录旧/新版本、上游提交、CVE/功能动机和许可证变化；
2. 对 libaom fork 列出插桩补丁清单，执行可重复 rebase 并生成 adapter ABI 报告；
3. 运行全量 Golden、像素 hash、BlockRecord 差分和性能基准；
4. 生成 SBOM 与许可证清单，检查构建选项；
5. 通过 canary/nightly 后再进入 beta；
6. 保留上一固定版本与关闭 deep-analysis 的 Feature Flag。

任何依赖更新不得在同一 PR 中夹带无关业务重构。

## 10. 缺陷与安全事件 Workflow

### 10.1 缺陷优先级

- **P0**：主进程崩溃、越界读写、数据泄露、输入文件被修改、错误结果无 provenance 且可能导致严重误判；立即停止发布。
- **P1**：常见合法码流解析错误、结果不可重建、缓存损坏不可恢复、核心路径严重性能回退；当前里程碑必须清零。
- **P2**：有绕过方式的功能错误或明显 UX 问题；进入最近迭代。
- **P3**：低影响改进、少见边缘表现或文档问题；按价值排序。

### 10.2 处理步骤

1. 保存版本、平台、输入指纹、日志和最小复现；不复制私有 payload。
2. 判断故障域：Demux、Parser、Decoder Worker、Normalizer、Store、Renderer、UI 或 Plugin。
3. 先隔离影响：关闭 Feature Flag、禁用问题 adapter/plugin 或回退版本。
4. 增加回归测试，再修复根因；检查相同模式是否存在于其他边界。
5. 发布修复并验证缓存/会话兼容；必要时提供重建工具。
6. P0/P1 在关闭前完成简短复盘：触发条件、检测缺口、永久措施和 Owner。

安全问题使用私密渠道分诊，公开修复信息避免在补丁可用前披露可利用细节。

## 11. 里程碑执行与退出门禁

### M0 — 技术探针（2–3 周）

并行验证三条最高风险链路：IVF/MP4 样本索引与 bit offset、libaom 块级事件覆盖、10 万级 WebGL overlay。

**退出条件**：每条探针都有可重复 demo、基准数据、已知缺口和 Go/Adjust/Stop 结论；确定首发平台与 M1 范围。探针代码只有满足生产质量门禁后才能直接进入主路径。

### M1 — 可用的结构与帧头分析器（6–8 周）

交付桌面壳、文件打开、时间线、OBU/Sequence Header/Frame Header 树、诊断和 JSON 导出。

**退出条件**：一致性向量通过；1 GB 文件首屏索引 P95 < 2 s；损坏输入不崩主进程；字段可定位到 source range；导出可确定性重放。

### M2 — 像素与块级深度分析（8–10 周）

交付按需解码、超级块/分区/模式/MV/QP/滤波叠加、块检查器和缓存。

**退出条件**：10 万 overlay primitive 交互 P95 ≥ 45 FPS；Block Golden 与固定 libaom build 一致；当前帧任务可取消；Worker 崩溃可恢复；4K 深度分析内存目标 < 1.5 GB。

### M3 — 对比、指标与批处理（6–8 周）

交付比较视图、质量指标、查询、CSV/图片/报告导出和 CLI。

**退出条件**：目标用户完成两周 beta；P0/P1 清零；导出基于稳定 snapshot；缓存重建与版本回滚演练通过；指标算法和版本可追溯。

### M4 — 扩展生态与正式交付

交付插件 SDK、更多封装/实时输入、签名安装包和可选更新机制。

**退出条件**：插件权限与隔离模型通过安全评审；Windows/Linux 安装、升级、卸载验收；SBOM、许可证和签名流程完整；上一稳定版本可回滚。

## 12. 团队职责与评审责任

| 角色 | 主责 | 必须参与的评审 |
|---|---|---|
| Product/Tech Lead | 范围、里程碑、优先级、跨域决策 | Ready Gate、里程碑退出、P0/P1 复盘 |
| Parser Owner | AV1 规范字段、bit range、诊断、Golden | Parser/Normalizer/结构导出 |
| Runtime Owner | Demux、Worker、FFI、IPC、调度、沙箱 | FFmpeg/libaom、资源预算、崩溃恢复 |
| Storage/API Owner | schema、record ID、缓存、查询、迁移 | 契约版本、持久化和导出一致性 |
| UI/Renderer Owner | 桌面体验、WebGL/Canvas、可访问性 | 交互、渲染性能和降级路径 |
| QA/Release Owner | 语料、CI、性能实验、安装包、发布 | 验收证据、RC Gate、回滚演练 |
| Security/Legal Reviewer | 威胁边界、依赖、许可证、隐私 | FFI/沙箱/联网/插件/商业发行 |

小团队允许一人兼任多个角色，但高风险变更不得由作者单人完成设计、实现和最终批准。

## 13. 推荐迭代节奏

- **每日**：主干健康检查；P0/P1 与阻塞项优先；长任务/性能数据自动归档。
- **每周**：一次技术分诊与一次可运行 demo；检查指标趋势、Golden 变化和风险清单。
- **每两周**：形成一个可安装 nightly/beta 增量，邀请真实目标用户完成任务而非仅观看演示。
- **每里程碑**：对照退出门禁完成 Go/Adjust/Stop 评审，更新系统设计、ADR、风险与后续范围。
- **每次发布**：完成 RC 清单、缓存重建、回滚演练、SBOM/许可证、签名和 release notes。

## 14. Definition of Done

一个工作项只有同时满足以下条件才能标记 Done：

- 验收场景在声明的平台和样本上通过；
- 新行为有自动化测试，Bug 有回归测试，Golden 变化经人工确认；
- 所有字段和指标具有正确的 source range 或 provenance；
- 长任务可取消，异常有结构化诊断，Worker 故障不带走主进程；
- 契约/schema/缓存/插件兼容性已处理并记录版本；
- 性能和内存未超过预算，或已有明确、获批的降级策略；
- CI 全绿，必需 Reviewer 已批准，文档和 release notes 已更新；
- Feature Flag、启用策略、监测信号和回滚方式明确；
- 不包含无授权样本、敏感路径/payload、未知许可证资产或未审查的联网行为。

## 15. 首个迭代建议（落地本 workflow）

1. 建立 Rust workspace：`av1-bits`、`av1-model`、`demux-ffmpeg`、`session-store`、`analysis-worker`、`desktop-app`、`cli`。
2. 冻结 `ParseEvent`、`SyntaxNode`、`Diagnostic`、`FrameRecord v1` 的最小契约，并编写版本兼容测试。
3. 以 IVF + 裸 OBU 完成第一个端到端纵向切片：打开文件 → 建索引 → 展示 OBU/Frame Header → JSON 导出。
4. 建立最小测试资产清单，接入格式化、静态检查、单测、Golden、fuzz smoke、Linux/Windows 构建和 SBOM。
5. 并行完成 MP4 bit offset、libaom instrumentation 和 WebGL overlay 三个 M0 Probe，以测量结果收敛 M1/M2 范围。
6. 邀请 3–5 名编码工程师准备真实任务和可脱敏复现，建立 beta 成功指标基线。

---

本 workflow 与系统设计共同维护：系统边界或里程碑变化时更新设计文档；工程状态、门禁或协作约定变化时更新本文件。所有例外应在工作项或 ADR 中记录原因、有效期和清理 Owner。
