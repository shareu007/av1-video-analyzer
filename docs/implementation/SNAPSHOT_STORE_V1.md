# Snapshot Store v1 契约

## 目录布局

```text
<root>/<snapshot_id>/
  manifest.json
  frames-000000.json
  obus-000000.json
  syntaxNodes-000000.json
  diagnostics-000000.json
  ...
```

`snapshot_id` 是 64 字符小写 SHA-256。空集合没有 chunk 文件，其 manifest count 为 0、chunks 为空。

## Snapshot ID

输入是 `AnalysisReport` 经过递归对象键排序、紧凑 JSON 编码并追加单个 `\n` 后的 UTF-8 bytes。摘要算法固定为 SHA-256。数组顺序属于契约，不能重排。

## Manifest

```json
{
  "schemaVersion": 1,
  "snapshotId": "<sha256>",
  "payloadSha256": "<sha256>",
  "reportSchemaVersion": 1,
  "chunkSize": 1000,
  "header": {
    "schemaVersion": 1,
    "source": {},
    "container": {},
    "summary": {},
    "provenance": {}
  },
  "collections": {
    "frames": { "count": 0, "chunks": [] },
    "obus": {
      "count": 1,
      "chunks": [
        { "file": "obus-000000.json", "start": 0, "count": 1, "sha256": "<sha256>" }
      ]
    },
    "syntaxNodes": { "count": 0, "chunks": [] },
    "diagnostics": { "count": 0, "chunks": [] }
  }
}
```

Chunk descriptor 必须从 0 开始连续覆盖整个集合；count 为正安全整数，文件名不得包含路径分隔符。每个 chunk 是对应记录数组的规范化紧凑 JSON 加 `\n`，`sha256` 对其完整 UTF-8 bytes 计算。

`payloadSha256` 对 `{ reportSchemaVersion, chunkSize, header, collections }` 组成的规范化紧凑 JSON（含 `\n`）计算，用于在分页读取前验证 manifest header 与 chunk topology 未被修改。

## 读取语义

- 未知 `schemaVersion` 必须拒绝；
- manifest payload SHA-256 不匹配必须拒绝；
- 分页参数 offset 为非负安全整数，limit 为 1–10,000；
- 每次读取相关 chunk 前校验 SHA-256 和数组记录数；
- 完整重建后重新计算 report snapshot ID；不匹配必须拒绝；
- 可忽略 manifest 中未来新增的可选字段，但不得猜测未知 collection 或主版本。

## 提交语义

Writer 在 `<root>` 下写唯一隐藏临时目录，chunk 完成后写 manifest，最后以同文件系统目录 rename 发布。Reader 只读取 64 字符 snapshot 目录，因此看不到半提交状态。同 ID 已存在时必须先完整验证再复用，不允许覆盖不可变 snapshot。

## 源文件绑定与按需检查

流式 `index` 的 `header.source` 记录 `size` 和 `sha256-first-last-64k-v1` 指纹：SHA-256 输入依次为 `av1scope-source-v1\0<size>\0`、文件开头最多 64 KiB、文件结尾不与开头重叠的最多 64 KiB。绝对路径不进入 snapshot。

GUI 只能在用户明确选择文件、大小和指纹均匹配后读取 indexed payload range。`POST /api/snapshots/:id/inspect/:obuId` 接受规范 padded Base64，单个目标 payload 和 Sequence/Frame Header context 各不得超过 256 KiB；服务端重新从已校验 snapshot 读取记录并核对 OBU ID、类型、顺序、layer 和 payload 长度。Sequence/Metadata/Tile Group 要求完整 payload，Frame Header/Frame 可使用有界前缀；独立 Tile Group 必须提供更早 Sequence Header 和同层 Frame Header context。返回 SyntaxNode 的 bit range 是源文件绝对范围。该响应不写回、不改变 v1 snapshot ID，而是按 `DERIVED_SYNTAX_SNAPSHOT_V1.md` 原子冻结为独立派生 Snapshot。

## 当前限制

v1 同时支持完整内存 `AnalysisReport` 和单遍 iterable writer。CLI `index` 对 raw OBU/IVF/MP4/WebM 使用 64 KiB 文件窗口直接产出 Frame/OBU chunk；GUI 提供 manifest、四类集合分页 API 和 `Snapshot Query v1` 的稳定筛选/投影。首遍不读取 AV1 payload syntax，因此父 Snapshot 的 SyntaxNode 为空并记录 `SYNTAX_INDEX_DEFERRED`；按需结果存入独立派生 store。可重建索引和过期事务已有 dry-run/显式 cache GC；SQLite 二级索引、压缩、内容保留策略和跨进程 writer 锁留给后续兼容扩展。
