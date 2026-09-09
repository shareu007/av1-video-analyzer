# Block Overlay Adapter v1

块级数据由独立 instrumentation producer 提供，GUI 不把 Sequence Header 推导的 Superblock 网格冒充实际分区。

```json
{
  "schemaVersion": 1,
  "provenance": { "producer": "libaom-inspect", "build": "commit-or-version" },
  "frames": [{
    "frameId": 0,
    "blocks": [{
      "x": 0, "y": 0, "width": 32, "height": 16,
      "plane": 0, "partition": "split", "segmentId": 0,
      "skip": false, "mode": "intra", "intraMode": "DC_PRED",
      "interMode": null, "refs": [], "qindex": 92, "mv": [],
      "txSize": "TX_16X16", "txType": "DCT_DCT",
      "coeffNonZero": 23, "filter": "CDEF:3",
      "miRow": 0, "miColumn": 0,
      "compoundType": null, "quantDelta": 2
    }]
  }]
}
```

坐标使用 luma sample 单位；`mode` 为 `intra | inter | skip | unknown`；`partition` 使用 AV1 partition 名称；`refs` 最多两个 reference slot；MV 使用整数分量并显式记录 precision；`qindex` 为 `0..255 | null`。MV 的像素位移严格按 precision 换算：`integer`、`1/2 pel`、`1/4 pel`、`1/8 pel` 分别除以 1、2、4、8；未知 precision 保留 raw value，但不绘制且不推断。导入端分配稳定 `blockId`，验证 frame ID、几何边界、数组上限和数值范围，然后保留 producer provenance。

C ABI 的 `flags` 使用 bit 0 表示 skip、bit 1 表示 qindex 有效，因此合法的 `qindex=255` 不会再与未知值冲突。v1 布局保持 88 bytes；v2 以相同 88-byte 前缀追加 MI 坐标、compound type 和 quant delta，总长 104 bytes。JSON schema v1 将这些生产者细节作为可选字段，旧文档与 Snapshot 仍可读取。

仓库已交付稳定 v1/v2 契约、隔离的多帧 inspection Worker、Node IPC 验证器和 GUI 自动接入路径。GUI 使用同一 WebGL2 canvas 实例化绘制块矩形和 MV 箭头，支持单/双向量、reference slot 颜色、MV1/MV2、1–16×显示缩放、最小实际位移过滤、统计和选中块高亮；不会为每个向量创建 DOM。固定 libaom v3.12.1 feature-127 构建已通过 1,086-block Golden、供应链 manifest 和完整请求 crash replay；test mock 数据仍只用于桥接测试，不作为产品分析结果。

Block Statistics 默认只统计 `plane === 0`，避免把 Y/U/V 记录直接相加。记录占比与面积占比分开显示；coverage 使用矩形 union，不把 `sum(width × height)` 冒充画面覆盖率。合法重叠会报告 overlap area，重复覆盖报告 duplicate area；`null` 单独计入 missing，`qindex=0/255` 与 `quantDelta=0` 均保留为有效值。GUI 同时提供 luma 全部、intra、inter、skip、compound、含 MV、非零系数和全部 plane 的可视过滤。
