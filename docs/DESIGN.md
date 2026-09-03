# 设计规范（Design System）

本文档是 AI 用量助手界面设计的**单一事实来源**。所有新页面、新组件必须遵守本规范；  
禁止在业务代码中硬编码颜色、圆角、阴影，只能使用语义化 Token 与基础组件。

- Token 定义：`src/styles.css`（Tailwind v4 `@theme`）
- 基础组件：`src/components/ui/`
- 主题切换：`src/lib/theme.ts`

---

## 1. 设计原则

1. **简洁优先**：信息层级靠字重与灰度表达，不靠堆砌颜色；每屏最多一个主按钮。
2. **语义化**：只用语义 Token（`fg` / `surface` / `brand` / `success`…），不用具体色号  
   （`slate-500`、`#fff` 等一律禁止出现在组件代码中）。
3. **双主题同源**：浅色/深色共用一套语义 Token，写一次即可同时适配两个主题。
4. **克制的动效**：只做 120–200ms 的颜色、宽度过渡，不做花哨动画。

## 2. 主题

- 默认跟随系统（`prefers-color-scheme`），可在 设置 → 外观 锁定浅色/深色。
- 实现：`<html data-theme="dark">` 覆盖 Token；未设置时媒体查询兜底。
- 新增强调色只需改 `src/styles.css` 中 `:root` / `[data-theme="dark"]` / 媒体查询三处。

## 3. 色彩 Token

### 背景层级（由底到顶）

| Token       | 工具类            | 用途                  |
| ----------- | -------------- | ------------------- |
| `canvas`    | `bg-canvas`    | 应用底层背景              |
| `surface`   | `bg-surface`   | 卡片、输入框等浮层           |
| `surface-2` | `bg-surface-2` | 凹陷区域、分段选择器底、hover 底 |

### 文字层级

| Token          | 工具类                 | 用途       |
| -------------- | ------------------- | -------- |
| `fg`           | `text-fg`           | 标题、关键数值  |
| `fg-secondary` | `text-fg-secondary` | 正文、表单标签  |
| `fg-muted`     | `text-fg-muted`     | 辅助说明、占位符 |

### 描边

| Token         | 工具类                           | 用途        |
| ------------- | ----------------------------- | --------- |
| `line`        | `border-line` / `divide-line` | 默认描边、分隔线  |
| `line-strong` | `border-line-strong`          | 虚线空态、强调描边 |

### 品牌色（鸢尾紫 Iris）

- `brand` / `brand-hover` / `brand-active`：主按钮、开关开启、进度条、聚焦描边。
- `brand-soft`：品牌色浅底（徽标、选中底）。`brand-fg`：品牌色底上的文字。
- 品牌色阶 `iris-50 … iris-900` 仅用于渐变 Logo 等装饰场景（`from-iris-400 to-iris-600`）。

### 状态色

每组三个 Token：**`{solid}`（图标/进度条）· `{x}-soft`（底色）· `{x}-soft-fg`（底上文字）**

| 状态 | 工具类示例                                                   |
| -- | ------------------------------------------------------- |
| 成功 | `text-success` `bg-success-soft` `text-success-soft-fg` |
| 警告 | `text-warning` `bg-warning-soft` `text-warning-soft-fg` |
| 危险 | `text-danger` `bg-danger-soft` `text-danger-soft-fg`    |
| 信息 | `text-info` `bg-info-soft` `text-info-soft-fg`          |

> 带透明度描边用 `border-danger/20` 这类修饰符，不要新造颜色。

### 图表色板

图表序列使用 **16 色**数据可视化色阶：`chart-1 … chart-16`（`fill-chart-N` / `stroke-chart-N` / `bg-chart-N`）。
浅色/深色已分别调校，禁止在图表内写死色号。

