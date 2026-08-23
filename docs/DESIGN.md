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

| Token | 工具类 | 用途 |
| --- | --- | --- |
| `canvas` | `bg-canvas` | 应用底层背景 |
| `surface` | `bg-surface` | 卡片、输入框等浮层 |
| `surface-2` | `bg-surface-2` | 凹陷区域、分段选择器底、hover 底 |

### 文字层级

| Token | 工具类 | 用途 |
| --- | --- | --- |
| `fg` | `text-fg` | 标题、关键数值 |
| `fg-secondary` | `text-fg-secondary` | 正文、表单标签 |
| `fg-muted` | `text-fg-muted` | 辅助说明、占位符 |

### 描边

| Token | 工具类 | 用途 |
| --- | --- | --- |
| `line` | `border-line` / `divide-line` | 默认描边、分隔线 |
| `line-strong` | `border-line-strong` | 虚线空态、强调描边 |

### 品牌色（鸢尾紫 Iris）

- `brand` / `brand-hover` / `brand-active`：主按钮、开关开启、进度条、聚焦描边。
- `brand-soft`：品牌色浅底（徽标、选中底）。`brand-fg`：品牌色底上的文字。
- 品牌色阶 `iris-50 … iris-900` 仅用于渐变 Logo 等装饰场景（`from-iris-400 to-iris-600`）。

### 状态色

每组三个 Token：**`{solid}`（图标/进度条）· `{x}-soft`（底色）· `{x}-soft-fg`（底上文字）**

| 状态 | 工具类示例 |
| --- | --- |
| 成功 | `text-success` `bg-success-soft` `text-success-soft-fg` |
| 警告 | `text-warning` `bg-warning-soft` `text-warning-soft-fg` |
| 危险 | `text-danger` `bg-danger-soft` `text-danger-soft-fg` |
| 信息 | `text-info` `bg-info-soft` `text-info-soft-fg` |

> 带透明度描边用 `border-danger/20` 这类修饰符，不要新造颜色。

### 图表色板

图表序列只允许按顺序循环使用 `chart-1 … chart-6`（`fill-chart-N` / `stroke-chart-N` / `bg-chart-N`），
浅深色已分别调校，禁止在图表内写死色号。语义顺序：主系列用 `chart-1`（iris 品牌色），其后依次分配。

> **取色唯一入口是 `components/charts/palette.ts`**：
> - Tailwind 只扫描源码中的完整类名，**禁止动态拼接**（`fill-chart-${i}` 不会生成任何样式）；
>   必须使用静态数组 `CHART_FILLS / CHART_BGS / CHART_STROKES`。
> - 同一模型在所有图表中颜色一致：通过 `modelColorIndex(model)` 全局注册表取色
>   （已知模型固定索引，未知模型按名称哈希兜底）。新增模型时在注册表补一行。

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

### 下拉选择 `ui/select`
原生 `<select>` 封装（键盘可达、系统级交互），用于筛选器、密钥/模型切换等。
禁止自绘弹出层下拉。自定义日期范围用两个 `type="date"` 原生输入框，样式参照统计页。

### 数据表格 `ui/data-table`
`DataTable / THead / Th / TBody / Tr / Td`：
- 表头 `xs + fg-muted`；数值列右对齐（`align="right"`，自动带 `tnum`）。
- 行 hover 为 `surface-2/50`；行分隔 `line/70`，末行无线。
- ID/模型名等用 `font-mono text-xs`。

### 统计卡 `ui/stat-card`
`label(xs/muted) + value(xl/semibold/tnum) + hint(xs/muted)`，配合 `grid-cols-2 xl:grid-cols-4` 使用。

## 6.5 图表 `components/charts/`

纯 SVG 实现（零依赖），hover 用 `<title>` 提供明细提示：
- `StackedBars`：堆叠柱状图，y 轴 5 档 nice-number 网格，图例在下方，序列色自动循环 chart-1..6。
- `Donut`：环形占比图，中心合计 + 右侧图例（百分比 + 数值）。
- 坐标轴/标签文字统一 `fill-fg-muted text-[10px]`，基线 `stroke-line-strong`，网格 `stroke-line`。
- 轴数值用 `formatCompact`（lib/utils），精确值用 `formatInt`。

## 6.6 统计页模块约定 `views/stats/`

- `StatsView` 只做 Tabs 注册与模块挂载；每个供应商一个独立文件（如 `DeepSeekStats.tsx`），
  新增供应商 = 注册 Tab + 新建模块文件，互不改对方代码。
- 筛选工具条统一放在模块顶部的 `Card p-4` 内，控件带 `Label`。
- 占位数据集中在 `src/data/mockStats.ts`（确定性伪随机），对接真实接口时只替换该文件。

## 6.7 图标规范

- **应用图标**：唯一来源 `docs/design/icons/app-icon.svg`（鸢尾紫渐变圆角底板 + 白色仪表盘），
  界面内用 `src/components/BrandIcon.tsx` 引用，不另绘 Logo。
  重新生成全尺寸：`node scripts/generate-icons.mjs`（输出 PNG 16–512、ICO、Store 方标）。
- **界面图标**：统一使用 lucide-react，`strokeWidth` 默认 2，尺寸只用 `h-3.5 w-3.5`（小）/ `h-4 w-4`（中）/ `h-5 w-5`（大）。
- **状态指示**：成功/警告/危险图标颜色用对应状态 Token，不用灰色表达状态。

## 7. 动效

- 时长：`duration-fast`(120ms) 用于 hover 变色；`duration-normal`(200ms) 用于宽度/阴影。
- 加载：统一使用旋转细环
  `h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand`。

## 8. 新页面检查清单

- [ ] 未出现任何硬编码色号或 `slate/gray/red-…` 等具体色阶
- [ ] 数值带 `tnum`；图标按钮带 `aria-label`
- [ ] 浅色、深色两个主题下都看过一眼
- [ ] 空态/加载/错误三态均有处理，且复用 `EmptyState` 与规范加载环
- [ ] 图表序列色只用 `chart-1..6`；表格用 `DataTable` 组件族
- [ ] 页面级模块切换用 `Tabs`，小范围选项用 `Segmented`，筛选用 `Select`
