# FFmpeg Supply Chain Gate v1

## 结论

当前系统 FFmpeg 只允许作为开发和差分验证依赖，不允许直接复制到 AV1Scope 发行包。本机证据为 FFmpeg `7.1.3-0+deb13u1`、Debian hardened shared build、`libavformat 61.7.100`、`libavcodec 61.19.101`、`libavutil 59.39.100`；configure 含 `--enable-gpl`，动态依赖面也远超 demux 最小集合。

这是一道自动工程门禁，不是法律意见。最终许可证结论仍需发行/法务评审。

## 自动检查

`native/ffmpeg-distribution-policy-v1.json` 固化：

- 必需库：libavformat、libavcodec、libavutil；
- 禁止发行配置：`--enable-gpl`、`--enable-version3`、`--enable-nonfree`；
- 发行证据：source revision、source archive SHA-256、完整 configure flags、compiler identity、binary SHA-256、license inventory、SBOM。

`npm run check:ffmpeg-provenance` 从当前开发环境读取运行时版本、build configuration、pkg-config 版本和三库真实文件 SHA-256。当前结果必须为 `distribution blocked`；如果环境缺少开发元数据则明确 skip，不伪造 provenance。

报告只输出 basename、版本和阻断原因，不输出本机绝对库路径。hash 只在进程内用于证据计算，当前不提交机器特定 report。

## 生产构建待办

正式构建应从固定源码归档和 revision 开始，采用 demux-only 最小 feature set；分别为 Linux/Windows 记录 compiler、构建脚本、patch digest、库和 adapter digest。CI 生成 SPDX 或 CycloneDX SBOM、许可证/NOTICE bundle，并验证其与签名安装包内容完全对应。只有 policy 无禁用 flag、所有证据齐全且评审通过，构建才能成为 release candidate。
