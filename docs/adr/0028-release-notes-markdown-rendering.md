# 更新说明按 Markdown 渲染

Status: accepted

## Context

设置 → 检查更新的说明区从 `latest.json` 的 `notes` 取内容，以纯文本渲染（`src/views/settings/UpdateCard.tsx:80`，`<p className="max-h-40 overflow-y-auto whitespace-pre-wrap">`）。而 `notes` 是 `scripts/fill-updater-notes.mjs:32-51` 的 `toPlainText()` 降级产物：删掉 `## 版本号` 整行、抹掉行首 `###` 与全部 `**`、删掉提交哈希链接、把 `[#12](url)` 压成 `#12`。复跑 0.7.0 段落得到的产物与线上清单逐字符一致（977 字符），加粗与 Markdown 链接 0 残留。

降级本身还不彻底：`/^###\s*/` 只匹配行首，而 `CHANGELOG.md` 里的二级子标题是缩进 2 空的 `  ### 托盘与速览`，逃过清理后残留 4 处——界面正在直接显示字面 `###`。现状是**已经坏掉的纯文本**，不是可用的纯文本。

2026-09-14 用户要求说明区支持 Markdown 渲染。核查两条前提：

- 本仓 `pnpm-lock.yaml` 搜 `markdown|remark|rehype|micromark|marked|dompurify` 零命中，`src/` 下无手写解析。项目**既没有 Markdown 解析器，也没有 prose 排版样式表**，「复用已有的 Markdown 方案」无对象可复用。
- `src-tauri/tauri.conf.json:48` 为 `"csp": null`；minisign 签名只覆盖安装包、**不覆盖 `latest.json` 本身**；且 `src-tauri/src/` 下没有任何 `on_navigation` 导航拦截。即：说明区是**未签名的远端内容，渲染进一个没有 CSP、也没有导航兜底的 webview**，清洗环节是唯一防线。

## Decision

**说明区按 Markdown 渲染；`notes` 在发布侧改为写入原始 Markdown。**

1. **发布侧**：删掉 `fill-updater-notes.mjs` 的整个 `toPlainText()`，`notes` 取该版本段落正文（去掉 `release-body.mjs:30` 为 GitHub Release 加的 `## 版本号` 包装行，界面标题已写版本号）。`###`、`**`、Markdown 链接、缩进嵌套一律原样保留。`latest.json` 的 `version` / `notes` / `pub_date` / `platforms` 字段结构不变，`notes` 仍是字符串。
2. **渲染侧**：`react-markdown@10` + `remark-gfm`（表格来自 GFM）。产物是 React 元素，不经 `dangerouslySetInnerHTML`、不生成 HTML 字符串；原始 HTML 用 `skipHtml` 丢弃，`<script>` 在结构上就进不来，安全不依赖过滤规则的完备性。实测行为有区别：**块级 HTML 整块丢弃**，而**行内 HTML 在 markdown 里被拆成「起标签 + 中间文本 + 止标签」三个节点**，丢弃标签后中间文字会作为纯文本留下（如 `<script>alert(1)</script>` 渲染出可见的 `alert(1)` 字符串）——只是可读文字，不构成注入，已有断言固定该行为。
3. **安全收窄**：`urlTransform` 只放行 `http` / `https`。库默认判定用的常量是 `safeProtocol = /^(?:https?|ircs?|mailto|xmpp)$/i`，除这几种协议外还放行相对路径（无冒号即为相对）；相对路径在桌面应用里没有「当前站点」可言，一并收掉。不放行时 `urlTransform` **返回空串**，该属性被写成 `href=""`，我们在 `components.a` 里按空值判断，**不渲染成链接**而是退化为纯文本（因此「不可点」是有明确信号可判的，不依赖库的内部行为）。图片同理，只允许 `http` / `https`，`max-w-full` + `loading="lazy"`。
4. **外链**：经 `components.a` 接管，`onClick` 一律 `preventDefault` 后调 `@tauri-apps/plugin-opener` 的 `openUrl`（用法同 `AboutCard.tsx:55`，权限 `capabilities/default.json:15` 的 `opener:default` 已对 `windows: ["*"]` 授权）。前端拦截是必需的：Rust 侧没有 `on_navigation`，不拦就会把应用界面导航走。
5. **样式**：元素级挂现有语义 Token 的 Tailwind 类（`text-fg` / `text-fg-secondary` / `border-line` / `bg-canvas` / `font-mono` 等），深浅色跟随 Token，**不新增排版样式表**。说明区可滚高度由 `max-h-40`（160px）放大到 `max-h-72`（288px）；容器元素由 `<p>` 改为 `<div>`（Markdown 会产出 `<h3>`/`<ul>`，嵌在 `<p>` 里是非法结构）。
6. **回退**：加 React error boundary，异常时退回现有纯文本渲染，并 `console.warn` 带原始错误**留痕**——依据 ADR-0024 规则 3「纯优化性操作降级为日志后继续，不阻断主流程」。定位是**防渲染层自身出意外，不是防坏 Markdown**：`react-markdown` 对畸形 Markdown 容错，任何内容都会被当成段落渲染，不会抛错，所以「解析失败」这个条件基本不可达。内容为空这一半不需要新逻辑（`useUpdateStore.ts:71` 已把空串归一为 `null`，`UpdateCard.tsx:80` 的 `{notes && ...}` 遇 `null` 不渲染）。
7. **同一次发布落地**脚本与渲染器（0.8.0）。

