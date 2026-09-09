# ADR 0004：FFmpeg/libaom 使用版本化窄 C ABI

状态：Accepted（2026-08-13）

## 背景

生产架构需要 libavformat 建立 sample table，并由固定 libaom fork 产生块级事件。直接让 Rust/UI 依赖 `AVFormatContext`、`AVPacket`、libaom internal struct 或 inspection header，会把第三方版本布局、所有权和崩溃域扩散到核心契约。

## 决策

采用 `native/include` 的 C ABI v1。共同 struct 使用固定宽度整数、显式 `struct_size/abi_version` 和版本化符号。Status 的 ABI 类型固定为 `uint32_t`，命名 enum 只提供常量；Rust 先接收原始数值再显式规范化，未知值不能成为非法 enum。Demux 只接受 caller-owned `read_at`，返回复制的 stream/sample scalar；inspection 只接受 bounded sample bytes，通过 callback 暂借固定布局 BlockRecord chunk。第三方对象、路径、allocator 和异常均不得越界。取消/deadline、资源上限、稳定 status 和短期 diagnostic 是 ABI 一部分。

## 后果

FFmpeg/libaom 升级可以在 adapter 内完成并由差分/Golden 验证；Rust FFI 面积小，可对所有 range/length 再验证，Worker 可每实例拥有 decoder 并崩溃隔离。代价是需要显式 enum normalizer、字符串表和数据复制；88-byte v1/104-byte v2 BlockRecord 高密度输出必须按 chunk 传输，不能逐记录跨 FFI。

当前仓库已在系统 FFmpeg development package 上实现真实 custom-AVIO demux producer，并对 IVF/MP4/WebM 与 ffprobe 逐 packet 差分和 ASan/UBSan 验证。它仍是 Linux reference adapter：依赖尚未固定/打包，Rust safe wrapper 和 Windows ABI 尚未完成。inspection Worker 已对固定 libaom v3.12.1 应用最小 patch，完整 feature 127 与 Block Golden 已通过；供应链 manifest 仍待完成。
