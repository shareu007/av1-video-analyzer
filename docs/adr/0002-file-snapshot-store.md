# ADR-0002：Reference path 使用内容寻址的文件型 Snapshot Store

- 状态：Accepted
- 日期：2026-08-13
- 决策范围：Node reference CLI、后续 GUI 分页契约

## 背景

系统 workflow 要求导出从固定 `snapshot_id` 读取一致结果，并让记录集合可分块/分页。现有 CLI/GUI 只持有单个 eager `AnalysisReport`，无法为分页、缓存验证或未来 Rust/SQLite 差分提供稳定持久化语义。当前项目无第三方数据库依赖，Node reference path 仍需保持零依赖。

## 决策

引入 `Snapshot Store v1` 文件格式。snapshot ID 是规范化完整 `AnalysisReport` 紧凑 JSON（含结尾换行）的 SHA-256。`frames`、`obus`、`syntaxNodes`、`diagnostics` 四类集合独立按固定记录数切为 JSON chunk；manifest 保存非集合 header、每个 chunk 的连续 start/count、文件名和 SHA-256。

写入先在同一根目录创建唯一临时目录，写完所有 chunk 和 manifest 后以目录 rename 原子发布。Manifest 的 header 与 collection topology 另有 payload SHA-256，使分页读取无需重建全量报告即可验证元数据。相同内容幂等复用已有 snapshot，但复用前完整读取并校验 chunk 与最终 report digest。未知 schema、非连续 chunk、计数不一致、非法文件名、manifest/chunk 哈希错误或完整 report digest 错误均拒绝。

CLI `analyze --snapshot-dir PATH` 提交快照，原有 JSON stdout/`--output` 行为不变；snapshot ID、created/reused 和目录写入 stderr。

## 后果

优点：snapshot 不可变且内容寻址；分页只解析相关 chunk；导出可以绑定固定 ID；格式可由 Rust/SQLite importer 无歧义迁移；损坏不会静默返回。

代价：JSON chunk 未压缩；文件型 store 不提供多进程事务或数据库查询。普通 `analyze --snapshot-dir` 仍从完整 report 提交；大文件 `index` 采用流式 writer，但首遍只冻结 Frame/OBU ranges。流式 snapshot 通过不含路径的首尾采样指纹重新绑定源文件，并可按 OBU range 检查深层语法；结果按 `Derived Syntax Snapshot v1` 独立内容寻址，不写回不可变父 snapshot。多个派生结果以多遍流式 merge 合并为唯一版本/OBU 的 `Syntax Overlay Snapshot v1`，统一节点 ID 并保留来源；Overlay 集合分块，HTTP 和幂等复用校验只持有当前 chunk。Derived parent/OBU 索引是按 store revision 自动重建的持久缓存；`gc-cache` 默认 dry-run，显式执行也只删除旧/损坏索引和过期事务，不删除内容 Snapshot。服务端冻结实际收到的 payload 摘要，但不能独立认证浏览器本地整个文件。

## 验证

- 多 chunk 原子提交、跨页读取、完整重建、相同内容幂等复用；
- chunk 内容篡改和 manifest offset 篡改均拒绝；
- CLI 端到端创建 manifest 并保持 stdout 为合法 AnalysisReport；
- 10,000 OBU 本机 `/tmp` 基准：4,604,761 bytes、写入 141.40 ms、1,000 条末页读取 3.46 ms、全量重建 112.25 ms；
- 单遍 writer 与完整 report 产生相同 snapshot ID；raw/IVF/MP4/WebM 流式索引与 eager path 的索引层记录逐项对照；
- 源文件大小/首尾指纹校验、按需 Sequence/Metadata 解析、绝对 bit range 和 HTTP payload 范围拒绝；
- 单 OBU 派生结果的内容寻址、原子发布、幂等复用、父绑定/内容篡改拒绝、GUI/API 重放和 CLI 导出；
- 多 OBU overlay 输入顺序归一化、全局 node ID、重复 OBU 冲突、内容篡改拒绝、API 分页、GUI/CLI 创建与重放；
- Overlay 新建与复用的逐 chunk/逐记录验证，以及引用统计、GC dry-run、显式 apply、候选身份核对与内容保留；
- `npm run ci` 27/27 套件通过，CPU 性能门禁连续 2/2 轮通过。
