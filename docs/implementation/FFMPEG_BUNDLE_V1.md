# FFmpeg Release Bundle v1

AV1Scope 的 Linux reference release 固定使用 FFmpeg 7.1.5 commit
`3a0867c2bfda4a4d4309ca1a8cbdc6175e67f587`。构建只接受本地 upstream Git
checkout、已经验收的 libaom 3.12.1 artifact 和本机 zlib；构建脚本不下载依赖。

```bash
AV1SCOPE_FFMPEG_REPOSITORY=/fixed/src/FFmpeg npm run native:build:ffmpeg
npm run check:ffmpeg-release
```

默认输出为 `build/ffmpeg-v7.1.5-release/`。bundle 包含：

- relocatable `ffmpeg`、`ffprobe`、demux adapter/Worker 和六个运行库；
- 固定 Git archive及其 SHA-256；
- FFmpeg LGPL、libaom BSD/PATENTS、zlib 和项目 NOTICE；
- canonical license inventory、CycloneDX 1.6 SBOM、完整文件/符号链接 inventory；
- canonical build manifest，build ID 绑定源码、工具链、配置、libaom 和 zlib 输入。

release gate 逐文件重算摘要，拒绝未声明文件、路径逃逸、GPL/nonfree/version3
配置、错误 SONAME/RUNPATH 和 bundle 外的非平台动态库；随后实际运行版本/feature
检查、PNG decode、`trace_headers` 与 24-sample Native Demux smoke。

当前实证：build ID `140c0659911fc800f3633584ab552fa2110787fd`，manifest
SHA-256 `6f3087cf6479fcc5e0938fbcb6802f3f0797d991d4341f077afd81743fd72984`，
30 个 inventory entry、6 个运行库。两次独立构建的完整目录树一致。

该门禁证明工程供应链和 LGPL 配置证据完整，不代替法律意见。项目自身仍是
`UNLICENSED`，因此 inventory 明确保留 `legalReviewRequired: true`；正式对外发行前
必须确定项目许可证并完成法律审查。
