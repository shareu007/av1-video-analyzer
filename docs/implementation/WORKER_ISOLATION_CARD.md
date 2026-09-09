# GUI 分析 Worker 隔离实现卡

## 用户问题

分析高密度或损坏码流时，编码工程师仍需操作 GUI、查看健康状态，并能取消任务；单个分析请求不能拖死整个本地工作台。

## 范围与非范围

范围包括 `/api/analyze` 的 Worker Thread 隔离、上传/记录/内存/并发/deadline 预算、客户端取消、`ffprobe` 取消传播、稳定 API 错误码和健康状态。非范围包括 OS 进程沙箱、Worker 池复用、流式/持久化索引、Rust/Tauri IPC 和 libaom FFI。

## 用户路径

用户上传 MP4/WebM/IVF/OBU → 服务取得一个分析容量槽 → Worker 解析并序列化 → GUI 接收原有 `AnalysisReport v1`。用户中途离开或取消时，任务终止且容量槽释放；容量已满时收到可识别的忙碌错误。

## 数据来源与契约影响

结构字段仍只来自 Node structural parser，容器 packet span 来自本机 `ffprobe`。`AnalysisReport v1` 不变；HTTP 错误新增 `ANALYSIS_CANCELLED`、`ANALYSIS_TIMEOUT`、`ANALYSIS_CAPACITY_EXHAUSTED`。健康响应新增 analysis deadline、记录预算和 Worker active/limit。

## 样本

- 合法合成单帧 IVF + Sequence Header；
- 固定可解码 16×16 单帧 AV1 IVF；
- 预取消与运行中取消的无效输入；
- 永不完成的注入 Worker，用于确定性 deadline 测试；
- 单容量 gate 上的两个并发任务。

## 验收标准

- 结构解析与 JSON 序列化均不在 HTTP 主线程执行；
- 客户端取消到达 Worker，容器探测接受同一 AbortSignal；
- deadline、并发和 Worker 内存均有硬上限；
- 所有成功响应保持 `AnalysisReport v1`；
- Worker 失败不复用状态，容量在成功/失败后均释放；
- 全量 CI 与既有性能门禁通过。

## 风险与降级

Worker Thread 不是 OS 沙箱，且 transferable 前的安全复制带来短时内存峰值。若 Worker 路径出现回归，可保留 CLI reference parser 作为结构分析降级路径；不能回退到 GUI HTTP 主线程同步解析。

## Owner / Reviewer

- Owner：Runtime / GUI reference path
- Required reviewers：Runtime/Security、Parser、QA
- 关联决策：`docs/adr/0001-node-analysis-worker.md`
