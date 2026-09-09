# M0 实现卡：结构索引参考切片

## 用户问题

编码工程师需要先可靠回答“文件里有哪些帧和 OBU、每个单元位于哪个字节范围、输入在哪里损坏”，然后才能继续做帧头解释和块级可视化。

## 初始范围

- 识别 IVF 与裸 low-overhead OBU 输入；
- 建立 IVF frame index；
- 解析 OBU header、extension header、LEB128 payload size；
- 输出版本化、确定性的 JSON 报告；
- 对截断、非法保留位、错误长度和未知边界输出结构化诊断；
- 通过 Node.js 内置测试冻结行为。

## 初始非范围

- MP4/Matroska/WebM demux；
- Sequence Header 与 Frame Header payload 语法；
- 熵解码、像素与 BlockRecord；
- SQLite、Worker 隔离、Tauri/React UI；
- 将本参考实现作为最终生产核心。

## 数据来源与 provenance

- IVF header/frame layout：结构参考解析器；
- OBU header/size：结构参考解析器；
- 不使用 FFmpeg/libaom 推导字段；
- 报告固定标记 `av1scope-m0-node-reference` 与 parser version。

## 契约影响

冻结 `AnalysisReport v1`、`FrameRecord v1`、`ObuRecord v1` 和 `Diagnostic v1` 的最小 JSON 形状。Rust 迁移可增加可选字段，但不应更改现有字段含义。

## 测试样本

- 测试内合成的合法裸 OBU；
- 测试内合成的单帧 IVF；
- 截断 LEB128、截断 payload、非法 forbidden/reserved bit；
- IVF 声明帧数与实际帧数不一致。

测试资产由代码生成，不包含第三方或私有码流。

## 验收标准

- 合法合成样本的所有 frame/OBU ranges 精确匹配；
- 相同输入产生字节一致的 JSON；
- 损坏输入不导致未捕获异常或无限循环；
- 输出文件使用临时文件 + rename，默认拒绝覆盖；
- `npm run ci` 在 Node.js 20/22/24 与 Linux/Windows 通过。

## 风险与降级

- 当前环境缺少 Rust 工具链，因此实现仅作为 M0 reference；不得被桌面产品直接视为生产安全边界。
- 裸流 OBU 没有 size field 时无法确定下一个边界：停止当前流并输出 `OBU_SIZE_FIELD_REQUIRED`。
- IVF frame 内无 size field 的 OBU 消耗剩余 sample，并输出 info provenance 诊断。

## Owner / Reviewer

- Owner：AV1Scope Core Team
- Required reviewers：AV1 Parser、Runtime/Security、QA

## Ready Gate

状态：**Ready → In Progress**（2026-08-12）

## 后续扩展（2026-08-13）

技术探针已越过初始范围，新增 MP4/WebM sample offset、完整 Sequence Header、Frame Header 参考关系、Metadata、FFmpeg 帧预览/亮度统计、本地 GUI、可取消的分析 Worker 与 Block Overlay consumer。完整证据与环境缺口见 `M0_STATUS.md`；本卡保留初始 scope，避免篡改历史 Ready Gate。
