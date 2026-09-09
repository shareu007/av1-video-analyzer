# Node GUI 快速检查

```bash
npm run native:build
# 可选：本地固定 FFmpeg checkout 可用时构建 release bundle
AV1SCOPE_FFMPEG_REPOSITORY=/fixed/src/FFmpeg npm run native:build:ffmpeg
npm run check:ffmpeg-release
# 可选：固定 libaom 源码可用时启用真实块级 inspection
npm run native:build:inspection -- --source /fixed/src/aom --expected-revision REVISION
npm run --silent gui:check
npm run gui
```

浏览器打开终端输出的地址（默认 `http://127.0.0.1:4173`），点击“加载内置示例”。

预期：

- 顶栏显示“服务就绪”；
- `gui:check` 显示 `nativeDemux: true`、`source: bundled`；
- release bundle 存在时显示 FFmpeg `7.1.5`、build ID 和 `legalReviewRequired: true`；
- 构建 inspection 后显示 `deepBlockInspection: true`；
- 左侧出现当前帧的 OBU，顶部出现 1 帧时间线；服务支持预览时默认显示画面，否则显示结构概览；
- 字节、概览、帧预览和 FFmpeg Trace 可切换；
- 打开含 inter/compound 块的文件后，帧预览可启用 `MV arrows`，切换 MV1/MV2、缩放和最小位移；点击块后 Inspector 同时显示 raw MV 与像素位移；
- 展开“块统计 · 亮度”查看 coverage、overlap/duplicate、QIndex 直方图和模式/分区/尺寸等分布；切换 Intra/Inter/Skip/Compound/MV/非零系数过滤时，画布、计数和空间拾取同步更新；
- “导出”菜单提供 JSON/CSV/PNG；
- 报告自动写入 `.av1scope-cache/`，“工具”菜单提供快照、块数据导入和存储维护入口。
- 选择超过 64 MiB 的文件会自动建立流式 Snapshot，并在完成后打开分页概览。

真实文件用“打开码流”或拖放；如不需要落盘，使用：

```bash
npm run gui -- --no-snapshot
```

## 工作台交互检查

本轮参考 [Intel Video Pro Analyzer 的公开界面说明](https://www.intel.com/content/www/us/en/developer/articles/troubleshooting/find-quality-issues-vpa.html) 中的帧序列、语法、选区信息和状态联动。对齐范围是 AV1 工作台的导航和信息层级；完整多编码器支持、双窗口同步分析和完整像素/预测重建仍不属于当前实现能力。

- 打开多帧文件：使用上一帧、下一帧或输入从 0 开始的帧序号跳转。时间线只渲染目标附近最多 80 帧，任意帧可通过跳转或帧分析表访问。
- 默认左侧只显示当前帧的 OBU；勾选“显示全部帧”浏览全流。输入搜索词时自动跨帧搜索，清空后恢复当前作用域。
- 点击其他帧的 OBU：时间线、帧位置和检查器应同步更新。点击帧级诊断同样应定位到正确帧，并清除阻碍定位的筛选词。
- 右侧默认展示当前选择的核心信息。点击分组标题展开 Header、编码工具或语法字段；展开状态在同类选择间保留。点击块后只显示该块信息。
- 无错误、无警告时底部诊断收起；有错误或警告时自动展开，也可手动切换。
- 结构概览优先展示帧分布与统计；引擎来源、快照与高级查询、OBU 字节分布按需展开。帧预览默认关闭 SB 网格；图层透明度和运动矢量参数位于“图层与运动矢量设置”。
- 在 1440、1024、768 和 390 像素宽度下检查菜单、帧导航和视图标签；使用 Tab、Enter、Esc 验证菜单与折叠分组。
- 快速切换文件后，前一个文件的预览不得出现在新文件中。

自动回归：`node test/gui-client.test.js` 检查实际前端脚本的事件与状态变化；模拟 DOM 不验证浏览器排版、原生文件选择对话框或 WebGL 渲染，这些仍需浏览器验收。

## media/test 真实块级回归

安装了 `build/native-v3.12.1-golden` 且存在本地媒体文件时，`test/gui-server.test.js` 会通过真实 `/api/analyze` 路由执行以下检查，而非只使用 mock worker：

- `media/test_256x256_av1.ivf`：10 帧，273 个块；
- `media/testsrc_256x256.ivf`：30 帧，2118 个块；
- `blockInspection.status` 为 `ready`，producer 为 `libaom-inspect-v1`，feature flags 为 127；
- 检查 inter 模式、运动矢量、块几何、块快照分页和 FFmpeg PNG 预览；
- 块级解析器不可用时，HTTP 仍返回基础报告及 `BLOCK_INSPECTION_FAILED` 诊断，不丢弃已解析结果。

固定版构建的额外验证：

```bash
AV1SCOPE_LIBAOM_BUILD_MANIFEST=build/native-v3.12.1-golden/libaom-build-manifest.json npm run check:libaom-release
```
