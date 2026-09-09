# GUI Keyboard and Accessibility Contract v1

状态：Implementation complete / browser visual evidence pending（2026-08-13）。

## 用户路径

- `Ctrl/Cmd+O` 打开本地码流；在非输入控件上按 `/` 聚焦结构筛选；
- 视图 tabs 使用 Left/Right/Home/End，自动激活字节、帧、概览、Trace 或对比视图；
- 帧时间线使用 Left/Right/Home/End；选择帧后同步 OBU、预览和检查器；
- OBU 列表、语法字段和诊断使用 Up/Down/Home/End；Enter/Space 由原生 button 激活；
- Snapshot/GC 使用原生 modal dialog，Escape、焦点圈和标题关联由浏览器语义提供。

动态单选集合使用 roving `tabindex`，因此 Tab 只进入当前项，方向键在集合内移动。选中状态分别通过 `aria-selected` 或 `aria-pressed` 暴露；主视图区使用 `tabpanel`/`aria-labelledby`，分析忙碌状态同步到 workspace `aria-busy` 和 live status。

## 视觉降级

- 所有键盘目标有统一 `:focus-visible` 高对比轮廓；
- 1023px 和 700px 两级布局解除原 1024px 最小宽度，在高 DPI/浏览器缩放下重排面板；
- `prefers-reduced-motion` 将 spinner/transition 缩短为单次近零动画；
- `forced-colors` 为选中项、severity 和统计恢复系统轮廓/边框；
- 窄视口诊断隐藏独立 range 列，但消息和 severity 保留，完整 range 仍可在选择后的检查视图读取。

## 自动化证据与限制

`public/keyboard-navigation.js` 是无 DOM 的确定性索引函数，单测覆盖方向、wrap、Home/End、方向限制和空集合。GUI asset test 核对 tabpanel、dialog label、busy state、responsive/reduced-motion/forced-colors 规则及 wiring。完整 Node API/GUI 测试继续覆盖分析、预览、Snapshot、查询、Derived/Overlay 和缓存维护。

这些证据证明语义和导航代码存在并通过自动化契约，不证明真实浏览器中的视觉位置、焦点顺序、屏幕阅读器播报或 200% 缩放无裁切。本环境浏览器列表为空且禁止本地监听端口，因此以下验收仍必须在目标环境执行：

1. Chrome/Edge/内置浏览器：键盘走完打开→帧→OBU→字段→诊断→导出；
2. Windows Narrator 与 Linux Orca 各完成一次关键路径；
3. 100%、150%、200% 缩放和 1024/1440/4K DPI 截图；
4. reduced motion、forced colors、暗/亮主题截图；
5. 10 万 Block primitive 的真实 WebGL P50/P95 FPS 和拾取延迟。
