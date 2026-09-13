# 刷新产物的跨窗口收敛（快照收敛）

Status: accepted

修正 ADR-0016 的一处边界遗漏：「主窗口是托盘呈现的唯一写入方」只约束了**谁写托盘**，没约束**写入方读到的快照从哪里来**。主窗口的内存快照只在启动时读库一次，面板刷新落库的数据没有任何回流路径，于是「打开面板后刷新出的新数据」到不了托盘数字指示器（macOS 无 tooltip，数字是唯一常驻的用量表达面）。

## Context

三个窗口（main / quick / glance）各持一份独立的 zustand store（webview 隔离），跨窗口状态分三类，前两类已有回流机制，快照没有：

| 状态 | 回流机制 | 现状 |
| --- | --- | --- |
| 设置 | `settings-changed`（主窗口保存后广播，各窗口 setState） | 有 |
| 实例 | `instances-changed`（Rust 发出，各窗口 reloadInstances） | 有 |
| 快照 | 无 | `refresh-completed` 只带 `refreshedAt`，各窗口仅用它对齐倒计时基准 |

2026-09-10 代码核对（数据流事实）：

- 托盘呈现的唯一写入方 = 主窗口 `useTraySync`（`src/views/Dashboard.tsx:356`）→ `update_tray_meter`（全仓唯一调用点 `src/hooks/use-tray-sync.ts:180`）；它读的是主窗口自己的 `snapshots`。
- 主窗口内存快照的来源：`src/views/MainWindow.tsx:11` 挂载时 `loadInitial()` 读一次库；此后只有它自己的 `refreshAll` 会写入（`Dashboard.tsx` 的 `refresh-completed` 监听只更新 `remoteRefreshedAt`）。
- 面板刷新：`src/hooks/use-panel-window.ts:53` `syncFromBackend()` → 自己 webview 的 store + 写库；唤起事件每次都走**全量**刷新（`refreshAll()` 无参数 = 手动语义 = 全部实例，含关掉「供应商自动刷新」的实例）。
- 极性反转的副作用：面板刷新广播 `refresh-completed` → 主窗口 `lastRefreshedAt` 前移 → 下一次定时刷新的 delay 被重置为**完整间隔** → 打开一次面板，托盘数字反而被推后一轮才可能更新。
- 对称地，主窗口刷新后两扇面板也不重读快照，面板同样停在旧值（直到被唤起或自行刷新）。

诉求（用户 2026-09-10）：打开快速面板 / 速览面板后刷新出的数据、以及定时刷新（自动刷新总开关与「供应商自动刷新」门控下的）结果，都要反映到托盘数字指示器上。

## Decision

**托盘数字是「最新落库快照」的纯函数：任一窗口完成刷新后，所有窗口（含主窗口）以最新落库快照为准重新求值托盘呈现。收口的是数据源，不是写入权——托盘写入方仍是主窗口。**

1. **收敛机制 = 信号 + 重读事实源**：新增 store 动作 `reloadSnapshots()`（只读 `get_latest_snapshots`，不复用 `loadInitial` 的三连读）；各窗口在收到 `refresh-completed` 时更新倒计时基准并重读快照。事件**不携带**快照 payload。
2. **DB 是快照事实源**：跨窗口传播一律以落库结果为权威，内存快照只是投影。刷新流程保持「先落库、后广播」，广播后任何窗口读到的都包含本轮结果。部分刷新（`refreshAll({auto:true})` 只覆盖开了「供应商自动刷新」的实例）也能正确收敛——读到的是**各实例的最新行**，而不是本轮结果集，未参与本轮的实例拿到的是它自己上一次的落库值。
3. **可见性门控**：隐藏中的面板不重读（不可见 webview 不吃数据），其陈旧由唤起事件兜底（`syncFromBackend` 先 `loadInitial` 再刷新）。主窗口不设门控——它承载托盘写入，必须常读。
4. **托盘呈现侧要求「数据不变则不重绘」**（必要条件，不是可选优化）：`tray_scheme::apply()` 加呈现指纹，仅在 icon / tooltip / title 实际变化时调用对应 setter；`ScaleFactorChanged` 只对 main 窗口响应。理由：收敛让「打开面板」变成一次真实的托盘求值，若呈现层无幂等保护，值没变也会整项重建重绘——用户看到的仍是「数字白闪一下」（tray-icon 0.24.2 的每个 setter 都重建状态项：`set_icon` 走 PNG 编码 + 新建 NSImage + `setImagePosition`，`set_title` 走 `setTitle`，两者末尾都调 `update_dimensions()` → `setFrame`）。同批修正：tray-icon 0.24.2 的 `set_title_inner` 内部是 `if let Some(title)`，`set_title(None)` 是**空操作**，必须传空串才能清掉「用量环 → 默认 / 用量柱」切换后残留的旧数字。

## Considered Options

- **面板直接写托盘（第二写入方）**：否决。双写入方竞态——两个来源各自推选例结果，数字会在两次刷新之间反复跳；选例 / 层序 / 钉选逻辑还得在两个窗口重复实现。
- **事件携带快照 + 接收方合并**：否决。定时刷新是部分刷新，整体替换会抹掉未参与本轮刷新的实例快照；要正确必须引入按 `updatedAt` 的单调合并规则与跨窗口 payload 契约，复杂度与收益不匹配。
- **托盘呈现下沉 Rust，直接从 DB 投影**：最彻底的方向——托盘成为持久化状态的纯投影，不再依赖任何 webview 的内存快照，ADR-0016 的「webview 必须常驻」约束也随之解除；但需把候选判定 / 选例 / 层序 / 告警态全部移植到 Rust，而告警态目前只活在前端内存里（`useAlertStore`，边沿触发 + 冷却 + 通知副作用）。本轮不做，留作后续演进。

## Consequences

- 「打开面板 → 托盘数字跟着变」成为预期行为；数字代表的实例可能因此换人（自动选例重算），而 macOS 无 tooltip 无法提示「这是谁的数」——要稳定只能钉选。
- **抓取频率问题会变得更显眼**：面板唤起仍走全量刷新（非 auto），三个窗口均可发起抓取且无互斥——打开面板与主窗口定时器到点叠加时，同一实例会被抓两次。本 ADR 不改抓取语义，记为后续项（Rust 侧按实例做 in-flight 去重，或收口为单一抓取者）。
- 每次刷新新增每可见窗口一次 `get_latest_snapshots` IPC（快照仅 lines，量级 KB）。发起方自身也会收到广播（Tauri `emit` 语义为 all targets），若它刚在 `refreshAll` 内读过库，这次属重复读——实现时可由 payload 附发起方标签跳过（可选优化，不承载正确性）。
- `refresh-completed` 的语义从「倒计时基准对齐」扩展为「快照事实源已更新」：各窗口的处理从「只更新 `lastRefreshedAt`」变为「更新基准 + 重读快照」。新增窗口接入时必须同时挂这两件事，并入 ADR-0016 的跨窗口事件契约清单。
