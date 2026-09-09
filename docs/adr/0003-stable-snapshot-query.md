# ADR-0003：Snapshot Query 使用受限 JSON AST 与绑定查询的分页令牌

- 状态：Accepted
- 日期：2026-08-13
- 决策范围：Node reference Store、CLI、本地 GUI API

## 背景

系统设计要求 `query(filter_expression, projection, page_token)` 返回稳定分页结果。Snapshot Store 内容不可变且集合已分块，但原先只能按物理 offset 分页，用户无法跨大文件按 OBU 类型、诊断级别、字段路径或帧属性筛选。直接执行 JavaScript 表达式会引入代码执行风险；把全部集合读入内存再筛选会破坏大文件路径的资源边界。

## 决策

引入 `Snapshot Query v1`：查询表达式使用受限 JSON AST，不接受源码字符串或正则。叶节点由安全 dotted path、固定 operator 和有界 JSON scalar 构成；组合节点仅允许 `all`、`any`、`not`。表达式限制 64 个节点、8 层深度，projection 最多 32 个路径，单页最多 1,000 个结果。

执行器按 Snapshot Store 物理顺序扫描经过 SHA-256 校验的 chunk，每次最多持有一个 1,000 记录扫描页。结果保留 `sourceOffset`；projection 输出以路径为键的对象。查询 ID 是 collection、规范化 filter 与 projection 的内容摘要。

分页令牌包含 schema、snapshot ID、query ID 和下一条匹配记录的物理 offset，并带自身内容摘要后使用 canonical base64url 编码。Reader 拒绝非规范、摘要错误、Snapshot/查询不匹配或越界令牌。令牌用于稳定续页和误用检测，不是授权凭据。

## 后果

优点：CLI、API 和 GUI 共用同一安全表达式；结果顺序稳定；分页不聚合完整集合；chunk 损坏不会被查询绕过；同一令牌不能套用到另一查询或 Snapshot。

代价：文件型 reference store 未建立二级索引，选择率低且目标靠后的查询为 O(n) 扫描。生产 SQLite store 应把常用列下推到索引，同时保留本 AST、query ID、排序和 page-token 语义。v1 不支持正则、算术、跨集合 join 或用户脚本。

## 验证

- 嵌套字段、布尔组合、比较、集合、包含与存在运算；
- projection、跨 chunk 续页、稳定 query ID 和完整结果顺序；
- query/token 不匹配、非规范 token、危险 prototype path、复杂度和类型预算拒绝；
- 被篡改 chunk 查询失败；
- CLI JSON/CSV、HTTP 成功/错误映射与 GUI 查询控件。
