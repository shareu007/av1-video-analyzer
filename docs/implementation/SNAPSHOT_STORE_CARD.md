# Snapshot Store v1 实现卡

## 用户问题

编码工程师需要把一次分析固定成可复现 snapshot，后续分页查看或导出时不能混入另一次分析结果；缓存损坏必须明确报错，不能静默展示错误字段。

## 范围与非范围

范围：内容寻址 ID、记录分块、原子目录提交、单遍 iterable writer、分页读取、全量重建、完整性校验、CLI `analyze/index/query/replay-derived/merge-derived/replay-overlay/gc-cache`、GUI 分页与稳定查询、按需语法检查、独立派生 Snapshot、parent/OBU 持久索引、Snapshot Query chunk-level sidecar、流式多 OBU Syntax Overlay，以及仅针对可重建缓存/过期事务的安全回收。非范围：SQLite 通用二级索引、内容 Snapshot 自动删除、压缩和跨进程并发 writer。

## 用户路径

普通文件可运行 `av1scope analyze input.ivf --snapshot-dir ./snapshots` 保存完整报告；大文件运行 `av1scope index input.mp4 --snapshot-dir ./snapshots` 流式提交结构索引，再以 GUI `--snapshot-dir` 和“打开快照”按 ID 分页浏览。需要查看 deferred syntax 时，由用户绑定大小/指纹一致的原文件，再点击 OBU 执行有界按需检查。GUI 返回派生 ID并支持重放/导出；CLI `replay-derived` 验证父绑定与内容摘要后导出。

## 契约与样本

契约见 `SNAPSHOT_STORE_V1.md`。样本覆盖双 OBU/多 chunk、空集合、跨页、相同报告重复提交、chunk 篡改、manifest offset 篡改和 CLI 单 OBU 端到端路径。

## 验收标准

- snapshot ID 对同一规范化报告稳定；
- reader 不可观察到半提交目录；
- 任一 chunk 或 manifest 拓扑不一致时拒绝；
- 分页返回固定 snapshot、collection、offset、limit、total 和 records；
- 指纹不匹配的源文件拒绝绑定，检查接口重新验证 snapshot 记录与 payload/context 范围；
- 按需语法字段使用源文件绝对 bit range，且不修改原 snapshot；派生与多 OBU overlay 结果内容寻址、原子发布并可验证重放；
- 完整重建 JSON 与原报告确定性 JSON 字节一致；
- Query sidecar 只能跳过可证明不命中的 chunk；结果、顺序、query ID 和 page token 必须与强制全扫描一致，损坏索引可确定性重建；
- CLI stdout 契约不变，全量 CI 和现有性能门禁通过。

## 风险与降级

普通 analyze 的额外规范化会增加 eager 内存峰值；`index` 避免该峰值但深层语法延后到单 OBU 检查。首尾采样指纹用于防止误绑，不是完整文件内容认证；服务端仅能冻结客户端提交 payload 的摘要，不能宣称独立验证整个原文件。单次 payload 限 256 KiB。磁盘不足会使提交失败而不发布半成品目录。用户可不传 `--snapshot-dir`，继续使用原 JSON 导出路径。

## Owner / Reviewer

- Owner：Storage/API reference path
- Required reviewers：Storage/API、Parser、Runtime/Security、QA
- ADR：`docs/adr/0002-file-snapshot-store.md`
