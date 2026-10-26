# ADR-0044: 更新日志内嵌数据链与双场景弹窗

状态：已接受　日期：2026-10-26　关联：ADR-0005、ADR-0028、ADR-0040

## 背景

更新体验此前只有一条窄通道：updater 从 `latest.json` 取回**单个新版本**的 notes（ADR-0028），设置抽屉「检查更新」卡片渲染它。顶栏「新版本 vX」徽标点击后打开设置抽屉并滚动定位到该卡片——这条链路依赖抽屉打开动画与异步内容（迁移卡、说明图）稳定后才算得准滚动位置，实践中不可靠（定位时内容高度仍在变，且 `getElementById(...)?.` 静默吞掉找不到锚点的情形）。

用户要的是三件事：更新提示与顶栏图标风格统一；点开就能看新版本内容并直接安装；跨版本升级（如 0.1.0 → 0.5.0）能看到**中间所有版本**的变更历史。第三件事 updater 给不了——`latest.json` 只有最新一版。

## 决策

1. **更新日志数据随安装包内嵌，离线可读**。发版流水线在 `version:packages` 链尾运行 `scripts/build-changelog.mjs`，把 changesets 生成的 `CHANGELOG.md` 转成 `src-tauri/changelog.json`（每版本 `{version, date, notes}`，notes 为该段 Markdown 原文，与 release-body 同口径，由 ReleaseNotes 渲染），随 Version Packages PR 入库；Rust 侧 `include_str!` 编译期内嵌，`changelog` 命令返回全量。tauri 构建的 `beforeBuildCommand` 再跑一次作幂等兜底（date 从库里的 JSON 回读，不会因重建漂移）。**本地开发不跑任何生成**——`pnpm dev` / `pnpm build` 都不触发，生成只属于发版流水线。

2. **数据边界接受「旧包无新版日志」**。内嵌日志只含打包时为止的版本，因此两个场景各用各的数据：
   - **更新提示时（未安装）**：弹窗顶部区块展示 updater notes（新版本单条）+ 本包内嵌历史；跳过的中间版本缺失属预期，不在此时联网拉 GitHub 补齐。
   - **升级完成后首次启动**：新包内嵌全量日志，对比库里记录的「已读版本」按 `(已读, 当前]` 区间聚合，跨版本升级自然涵盖中间所有版本——这是唯一离线完整的时间点，自动弹窗选在这里。
   「已读版本」存 Rust DB（settings 表 `changelog_seen_version` 行）而非 localStorage：WebView2 的 localStorage 有撕裂中毒史（主题持久化已为此入过库），单行字符串不值得再信一次。

3. **顶栏更新提示改为 brand 色图标按钮，点击直接弹「更新日志」弹窗**；弹窗内提供安装操作（与设置抽屉「检查更新」卡片共用 `UpdateInstallButton`，同一 `useUpdateStore` 状态源），不经过设置抽屉。原「徽标 → 开抽屉 → 滚动定位检查更新卡片」链路整条退役：安装动作一步直达后，这条脆弱的定位链路没有存在理由。设置抽屉卡片保留为第二入口，并新增「查看更新日志」按钮打开同一弹窗。

4. **弹窗形态用 Dialog 而非 Sheet**，作为 §6.9「长内容走 Sheet」的唯一例外：更新日志是纯查看内容，无提交动作，点 X 即走；占满整幅 Sheet 的阅读成本大于居中弹窗内部滚动（`max-w-xl`、`max-h-[85vh]`）。

## 后果

- `SettingsFocus` / `UPDATE_CARD_ANCHOR` / `settings-update-card` 锚点链路删除；ADR-0040 后果节描述的「徽标开抽屉定位」设计被本决策取代。
- `changelog.json` 提交入库是硬要求：`include_str!` 编译期读文件，不入库则本地 `cargo check` 直接失败；它同时是 dev 模式的数据源与 date 回读锚点。
- date 的语义是「该版本首次进入 changelog.json 的日期」：历史版本（0.14.0 及以前）在首次生成时统一记生成日，无法追溯真实发版日；0.15.0 起随 Version Packages PR 定死为发版准备日。
- 弹窗的手动入口在浏览器预览（非 Tauri）下拿不到内嵌数据，显示空态文案；启动自动弹对账有 `isTauri` 守卫，浏览器预览不触发。
- 降级安装（已读版本高于当前版本）区间为空，不弹窗只回写记录——弹一个「从高到低」的更新内容没有意义。
