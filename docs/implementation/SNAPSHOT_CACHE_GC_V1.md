# Snapshot Cache GC v1 契约

## 安全边界

`gc-cache` 是可重建缓存与未完成事务的维护命令，不是内容保留策略。无论 dry-run 还是 apply，它都不会删除根目录中的父 Snapshot、`derived-syntax/<id>` 或 `syntax-overlays/<id>` 内容目录。

唯一允许的候选类型：

- 根、Derived、Overlay store 中名称严格匹配 writer staging 格式且 mtime 已超过 `minimumAgeMs` 的事务目录；
- `indexes/derived-syntax/<parent>/<index-id>.json` 中父 Snapshot 已缺失、`storeRevision` 已过期、JSON 损坏或内容 ID 无效的索引文件。
- `indexes/snapshot-query/<snapshot>/<collection>/` 中超过 `minimumAgeMs` 的严格命名 staging 文件；
- 同目录中父 Snapshot 缺失/manifest 无效、schema/revision 过期、JSON 损坏、内容 ID 或 manifest/chunk 绑定无效的 Query sidecar。

未知文件、未知目录、未知的未来 Query collection、当前 revision 的有效索引及所有内容寻址数据始终保留。命令拒绝把文件系统根目录作为 snapshot root。

## 计划与执行

```bash
av1scope gc-cache --snapshot-dir ./snapshots
av1scope gc-cache --snapshot-dir ./snapshots --minimum-age-ms 86400000
av1scope gc-cache --snapshot-dir ./snapshots --apply
```

默认输出 `av1scope-snapshot-cache-gc-plan` 且 `mode=dry-run`。计划包含稳定 `planId`、当前 Derived 目录 revision、父/派生/overlay 引用计数、按相对路径排序的精确候选，以及明确为 0 的内容删除数。`--apply` 重新生成同一计划并逐项执行。

本地 GUI 的“存储维护”对话框使用相同契约：`GET /api/cache-gc?minimumAgeMs=...` 预览，`POST /api/cache-gc` 提交 `{ planId, minimumAgeMs }`。服务端仅在当前重新计算的 plan ID 与用户预览一致时执行；状态变化返回 `CACHE_GC_PLAN_STALE`，要求重新预览。

每个索引候选记录扫描时文件 SHA-256；目录 staging 记录 mtime，Query staging 文件记录 mtime 和 size；删除前再次核对。候选在扫描后发生变化会终止执行，不以宽泛 glob 继续删除。已被其他维护者删除的候选按幂等成功处理。

## 引用统计

扫描只读取内容目录名和 manifest header：

- 统计被 Derived/Overlay 引用且仍存在的父 Snapshot；
- 统计被 Overlay 保护的 Derived、未被 Overlay 引用的 Derived 和父缺失/manifest 无效的 Derived；
- 统计父或 Derived 缺失、manifest 无效的 Overlay。

这些状态仅供制定未来内容保留策略和人工审计；v1 不把“未引用”或“孤立”转换为删除候选。