> **取色唯一入口是 `components/charts/palette.ts`**：
>
> - Tailwind 只扫描源码中的完整类名，**禁止动态拼接**（`fill-chart-${i}` 不会生成任何样式）；  
>   必须使用静态数组 `CHART_FILLS / CHART_BGS / CHART_STROKES`。
> - 同一模型在所有图表中颜色一致：通过 `modelColor(modelName)` 全局缓存取色。  
>   颜色源自 CSS 变量（`--chart-1..16`），主题切换时自动失效重读。
> - 模型颜色由模型名经稳定哈希映射到 16 色色板，避免人工注册表中的重复映射；  
>   超出 16 色板时用 HSL 兜底（S/L 从 `--chart-hash-s/l` 读取）。
> - 图表组件通过 `useEffectiveTheme()` 订阅主题变化，触发重渲染并重读 CSS 变量色值。

### 图例与标签

- **图例必须放在 ECharts 绘图区外部**（React 自定义图例），任何情况下不得遮挡图表主体。
- **禁止使用 scroll 分页图例**；外部图例使用 flex-wrap 自动换行，响应式自然适配。
- **自定义图例必须可交互并与图表数据联动（筛选）**:
  - React `selected` 集合（`useChartLegend`）是显隐的**唯一数据源**；
  - 点击图例项时，图表组件**直接按 `selected` 过滤 `series` / `data` 数组**再交给 ECharts，
    被取消勾选的系列从图表中**物理移除**（堆叠柱重算、饼图扇区消失、tooltip 只显示可见项），
    行为与 ECharts 原生图例筛选完全一致；
  - **不要**依赖 `dispatchAction('legendToggleSelect')` 或 `option.legend.selected` 这类在隐藏图例
    （`show:false`）下不可靠的方案去隐藏数据；
  - 悬停图例项**仅更新 activeName**（影响图例自身加粗 + tooltip 高亮），**不 dispatchAction 改变图表**，
    避免图例 hover 被误视为图表数据变化；
  - 鼠标离开整个图例区域时清除 activeName；
  - 已隐藏的图例项置灰并带删除线；最近一次被选中/悬停的系列标记为 active。
- **必须绑定的 ECharts 事件**：
  - `mouseover`：鼠标悬停图表元素时同步 activeName，让 tooltip 按当前系列高亮；
  - `mouseout`：鼠标离开图表元素时清除 activeName。
- **tooltip 高亮规范**：
  - active 系列置顶；
  - active 系列的名称与数值均使用**该系列自身颜色**显示并加粗；
  - 非 active 项整体降低透明度（约 0.55），名称使用 `fg-secondary`，数值使用 `fg-muted`，形成明显视觉差异。
- 堆叠柱状图：
  - x 轴日期标签默认隐藏，tooltip 首行显示完整日期；
  - 添加 `dataZoom`（inside）支持横向缩放/滑动，避免数据点过于拥挤；
  - `barMaxWidth` 限制为 28px，保证柱子清晰可辨。
- 环形占比图：图例统一在图表下方水平排列，饼图居中，中心合计随显隐状态实时更新。
- 新增图表组件时必须通过 `useResizeObserver` 监听容器尺寸，保证窗口缩放后布局正确。

### 数据表格滚动

- `DataTable` 支持 `maxHeight` 属性：传入后启用内部垂直滚动，表头 `sticky top-0` 固定。
- 使用历史等大数据量表格必须设置 `maxHeight`，避免整页滚动。
- 分页使用 `Pagination` 组件（上一页/页码/下一页），替代"加载更多"按钮。

### 自动刷新（两级门控）

- 自动刷新由两级开关控制：**自动刷新总开关**（设置 → 通用）是总闸；**实例自动刷新**（各实例配置弹窗）决定单个实例是否参与定时刷新，受总开关门控。
- 总览定时刷新走 `refreshAll(false, { auto: true })`，按实例开关过滤；手动「刷新」始终拉取所有实例。
- 手动全局刷新同时覆盖统计抽屉：`refreshAll` 手动路径递增 `manualRefreshTick`，统计模块经 `useGlobalRefresh(callback, instanceId)` 感知并同步刷新；组件卸载期间发生的全局刷新，重挂载时补刷一次，不停留在旧缓存。
- 统计抽屉的刷新按钮与 `RefreshOverlay` 跟随全局刷新状态（`loading` 或该实例的 `refreshingInstances`），与总览卡片行为一致。
- 统计模块通过 `useAutoRefresh(callback, instance)` 接入，同时读取总开关、刷新间隔与该实例的开关。
- 刷新时保留旧数据，叠加 `RefreshOverlay`（半透明遮罩 + 旋转图标），不整体替换区域。
- `useStatsFetch` 返回 `{ state, isRefreshing }`：首次加载走全屏 loading；已有数据刷新走局部 overlay。

