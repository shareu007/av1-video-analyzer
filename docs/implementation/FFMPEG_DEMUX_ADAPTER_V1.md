# FFmpeg Demux Adapter v1

状态：Linux reference adapter implemented and runtime-validated（2026-08-13）；尚未接入 Rust/Tauri 默认路径，也尚未形成可发行的固定依赖包。

## 实现边界

`native/ffmpeg_demux_adapter.c` 实现 `av1scope_demux_*_v1`：

- 只接受 caller-owned `read_at` 和 source byte length；传给 `avformat_open_input` 的 URL 为 `NULL`，不开放文件路径、协议或网络；
- `AVFormatContext`、`AVIOContext`、`AVPacket` 和 FFmpeg allocator 均留在 adapter 内；ABI 只返回复制的 stream/sample scalar；
- 选择 AV1 video stream，输出 FFmpeg stream index、尺寸、time base、packet DTS/PTS/duration/flags 和经过源文件边界验证的 `pos + size`；
- open/find-stream/next-packet 都接受 cancel/deadline；probe 累计读取、单 sample bytes、source size、track selector 和 flags 都有显式上限或校验；
- 所有失败返回稳定 v1 status 和不含路径/payload 的静态短诊断；close 接受 `NULL`。

`native/CMakeLists.txt` 生成隐藏符号的 `libav1scope_ffmpeg_demux` shared library，只导出带 `AV1SCOPE_API` 的版本化符号。构建示例：

```bash
cmake -S native -B build/native -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --parallel
```

## 当前实测证据

本机使用 `libavformat 61.7.100`、`libavcodec 61.19.101`、`libavutil 59.39.100` 和 FFmpeg 7.1.3。`npm run check:ffmpeg-adapter` 在临时目录：

1. 以 libaom 生成 64×36、3 帧的 IVF、MP4、WebM；
2. 用真实 shared-library source 同一实现编译运行时 harness；
3. 对每个 packet 逐项比较 adapter 与 `ffprobe` 的 stream index、DTS、PTS、duration、source offset、source length 和 key flag；
4. 验证 open/next cancellation、过期 deadline、不存在的 track、实际累计 probe budget 耗尽、sample budget、EOF、重复 open/close 和截断 DKIF malformed status；
5. 运行 93 个确定性畸形样本：空/短输入、容器多截断点、等距 bit flip、32-byte 局部覆盖和固定种子噪声；若畸形样本仍能打开，则继续核对 sample ID/track/flags/source range，并最多读取 4,096 个 sample；每个 case 设 5 秒进程上限；
6. 正常与 ASan/UBSan 两种构建均通过。当前监管环境不支持 LeakSanitizer，因此本地 sanitizer 明确设置 `detect_leaks=0`；独立 Linux CI job 设置 LSan=1。

三种容器的全部记录与同机 `ffprobe` 一致。该结果证明 adapter 的 sample table 接缝，而不是 AV1 深层块分析。

## 尚未满足

- 当前链接的是系统动态 FFmpeg，不是仓库固定源码 commit/可复现构建；adapter provenance 只公开 `LIBAVFORMAT_IDENT`；
- 当前 Debian FFmpeg build 声明 GPLv2-or-later，并带大量可选依赖。不得直接把本机二进制复制进发行包；正式分发前必须固定 configure flags、许可证集合、源码供给方式和 SBOM，并由法律/发行评审批准；
- `ffmpeg-distribution-policy-v1.json` 与 `check:ffmpeg-provenance` 已把上述判断变成自动阻断：当前因 `--enable-gpl` 以及缺 source revision/archive digest、license inventory、SBOM 而不能发行；
- sample byte budget 在 packet 返回后验证；FFmpeg demuxer内部探测/packet allocation 仍必须运行在受限 Worker 进程，不能把 adapter 当作内存安全沙箱；
- caller `read_at` 必须是本地、可取消或有界的实现；如果 callback 自身永久阻塞，FFmpeg interrupt callback 无法抢占它；
- Windows calling convention/build、持续 coverage-guided fuzz、长时反复 open/close、真实 adapter↔Rust wrapper 集成、动态库 loader 和 Worker crash/retry 尚未完成；Rust safe handle 的源码与 mock 单测已建立，但本机无工具链验证；
- inspection/libaom BlockRecord producer 与此 demux adapter 是不同的未完成工作项。
