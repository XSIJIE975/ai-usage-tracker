# ADR-0047: 灵动岛常驻胶囊窗口

状态：已接受　日期：2026-11-14　关联：ADR-0016、ADR-0019、ADR-0022、ADR-0023、ADR-0026

## 背景

借鉴开源项目岛仔 Daozai（github.com/Renly1994/xiaotang-daozai，MIT，Rust+egui）的灵动岛机制，为应用增加屏幕顶部常驻的额度氛围面：平时收起为胶囊（时钟 + 最紧额度环 + 告警点），鼠标悬停驻留展开为完整行列表，离开收起；与托盘速览互补——速览按需弹出，岛常驻可见，数据同源（同一快照与告警投影）不同呈现。

岛仔的机制在 egui/Win32 上成立，搬进 Tauri/WebView2 有一处架构性差异：岛仔用固定画布 + `SetWindowRgn` 控制可见区域、`WM_NCHITTEST`→`HTTRANSPARENT` 做命中区外点击穿透；而 WebView2 是子 HWND，鼠标消息直接进子窗口，父窗口 subclass 拦不到。

## 决策

**1. 固定画布永不 resize，展开/收起是画布内 DOM 形变。** 窗口固定 460×340 逻辑点（即展开态最大占位），透明背景。展开/收起由前端弹簧动画驱动 morph 容器的宽高/圆角/内容交叉淡入——对应岛仔「SetWindowRgn 只改区域不动窗口」的设计动机：避开 WebView2 逐帧 resize 的重排掉帧。透明窗口必须自绘圆角与底色（`bg-surface/90`），与不透明窗口「系统圆角勿自绘」的既有结论不冲突。

**2. 展开判定与点击穿透归 Rust 控制器，前端只负责视觉。** 独立线程轮询 `app.cursor_position()`（收起且无驻留 50ms，驻留/展开/动画期 16ms），驱驻留状态机（悬停 200ms 展开、离开 120ms 收起，参数对齐岛仔）；命中区（胶囊/面板矩形外扩边距，胶囊命中区向上延伸到画布顶）在 Rust 按常量计算。穿透用 `set_ignore_cursor_events` 整窗切换近似 HTTRANSPARENT：命中区外整窗穿透，光标进入命中区、展开态与切换动画期（450ms 窗口）保持可交互；状态去重后只在变化时调用窗口 API。事件 `island-expanded` / `island-collapsed` 通知前端跑动画，展开判定先解除穿透再发事件。

**3. 几何由控制器独占，不进 `panel_window::PANEL_LABELS`。** 定位 = 主显示器工作区顶部水平居中（物理像素，monitor scale 换算），每 1s 兜底校验纠偏（覆盖 DPI/分辨率/主屏变化，对齐岛仔 placement_at 模式）。`ensure_on_screen` 的工作区钳制与本定位互相打架，故不接入；岛窗口 `focusable: false`（永不抢焦点，点击不激活），`skipTaskbar` + `alwaysOnTop` + `shadow: false`。

**4. 数据接入复用速览面板的窗口基建，新增 `persistent` 模式。** `usePanelWindow({ persistent: true })`：跳过失焦自动隐藏与 Esc 收起（岛永不获焦，两者无意义），`panelVisible` 恒真使快照收敛（ADR-0019）照常回流；自动刷新由岛按 `islandEnabled` 自行门控——岛的 webview 在禁用时仍存活，不该驱动抓取（ADR-0023）。胶囊环复用 `UsageRing`、面板行复用 `GlanceRows`、数据推导复用 `buildGlanceInstances`。

**5. 展开动画用 JS 弹簧（`src/lib/spring.ts`，移植岛仔 anim.rs 的二阶阻尼 + 子步积分），刻意不用 CSS transition。** 本机 WebView2 恒报 `prefers-reduced-motion: reduce`，CSS 侧让步会让岛永远没有动画（styles.css `.panel-enter` 同类先例）；rAF 循环直接写 DOM、settled 即停，空闲零开销。

**6. 默认关闭 opt-in，开关走 invoke-then-save。** `islandEnabled` 存 settings blob（db.rs 逐键补默认），设置卡先 `set_island_enabled`（Rust 起停窗口与控制线程）成功后才落设置，失败不写库、开关弹回。静默启动（`--silent`）不拦岛：岛是 opt-in 的常驻面不是弹窗。macOS 透明启用 `macos-private-api`（自分发不走 App Store，无副作用）。

## 后果

- 状态机/命中矩形/定位公式/穿透决策全部是纯函数，Rust 单测锁定；弹簧数学与帧率无关性前端单测锁定。
- 窗口永不获焦的代价：岛上无文本输入（纯展示 + 按钮），键盘交互留给主窗口与快速面板。
- 全屏应用/游戏会被岛覆盖——已知 MVP 限制，见「后续」。
- 悬停展开的判定依赖整窗穿透切换：切换瞬间存在极小概率点击竞态（一次点击被吞），展开判定先切 ignore 再发事件已把窗口压到最窄。

## 后续（本期明确不做）

拖动换位（水平比例持久化 + 展开面板不越屏的 clamp）、前台切换自动收起（`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`）、全屏应用自动隐藏、告警横幅投影、侧边停靠、毛玻璃（WebView2 无系统模糊，需 DWM acrylic 或半透明底色近似）、面板行/卡切换。