### 阴影与焦点环

- `shadow-card`：卡片默认；`shadow-pop`：悬浮窗、解锁卡片、hover 强调。
- 焦点环统一 `focus-visible:ring-2 ring-focus-ring`（基础组件已内置，业务代码无需重复）。

## 4. 字体与排版

- 字体栈：`--font-sans`（Inter + PingFang SC + 雅黑）；密钥/代码用 `font-mono`。
- 字号只使用三档：**正文 `text-sm`(14px) · 次级 `text-[13px]` · 辅助 `text-xs`(12px)**；  
  页面主标题 `text-[15px] font-semibold`，大标题（解锁页）`text-lg`。
- **所有数值必须等宽数字**：加 `tnum` 类（`font-variant-numeric: tabular-nums`）。

## 5. 圆角与间距

- 圆角：`rounded-md`(8px) 按钮/输入框/头像；`rounded-lg`(12px) 卡片；`rounded-xl`(16px) 悬浮窗。
- 卡片内边距统一 `p-5`（紧凑模式 `p-4`）；页面边距 `p-6`。
- 卡片内部模块之间用 `<Separator />`，不要同时叠加「大留白 + 分隔线」。

## 6. 组件用法

### 按钮 `ui/button`

`variant: primary | secondary | outline | ghost | destructive`；`size: default | sm | lg | icon | icon-sm`。

- 一个视口最多一个 `primary`；工具区用 `ghost`；危险操作才用 `destructive`。

### 图标按钮 `ui/icon-button`

纯图标操作（刷新/关闭等），必须传 `aria-label` 与 `title`。

### 卡片 `ui/card`

`Card / CardHeader / CardTitle / CardDescription / CardContent`，所有内容区块的默认容器。

### 徽标 `ui/badge`

`variant: neutral | brand | success | warning | danger | info`，只用于状态表达（如「已配置」）。

### 分段选择器 `ui/segmented`

同层级 2–4 个互斥视图切换（总览/设置、主题模式）。选项过多请改用其他导航。

### 空状态 `ui/empty-state`

`icon + title + description + action`，虚线描边容器，所有空列表/未解锁场景统一使用。

### 进度条 `ui/progress`

默认 brand 色；用量 ≥70% 传 `barClassName="bg-warning"`，≥90% 传 `"bg-danger"`。

### 表单 `ui/input` `ui/label` `ui/switch`

- 输入框聚焦态已内置 brand 描边 + 焦点环。
- 开关开启 = brand，关闭 = line-strong，无需自定义颜色。

### 标签页 `ui/tabs`

下划线式 Tabs，用于**页面级模块切换**（如统计页的供应商模块）。  
与 Segmented 的分工：Tabs 切换整页内容模块；Segmented 切换小范围互斥选项。

### 下拉选择 `ui/select` 与可搜索选择器 `ui/command`

少量固定选项的筛选器仍用原生 `<select>` 封装（键盘可达、系统级交互），如密钥/模型切换。  
**需要搜索、或选项带图标与描述的选择器用 Command（cmdk）+ Popover**（如「添加供应商」）：
搜索框置顶、模糊匹配、键盘可导航，选项行 = 图标 + 名称 + 一句描述。
自定义日期范围用两个 `type="date"` 原生输入框，样式参照统计抽屉。

### 数据表格 `ui/data-table`

`DataTable / THead / Th / TBody / Tr / Td`：

- 表头 `xs + fg-muted`；数值列右对齐（`align="right"`，自动带 `tnum`）。
- 行 hover 为 `surface-2/50`；行分隔 `line/70`，末行无线。
- ID/模型名等用 `font-mono text-xs`。

### 统计卡 `ui/stat-card`

`label(xs/muted) + value(xl/semibold/tnum) + hint(xs/muted)`，配合 `grid-cols-2 xl:grid-cols-4` 使用。

## 6.5 图表 `components/charts/`

