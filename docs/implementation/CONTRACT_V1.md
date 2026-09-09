# AV1Scope M0 JSON Contract v1

## Compatibility rules

- `schemaVersion` 的主版本未知时，消费者必须拒绝记录；
- v1 中新增字段必须是可选字段，消费者应忽略未知可选字段；
- 所有范围使用半开区间语义：`start` + `length`，单位为 byte；
- record ID 按解析顺序稳定分配，不等于 display order；
- 时间戳以十进制字符串表示，避免 JSON number 精度损失；
- 输出数组按源文件顺序排列，诊断按发现顺序排列。

## AnalysisReport v1

```text
schemaVersion: 1
source: { name, size, format }
container: null | IvfContainer
frames: FrameRecord[]
obus: ObuRecord[]
syntaxNodes: SyntaxNode[]
diagnostics: Diagnostic[]
summary: { frameCount, obuCount, errorCount, warningCount, complete }
provenance: { parser, parserVersion, implementation }
```

## FrameRecord v1

```text
schemaVersion: 1
frameId: integer
decodeIndex: integer
timestamp: decimal string
sampleRange: ByteRange
payloadRange: ByteRange
declaredSize: integer
complete: boolean
obuIds: integer[]
headerSummary: FrameHeaderSummary (optional)
```

`FrameHeaderSummary` 在首个可解释 Frame Header OBU 上建立，包含帧类型、显示标志、coded/render 尺寸、`refreshFrameFlags`、`referenceSlotIndices` 与解析时映射出的 `referenceFrameIds`。无法解析或未被占用的参考槽用 `null`，消费者必须保留其槽位顺序。

## ObuRecord v1

```text
schemaVersion: 1
obuId: integer
frameId: integer | null
type: { code, name }
header: { forbiddenBit, extensionFlag, hasSizeField, reservedBit, temporalId, spatialId }
byteRange: ByteRange
headerRange: ByteRange
sizeFieldRange: ByteRange | null
payloadRange: ByteRange
declaredPayloadSize: integer | null
complete: boolean
syntaxNodeIds: integer[]
syntaxStatus: pending | partial | complete | error | not_applicable
parsedPayloadBitLength: integer (optional)
frameHeaderSummary: FrameHeaderSummary (optional)
tileGroupSummary: TileGroupSummary (optional)
metadataSummary: MetadataSummary (optional)
```

`complete` 仅说明已获得 OBU 声明的全部字节，不表示 payload 的全部语法已实现。`syntaxStatus` 独立描述语法解析覆盖度；消费者不得将 `partial` 当作完整字段树。

解析器达到配置的 FrameRecord、OBU 或 SyntaxNode 记录预算时，保留预算内的稳定前缀并发出 `FRAME_RECORD_LIMIT_REACHED`、`OBU_RECORD_LIMIT_REACHED` 或 `SYNTAX_NODE_LIMIT_REACHED` error；此时 `summary.complete=false`。消费者不得将未发布的输入尾部视为已扫描。预算是运行时资源策略，不改变 v1 record schema。

## SyntaxNode v1

```text
schemaVersion: 1
nodeId: integer
obuId: integer
path: stable dotted field path
value: JSON scalar | array | object
coding: f(n) | uvlc() | le(n) | bytes(n) | inferred
presence: human-readable condition
bitRange: { startBit, lengthBits } | null
specAnchor: normative syntax section
```

`coding=inferred` 的字段由规范条件推导，没有直接编码的源位，因此 `bitRange=null`。UI 必须明确展示 inferred，不能伪造范围。

Sequence Header 与固定长度 HDR Metadata 的 `syntaxStatus=complete` 只有在字段、`trailing_one_bit`、对齐零位均合法且 payload 无剩余数据时成立。

Tile Group 的 `complete` 表示范围头、对齐、size 字段和 coded tile byte ranges 已覆盖完整 payload，不表示已经解析算术熵编码的 block syntax。`tileGroupSummary.tiles[*].byteRange` 是对应 tile 的绝对源范围；`OBU_FRAME` 可同时带 `frameHeaderSummary` 和 `tileGroupSummary`。

## Diagnostic v1

```text
schemaVersion: 1
code: stable machine-readable string
severity: info | warning | error | fatal
message: human-readable string
byteRange: ByteRange | null
frameId: integer | null
obuId: integer | null
```