## Considered Options

- **不改脚本，只在前端尽力渲染**：标题在源头已被拍成裸文本（`### 新功能` → `新功能`），加粗与链接已被物理删除，需求点名的「标题 / 加粗 / 链接」三项无论前端怎么写都做不出来。
- **marked + DOMPurify**：直接依赖更少、体积更小，但产物是 HTML 字符串，必须走 `dangerouslySetInnerHTML`，安全完全押在 DOMPurify 配置上；元素样式还要另写一段 `.notes h3 {...}` 样式表，与「只用语义 Token 的 Tailwind 类」的既有口径不合。
- **手写最小解析器（零依赖）**：最贴合「避免引入冗余依赖」，但要在安全敏感处自行拼接渲染结果，且嵌套列表 / 表格 / 引用 / 行内优先级的长期维护成本最高，是三个方案里最容易出洞的一档。
- **图片只显示占位、不发起请求**：隐私最干净，但「支持图片」实际退化成了「不报错」，与用户选择不符。
- **不给异常留回退**：回退分支近乎不可达，接近于死代码；但本仓当前没有任何 error boundary，渲染层一旦出意外会让整个设置页白屏，故保留。
- **分两次发布**（0.8.0 只带渲染器，0.9.0 才改脚本）：可完全避免老程序的观感回退，但 0.8.0 自身的说明仍是降级文本，顶层小节名会被当成普通段落，功能看上去只工作了一半。

## Consequences

- 「0.7.0 老程序看 0.8.0 说明」这一跳会露出字面 `**` 与 `[](url)`——老渲染器仍是纯文本。文字一个不少，升到 0.8.0 后永久正常。
- `notes` 体积增加约 145 字节（0.7.0：2604 → 2749 字节），相对安装包可忽略，不构成取舍理由。
- 发布侧不再有「说明是纯文本」的假设：说明里若出现原始 HTML 会被 `skipHtml` 丢弃而不是显示成标签；相对路径的链接与图片不再可用。
- 新增运行时依赖 `react-markdown` + `remark-gfm`，pnpm 实测引入 **97 个包**；前端主包由 646.4 KB 增至 806.8 KB，gzip 由 209.6 KB 增至 258.7 KB（+160 KB / +49 KB gzip）。桌面应用产物随安装包本地分发，不走网络下载，因此这笔体积不构成取舍理由；`>500 kB` 的构建告警在改动前就已存在，非本次引入。
- 新增开发依赖 **3 个**：`@testing-library/react` + `@testing-library/dom` + `jsdom`。注意 `@testing-library/dom` 是 RTL 16 的必装 peer 依赖（RTL 把它移出了 `dependencies`，pnpm 的 auto-install-peers 不会代装），漏装则测试直接跑不起来。仅该测试文件用文件头 `// @vitest-environment jsdom`，不动全局测试环境（现无任何 DOM 测试基建，`vite.config.ts` 无 test 配置）。
- 说明区渲染成为安全边界：`csp` 仍为 `null`、`latest.json` 仍无签名，故「只放行 http/https」与「原始 HTML 丢弃」两条必须有单测覆盖，后续改动不得绕过。
- 顺带修掉现状缺陷：界面不再显示 4 处字面 `###`。
