# ADR-0001：Node GUI 结构分析使用一次性 Worker Thread

- 状态：Accepted
- 日期：2026-08-13
- 决策范围：Node reference GUI `/api/analyze`

## 背景

GUI 原先在 HTTP 主线程同步建立 Frame/OBU/SyntaxNode eager report。即使记录预算限制了最终对象数量，高密度输入仍会占用主事件循环，使健康检查、静态资源和其他 API 暂时失去响应。MP4/WebM 分析还会启动 `ffprobe`，需要把客户端取消传播到外部进程。

## 决策

每个分析请求创建一个一次性 Node Worker Thread。主线程完成 64 MiB 上传边界检查，把精确复制的 `Uint8Array` 作为 transferable 交给 Worker；Worker 内执行容器探测、结构解析和确定性 JSON 序列化，只把最终字符串返回主线程。

资源与生命周期约束：

- 每服务最多 2 个并发分析 Worker，容量耗尽返回 HTTP 429 / `ANALYSIS_CAPACITY_EXHAUSTED`；
- 单任务 deadline 为 15 秒，超时返回 HTTP 504 / `ANALYSIS_TIMEOUT`；
- 客户端中断返回 `ANALYSIS_CANCELLED`，先发送 abort 以终止 `ffprobe`，100 ms 后仍未退出则强制终止 Worker；
- Worker V8 资源上限为 256 MiB old generation、32 MiB young generation、8 MiB stack；
- 仍沿用 100k FrameRecord、100k OBU、200k SyntaxNode 的 GUI 发布预算；
- 每次请求使用新 Worker，因此异常退出后无需复用污染状态，下一请求自然获得新实例。

`/api/health` 暴露 deadline、记录预算以及当前/最大分析 Worker 数，便于验证运行时配置。

## 后果

优点：结构解析和 JSON 序列化不再阻塞 HTTP 主事件循环；输入所有权明确；取消可到达 `ffprobe`；Worker 状态不跨请求泄漏。

代价：输入复制和返回 JSON 字符串在短时间内增加进程总内存；Worker Thread 仍与主服务共享 OS 进程，不构成安全沙箱；每请求建线程有固定启动成本。Rust/Tauri 生产实现仍需独立受限进程、流式索引和持久化 session store。

## 被否决的方案

- 继续在主线程解析：无法满足 workflow 的故障隔离要求。
- 长驻 Worker 池：吞吐更高，但需要定义状态清理、任务复用和崩溃重建；当前本地单用户 GUI 不值得先引入该复杂度。
- 立即切换独立 OS 进程：隔离更强，但当前 reference path 的 IPC/安装复杂度高，留给 Rust/Tauri 生产边界完成。

## 验证

- 真实 Worker 对 IVF fixture 返回确定性 `AnalysisReport v1` JSON；
- 覆盖预取消、运行中取消消息、deadline、并发容量释放和信号向 packet probe 转发；
- 真实 FFmpeg 7.1.3 `ffprobe` 成功索引单帧 AV1 fixture；
- `npm run ci` 18/18 测试套件通过；性能门禁连续 2/2 轮通过。
