# Native Inspection Worker v2

`av1scope.native-inspection-worker.v2` 显式协商 BlockRecord v2，同时保持同一有状态 decoder session。

## Framing

- Request：56-byte header，magic `A1INX02\0`、version `2`；frame descriptor 与输入布局不变。
- Response：16-byte header，magic `A1INO02\0`、version `2`、record bytes `112`。
- Block response：8-byte envelope + 104-byte BlockRecord v2；前 88 bytes 与 v1 相同。

追加尾部：`detail_flags`、`mi_row`、`mi_column`、`compound_type`、`quant_delta`。有效位分别为 1、2、4；未置位字段必须为零。Node 将它们规范化为 `miRow`、`miColumn`、`compoundType`、`quantDelta`，Block Overlay JSON v1 以可选字段保存。

Worker、Node 和 Rust guard 均拒绝未知 flags、ABI/size 错位、非法复合类型、保留字段和顺序/预算错误。公共 C v1 接口与 88-byte 布局继续保留。