图表基于 ECharts 渲染，图例统一用 React 外部自定义图例实现：

- `StackedBars`：堆叠柱状图，y 轴 5 档网格，图例在图表下方以 React 自定义图例展示，支持点击显隐；tooltip 对 active 系列置顶加粗。
- `Donut`：环形占比图，中心合计 + 下方水平 React 图例（百分比 + 数值），合计随显隐实时更新。
- 序列色通过 `modelColor(name)` 统一取自 chart-1..16，保证跨图表一致。
- 轴数值用 `formatCompact`（lib/utils），精确值用 `formatInt`。

## 6.6 统计抽屉模块约定 `views/stats/`

- 统计从顶层页签下沉到卡片触发的右侧抽屉：`StatsSheet` 按 `instance.providerId` 挂载
  `DeepSeekStats` / `OpenCodeStats` / `GlmStats`，标题 = 实例显示名 + 供应商名；
  每个供应商一个独立文件，新增供应商 = 在 `StatsSheet` 注册映射 + 新建模块文件，互不改对方代码。
- 同一模块可能同时服务同种类的多个实例：**usageCache 的 key 必须以 instanceId 为前缀**，
  避免两个实例互相串数据。
- 筛选工具条统一放在模块顶部的 `Card p-4` 内，控件带 `Label`。

## 6.7 图标规范

- **应用图标**：唯一来源 `docs/design/icons/app-icon.svg`（鸢尾紫渐变圆角底板 + 白色仪表盘），  
  界面内用 `src/components/BrandIcon.tsx` 引用，不另绘 Logo。  
  重新生成全尺寸：`node scripts/generate-icons.mjs`（输出 PNG 16–512、ICO、Store 方标）。
- **界面图标**：统一使用 lucide-react，`strokeWidth` 默认 2，尺寸只用 `h-3.5 w-3.5`（小）/ `h-4 w-4`（中）/ `h-5 w-5`（大）。
- **状态指示**：成功/警告/危险图标颜色用对应状态 Token，不用灰色表达状态。

## 6.8 设置页与实例配置弹窗约定

- 设置视图只保留「通用」：自动刷新总开关、刷新间隔（预设档位 `Select`，所有实例共用）、
  外观、快速面板、关于与更新；顶部承载 `MigrationCard` 与设备密钥丢失横幅。
- 实例的凭据表单、自动刷新开关与告警阈值全部在配置弹窗 `views/instances/InstanceDialog.tsx`
  （新建与编辑共用；备注 → 按 kind 渲染的凭据区 → 自动刷新与阈值 → 取消/保存）。
  编辑时凭据回填明文，凭据库未解锁/待迁移时显示 `notice` 并禁用保存。
- 删除实例走卡片 ⋯ 菜单 + `DeleteInstanceDialog`（AlertDialog）二次确认。
- 开关类设置即时保存并显示短暂「已保存」反馈（`useSaveFlash` / `SavedHint`）；弹窗内保存为显式按钮。
- 「关于与更新」卡片（`views/settings/UpdateCard.tsx`）：显示当前版本、检查更新、变更说明与下载进度（`ui/progress`），错误可重试；状态机在 `store/useUpdateStore.ts`，仅已安装运行时可用（开发构建禁用并提示）。
- 发现新版本时主窗口顶栏出现「新版本 vX」徽标按钮（outline + brand 描边），点击进入设置视图完成安装。

## 6.9 弹层：Dialog / Sheet / AlertDialog / Popover

三者的分工：

| 组件 | 用途 | 形态 |
| --- | --- | --- |
| `ui/dialog` | 表单类内容（实例配置） | 居中，`max-w-lg`，内容超高时内部滚动（`max-h-[85vh]`） |
| `ui/sheet` | 详情类内容（实例统计） | 右侧滑入，全高，宽 `min(960px,100vw)` |
| `ui/alert-dialog` | 破坏性操作二次确认（删除实例） | 居中，`max-w-md`，确认按钮 `destructive` |
| `ui/popover` | 轻量非模态弹出（+ `ui/command` 组成可搜索选择器） | 锚定触发器，`w-72` 左右 |

