# Derived Syntax Snapshot v1 契约

## 目的

流式结构 Snapshot 不读取完整 AV1 payload。用户按 OBU 执行深层语法检查后，需要冻结字段树、诊断、父结构版本和解析器版本，供 GUI 重放与 CLI 确定性导出，同时不得修改不可变的父 Snapshot。

## 目录与标识

```text
<snapshot-root>/derived-syntax/<derived_snapshot_id>/manifest.json
```

`derived_snapshot_id` 是 manifest 内容载荷的规范化 JSON SHA-256。内容载荷不包含 ID 自身，包含：`schemaVersion`、`kind`、`parentSnapshotId`、`sourceBinding`、`request`、`provenance` 和 `inspection`。相同内容幂等复用；写入唯一 staging 目录并以同文件系统 rename 原子发布。

## Manifest v1

```json
{
  "derivedSnapshotId": "<sha256>",
  "schemaVersion": 1,
  "kind": "av1scope-derived-syntax-snapshot",
  "parentSnapshotId": "<sha256>",
  "sourceBinding": {
    "expectedSize": 1234,
    "expectedFingerprint": {
      "algorithm": "sha256-first-last-64k-v1",
      "digest": "<sha256>"
    },
    "verificationBoundary": "browser-sampled; server binds submitted payload digest only"
  },
  "request": {
    "obuId": 7,
    "payloadBytes": 311,
    "payloadSha256": "<sha256>",
    "sequenceContext": {
      "obuId": 2,
      "payloadBytes": 19,
      "payloadSha256": "<sha256>"
    },
    "frameHeaderContext": {
      "obuId": 6,
      "payloadBytes": 41,
      "payloadSha256": "<sha256>"
    },
    "transport": "client-submitted-payload"
  },
  "provenance": {
    "parser": "av1scope-structural-parser",
    "parserVersion": "0.1.0",
    "operation": "snapshot-obu-syntax-inspection"
  },
  "inspection": {}
}
```

`sequenceContext` 不需要时为 `null`。独立 Tile Group 必须同时提供并冻结更早的 `sequenceContext` 与同层 `frameHeaderContext`；其他类型的 `frameHeaderContext` 为 `null`。Reader 校验 `sequence OBU < frame-header OBU < tile-group OBU`、父记录类型、extension/temporal/spatial layer、同容器 frame（适用时）和完整 payload length。不保存原始 payload、绝对文件路径或创建时间，因此相同语义内容可得到稳定 ID。

## 信任与验证边界

- 浏览器在本地比较文件大小和首尾采样指纹后提交目标 payload；该采样只防误绑，不是完整文件认证。
- 服务端无法独立读取浏览器本地文件，因此不得把 payload 标为“服务端验证的原文件内容”。Manifest 明确记录 `client-submitted-payload`，并冻结服务端实际收到的 payload SHA-256。
- 服务端写入和读取时均验证父 Snapshot、OBU ID、OBU type、payload range、Sequence/Frame Header context、父 source size/fingerprint 和解析器输出绑定。
- Reader 重算派生 ID；内容、父记录或父 source binding 不一致必须拒绝。
- 派生结果可重放，但没有保存 payload，不能仅凭 manifest 重新运行解析器。需要重新解析时必须再次绑定原文件。

## API 与 CLI

- `POST /api/snapshots/:parent/inspect/:obuId`：解析并创建/复用派生 Snapshot，响应保留检查字段并增加 `derivedSnapshot.id/created`。
- `GET /api/derived-syntax/:id`：验证父快照和内容摘要后返回 manifest。
- `av1scope replay-derived <id> --snapshot-dir <root>`：验证并输出规范化 JSON；支持 `--output`、`--compact` 和 `--force`。
- `av1scope rebuild-derived-index <parent> --snapshot-dir <root>`：扫描并验证内容目录，重建 parent/OBU 查询索引。

## Parent/OBU 索引

```text
<snapshot-root>/indexes/derived-syntax/<parent-id>/<index-id>.json
```

索引是可丢弃、可重建的缓存，不是内容真相。`storeRevision` 是当前全部 64 位 derived 内容目录名排序数组的规范化 SHA-256；`index-id` 是 parent、revision 和按 OBU/derived ID 排序 entries 的内容摘要。查询先以目录名计算 revision，只采用 revision 匹配且自身摘要有效的索引；目录新增/删除或索引 JSON 损坏时自动扫描已验证 Derived Snapshot 重建。索引采用内容寻址版本文件，不覆盖旧 revision，因此并发 reader 不会看到半写文件。

## 当前限制

v1 每个派生 Snapshot 只冻结一个 OBU 检查结果，不更新父 Snapshot 的 `syntaxNodes` collection；多 OBU 合并由 `Syntax Overlay Snapshot v1` 承担。`gc-cache` 可 dry-run/显式清理旧 revision 与损坏索引，但不会删除派生或 overlay 内容。内容保留策略、签名和跨进程 writer lock 留给后续兼容扩展。
