# Syntax Overlay Snapshot v1 契约

## 目的

一个流式父 Snapshot 可以拥有多个单 OBU `Derived Syntax Snapshot v1`。Overlay 将用户明确选择的派生结果合并为统一 SyntaxNode/Diagnostic 视图，解决不同 OBU 内局部 `nodeId` 冲突，并冻结选择集合、解析器 provenance 和完整性状态。

## 目录与内容 ID

```text
<snapshot-root>/syntax-overlays/<overlay_snapshot_id>/manifest.json
<snapshot-root>/syntax-overlays/<overlay_snapshot_id>/syntaxNodes-000000.json
<snapshot-root>/syntax-overlays/<overlay_snapshot_id>/diagnostics-000000.json
```

`overlay_snapshot_id` 是以下语义内容载荷的规范化 JSON SHA-256：schema/kind、父 ID、按 OBU 排序的派生 ID、合并后的 SyntaxNode/Diagnostic、summary 和 provenance。输入派生 ID 的调用顺序和物理 chunk size 不影响结果 ID。字段与诊断默认每 1,000 条写一个规范化 JSON chunk，manifest 保存连续 start/count、文件名和 chunk SHA-256；manifest topology 另有 `payloadSha256`。全部文件先写 staging 目录，再以 rename 原子发布；相同内容幂等复用。创建过程先计算 contributor/计数元数据，再分别以 async iterator 流过字段和诊断；内存只保留当前 Derived manifest 与一个 chunk，语义 ID 从 header 和已落盘 chunk 增量计算。

## 合并规则

- 所有派生结果必须存在、完整验证且属于同一个父 Snapshot；
- 同一 overlay 中每个 OBU 只能选择一个派生结果，冲突必须拒绝，不能隐式选择“最新”；
- 派生结果按 `obuId`、`derivedSnapshotId` 排序；
- 合并后的 `nodeId` 从 0 连续重新分配；原局部 ID 保存在 `sourceNodeId`，来源保存在 `derivedSnapshotId`；
- Diagnostic 保留原字段并增加 `derivedSnapshotId`；
- 全部派生 inspection 为 `complete` 且不存在 error/fatal 时，overlay `summary.complete=true`；
- 单次最多 10,000 个派生结果、500,000 个 SyntaxNode、100,000 个 Diagnostic，超预算拒绝且不发布半成品。

## 读取与完整性

- Manifest 必须声明 `storageLayout=chunked-v1`、正整数 chunk size，以及从 0 连续覆盖集合的 descriptor；
- 分页只打开与 `[offset, offset+limit)` 相交的 chunk，并在解析前校验文件 SHA-256，limit 为 1–10,000；
- 完整重放读取全部 chunk，重算语义 overlay ID，再从每个 Derived Syntax Snapshot 重建并逐字节比较规范化语义文档；
- GUI/API 创建或幂等复用不构造完整 overlay：复用校验逐 chunk 与重新生成的记录流一一比较；只有显式完整导出才聚合集合；
- Reader 兼容最初的 inline v1 manifest，但新 writer 只发布 chunked-v1；legacy ID 可读不可原地改写。

## API

- `GET /api/snapshots/:parent/derived-syntax?offset=&limit=`：按 OBU/ID 分页查询可选派生结果；
- `POST /api/snapshots/:parent/syntax-overlays`：提交 `{ "derivedSnapshotIds": [...] }` 创建或复用 overlay；
- `GET /api/syntax-overlays/:id/manifest`：返回不含大集合的 header、summary、provenance 和 collection count；
- `GET /api/syntax-overlays/:id/syntaxNodes?offset=&limit=`：分页读取统一字段；
- `GET /api/syntax-overlays/:id/diagnostics?offset=&limit=`：分页读取诊断；
- `GET /api/syntax-overlays/:id`：验证后导出完整 overlay。

GUI 默认只在每个 OBU 的多个版本中选择一个，用户可显式切换。检查器每页只渲染 200 条记录，不把最多 500,000 个字段同时插入 DOM。

## CLI

```bash
av1scope merge-derived PARENT_ID DERIVED_ID... --snapshot-dir ./snapshots --output overlay.json
av1scope replay-overlay OVERLAY_ID --snapshot-dir ./snapshots --output overlay.json
```

`merge-derived` 的输出是已发布 manifest；`replay-overlay` 重新验证父/派生绑定和 overlay 内容后输出规范化 JSON。

## 当前限制

集合写入、分页和复用校验均为有界内存；显式 `merge-derived --output`/`replay-overlay` 为输出完整 JSON，按命令语义仍会聚合最多 500,000 个字段。生产 Rust/SQLite session-store 仍需提供跨进程 writer lock、压缩和数据库级查询，同时保持本契约的语义内容 ID、流式顺序和冲突规则。