- 弹层遮罩统一 `bg-canvas/60 backdrop-blur-[1px]`；容器 `border-line` + `shadow-pop`。
- 内容结构：头部（标题 `text-[15px] font-semibold` + 描述）/ 滚动区 / 页脚（取消在左、主操作在右，
  主按钮一个视口一个 `primary`）。
- 所有弹层必须可用 Esc 关闭且带焦点环；标题/描述供屏幕阅读器（Radix Title/Description）。

## 6.10 可排序卡片网格（总览）

- 网格列：`repeat(auto-fill, minmax(min(100%,340px), 1fr))` + `justify-center`，间距 `gap-4`；
  移除总览容器的最大宽度（设置视图保留 `max-w-3xl`）。720px 视口 1 列、980px 2 列、1180px 3 列。
- 顺序的唯一事实：`pinned DESC, sort_order ASC, created_at ASC`（`selectOrderedInstances`），
  快速面板跟随同一顺序但不可拖拽、无统计按钮。
- 拖拽用 @dnd-kit：卡片头部左侧 GripVertical 手柄（hover/聚焦显现）、`PointerSensor`
  带 `activationConstraint: { distance: 4 }` 避免吞掉卡内点击、`KeyboardSensor` 键盘可达、
  `DragOverlay` 浮起副本；拖拽结束 `reorder_instances` 落库并广播 `instances-changed`。
- 卡片头部 = 手柄 + 头像 + 标题（备注，空则供应商名）+ 副标题（供应商名 + 更新时间，
  备注为空时只显示更新时间）+ 状态徽标 + 刷新 + ⋯ 菜单（置顶/编辑配置/删除）；
  底部一行「查看统计」outline 按钮（`needs_config` / `error` 状态禁用并带 title 说明）。
- 有重置时间的额度行，重置倒计时文本可点击，在「相对倒计时 / 具体时刻」间切换
  （偏好存全局设置 `resetTimeDisplay`，主窗口与快速面板同步，默认相对）。
- 异常态不直接展示原始报错：卡片上只放一行按内容轻分类的友好占位（凭据无效或已过期 /
  网络连接失败 / 获取用量失败，`lib/error-hint.ts`）+「详情」入口，点开 `ErrorDetailsDialog`
  查看并可复制完整原文；`needs_config` 保留原文（短且可操作）并在主窗口附「去配置」入口。
- 快速面板卡片为 `compact` 模式：不渲染手柄、菜单、统计按钮。

## 6.11 快速面板窗口行为

- 顶栏双击打开主窗口；单击拖动顶栏移动面板（自管 mousedown，不用 `data-tauri-drag-region`，
  确保双击行为确定可控）。顶栏按钮上的双击不触发。
- 高度随内容自适应：`useFitWindowHeight` 观测内容根高度并 `setSize(380, clamp(h, 240, 工作区×80%))`；
  三条纪律——120ms 防抖、|Δ|≤8px 不调用、顶栏拖动期间跳过。宽度固定 380。

## 7. 动效

- 时长：`duration-fast`(120ms) 用于 hover 变色；`duration-normal`(200ms) 用于宽度/阴影。
- 加载：统一使用旋转细环  
  `h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand`。

## 8. 新页面检查清单

- [ ] 未出现任何硬编码色号或 `slate/gray/red-…` 等具体色阶
- [ ] 数值带 `tnum`；图标按钮带 `aria-label`
- [ ] 浅色、深色两个主题下都看过一眼
- [ ] 空态/加载/错误三态均有处理，且复用 `EmptyState` 与规范加载环
- [ ] 图表序列色只用 `chart-1..16`；表格用 `DataTable` 组件族；图例必须在 ECharts 外部
- [ ] 图表颜色通过 `modelColor()` 取值，禁止 ECharts option 内写死 hex
- [ ] 图例序列 >4 时用 `type: "scroll"`；`grid.bottom` 按行数动态计算
- [ ] 大数据量表格设 `maxHeight`，分页用 `Pagination` 组件
- [ ] 统计页接入 `useAutoRefresh`；刷新走局部 overlay，不全屏替换
- [ ] 页面级模块切换用 `Tabs`，小范围选项用 `Segmented`，筛选用 `Select`
