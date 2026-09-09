# Block Overlay Snapshot v1

真实 BlockRecord 不嵌入 AnalysisReport 主 Snapshot，而存入独立的内容寻址目录：

```text
<snapshot-root>/block-overlays/<id>/
  manifest.json
  frames-000000.json
  blocks-000000.json
```

manifest 绑定 `parentSnapshotId`、producer/build provenance、frame/block count、chunk range 与 SHA-256。semantic ID 覆盖 parent、provenance 和按 `(frameId, blockId)` 排列的完整嵌套 overlay；storage checksum 独立覆盖 manifest 布局。

写入流程只读取 overlay 引用到的父 Snapshot frame page，执行几何/数值校验，再写 staging、逐 chunk 校验并原子 rename；不会为少量帧加载完整父报告。重复内容复用并重新验证；损坏 chunk、错 parent、错 frame range 或超过 1,000,000 blocks 均拒绝。GC 与隔离恢复演练识别 `block-overlays` 引用和 staging。

GUI API：

- `GET /api/snapshots/:parent/block-overlays`
- `GET /api/snapshots/:parent/inspect-frames/:frameId`
- `POST /api/snapshots/:parent/inspect-frames/:frameId`
- `GET /api/block-overlays/:id/manifest`
- `GET /api/block-overlays/:id/frames?offset=&limit=`
- `GET /api/block-overlays/:id/blocks?offset=&limit=`

`inspect-frames` 先规划最近随机访问帧到目标帧的有界窗口；GUI 只从已通过源指纹绑定的 `File` 读取这些 sample range，必要时把此前索引到的 Sequence Header 作为首帧 decoder config 前缀。POST 最大 64 MiB/10,000 帧，服务端重新校验窗口长度，Worker local frameId 必须完整连续，结果再映射回原 frameId。

GUI Snapshot 视图只分页加载 blocks，不聚合完整 overlay。Node reference 使用 canonical JSON chunk；生产 Rust/Tauri 版本仍迁移到 SQLite WAL + zstd。
