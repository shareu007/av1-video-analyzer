# Tile Group Structure v1

## 目标与边界

本切片实现 AV1 `tile_group_obu(sz)` 的字节级结构解析：读取显式/隐式 tile 范围、两个字节对齐阶段、非末尾 tile 的 little-endian size 字段，并为每个 coded tile 建立绝对 `ByteRange`/`bitRange`。规范基线是 [AOMedia AV1 Bitstream & Decoding Process Specification](https://aomediacodec.github.io/av1-spec/) 的 Frame OBU 与 Tile Group OBU syntax。

它不是算术熵解码器。`coded_tile_data` 被当作不透明字节区间；partition/mode/MV/transform/coeff/filter 仍必须由固定版本的 instrumented libaom producer 生成。

## 上下文和状态

- `OBU_TILE_GROUP` 必须关联同 temporal/spatial layer 的先前完整 Frame Header；
- Frame Header summary 提供实际 `tileCols`/`tileRows`、`tileColsLog2`/`tileRowsLog2` 和 `tileSizeBytes`；
- 多个 Tile Group 通过 `nextExpectedTile` 检查连续 scan order；覆盖最后一个 tile 后释放该 layer 的上下文；
- `OBU_FRAME` 先从 Frame Header 的 `parsedBitLength` 继续，验证 Frame OBU 对齐，再解析嵌入 Tile Group；其范围标志必须为零；
- Sequence Header 更新会清除未完成的 tile context，避免跨 coded video sequence 复用状态。

## 输出

`ObuRecord.tileGroupSummary` 是 v1 可选扩展，包含：

```text
kind: "tile_group"
contextFrameHeaderObuId: integer | null
embeddedFrame: boolean
numTiles, tileCols, tileRows, tileSizeBytes: integer
tileStartAndEndPresent: boolean
tgStart, tgEnd, headerByteLength: integer
tiles: [{ tileNum, tileRow, tileCol, tileSize, byteRange, lastInGroup }]
completeFrame: boolean
nextExpectedTile: integer | null
```

字段树使用 `tile_group.*` 稳定路径。非末尾 `tile_size_minus_1` 的 coding 为 `le(n)`；`coded_tile_data` 的 value 只保存 `{byteLength}`，真实位置由绝对 `bitRange` 表示，避免在报告中复制码流负载。

## 稳定诊断

- `TILE_GROUP_FRAME_CONTEXT_MISSING`
- `TILE_GROUP_START_OUTSIDE_PAYLOAD`
- `TILE_GROUP_ALIGNMENT_BIT_SET`
- `FRAME_OBU_TILE_RANGE_FLAG_SET`
- `TILE_GROUP_RANGE_OUT_OF_BOUNDS`
- `TILE_GROUP_RANGE_REVERSED`
- `TILE_GROUP_ORDER_DISCONTINUITY`
- `TILE_SIZE_EXCEEDS_PAYLOAD`
- `TILE_GROUP_TRUNCATED`
- `TILE_GROUP_EXTENSION_MISMATCH`

任何上述 error 都使该 OBU 的 `syntaxStatus=error`。结构完整且所有 tile range 恰好消费 payload 时为 `complete`。

## 延迟检查

完整 `OBU_FRAME` 的 Snapshot 按需检查会同时生成 Frame Header 和 Tile Group 字段。独立 `OBU_TILE_GROUP` 会按同 extension/temporal/spatial layer（容器中还要求同 frame）的最近先前 Frame Header 建立上下文，并继续查找更早的 Sequence Header。服务端重新读取三个不可变父 OBU 记录，校验顺序、类型、layer 和 payload length；Derived Syntax Snapshot 同时冻结目标、Sequence Header、Frame Header 三段客户端实际提交 payload 的 SHA-256。单 OBU 检查无法证明前序 Tile Group 的累计 `TileNum`，因此不对独立按需检查声称跨 group 连续性；eager 顺序解析仍执行该诊断。
