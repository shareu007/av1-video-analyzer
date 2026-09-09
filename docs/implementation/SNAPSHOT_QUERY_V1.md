# Snapshot Query v1 契约

## 请求

```json
{
  "collection": "obus",
  "filter": {
    "all": [
      { "path": "type.code", "op": "eq", "value": 6 },
      { "path": "byteRange.length", "op": "gte", "value": 128 }
    ]
  },
  "projection": ["obuId", "frameId", "type.name", "byteRange.start"],
  "limit": 100,
  "pageToken": null
}
```

`collection` 必须是 `frames`、`obus`、`syntaxNodes` 或 `diagnostics`。`filter=null` 匹配全部记录。叶节点的 path 是仅访问自有属性的安全 dotted path；禁止 `__proto__`、`prototype` 和 `constructor`。组合节点为 `{all:[...]}`、`{any:[...]}` 或 `{not:{...}}`。

运算符：

- `eq` / `ne`：JSON scalar 严格相等；
- `lt` / `lte` / `gt` / `gte`：仅数值；
- `in`：最多 100 个 scalar；
- `contains`：字符串子串或数组成员；
- `exists`：value 为 boolean，区分属性缺失和属性值为 `null`。

预算：最多 64 个 filter node、8 层、32 个 projection path、每个字符串 4,096 UTF-8 bytes、单页 1–1,000 个匹配结果。未知运算、危险路径、非有限数值和超预算请求必须在扫描前拒绝。

## 响应与顺序

响应 kind 为 `av1scope-snapshot-query-page`。每个结果包含物理 `sourceOffset` 和完整/投影后的 `record`。扫描顺序始终等于不可变 Snapshot collection 顺序，不按值重新排序。

`queryId` 是 `{collection,filter,projection}` 规范化 JSON 的 SHA-256。`nextPageToken` 绑定 schema、snapshot ID、query ID 和下一条匹配记录 offset；token 自身带摘要并采用 canonical base64url。更改 filter/projection/collection、套用到另一 Snapshot、篡改或使用越界 token 必须拒绝。`nextPageToken=null` 表示已扫描到集合末尾。

`scannedCount` 是本页为产生结果实际检查的源记录数，可能包含用于确认下一页存在的一条 lookahead match；它不是累计值。`sourceTotal` 是源 collection 总记录数，`matchedCount` 仅是当前页结果数，不冒充全局命中总数。

`execution` 说明实际执行路径：`strategy`、`indexId`、`indexStatus`、`indexBuildScannedRecords`、`indexFallback`、`scannedChunks`、`skippedChunks` 和 `skippedRecords`。首次建立 sidecar 时，索引构建读取的记录数单独计入 `indexBuildScannedRecords`，不混入本页 `scannedCount`。

HTTP 扫描接受客户端取消并有 10 秒 deadline，分别返回 `SNAPSHOT_QUERY_CANCELLED` 与 `SNAPSHOT_QUERY_TIMEOUT`；取消在 chunk 之间及每 256 条记录检查。CLI 没有隐式 deadline，适合离线批处理并通过 page token 显式续页。

## 接口

```bash
av1scope query SNAPSHOT_ID --snapshot-dir ./snapshots \
  --collection obus \
  --filter '{"path":"type.code","op":"eq","value":6}' \
  --projection 'obuId,frameId,type.name' --limit 100
```

- CLI 默认输出规范化 JSON；`--csv` 要求 projection，首列固定为 `source_offset`；
- `--page-token` 续接完全相同的查询；
- `POST /api/snapshots/:id/query` 使用相同请求/响应；
- GUI Snapshot Store 卡片提供单条件构造器和前后分页；复杂 `all/any/not` 查询使用 CLI/API。

## Sidecar index v1

文件型 reference store 为四个 collection 建立确定性的 chunk-level sidecar。常用字段包括 frame/OBU ID、track、DTS/PTS、key-frame、OBU type、temporal/spatial ID、source range、syntax status、syntax node path/coding 和 diagnostic code/severity。

每个源 chunk 记录字段存在数、scalar/number 数、数值 min/max，以及不超过 64 个的精确 scalar 集合。`eq`、`ne`、数值范围、`in` 和 `exists` 仅在索引能证明该 chunk 不可能命中时跳过；`contains`、`not`、未知字段及不能安全证明的组合继续读取源 chunk。因此索引只能减少扫描，不能改变结果、source order、query ID 或 page token。

sidecar 位于：

```text
indexes/snapshot-query/<snapshotId>/<collection>/<indexId>.json
```

`indexId` 绑定 Snapshot payload digest、collection revision、字段集合、源 chunk topology/SHA-256 和所有统计。首次可索引查询惰性创建；有效文件命中时复用；缺失、损坏、旧 schema、内容 ID 错误或与当前 manifest 不匹配时，从经过校验的 Snapshot chunk 重建。非取消类索引 I/O 错误降级为全扫描并设置 `indexFallback=true`；取消和 deadline 不降级。

## 完整性与当前限制

执行器和索引 builder 都通过 `readSnapshotPage` 读取，因此实际读取的 manifest topology、chunk SHA-256 和记录数仍验证。一次只持有一个扫描页和一个结果页，不重建完整 report。sidecar 是可重建加速缓存，不是 Snapshot 内容的信任根。

当前索引是 chunk-level pruning，不是通用倒排索引：首次构建仍为 O(n)，高基数字段超过精确值预算时主要依赖数值范围，`contains`/`not` 不下推。未来 SQLite 实现可增加 B-tree/表达式索引，但不得改变 AST 规范化、source order、query ID 或 page-token 绑定语义。
