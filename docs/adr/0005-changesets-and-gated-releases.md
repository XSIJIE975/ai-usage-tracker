# Use Changesets with gated release builds

Status: accepted

版本和发布流程采用 Changesets 管理。`package.json` 是唯一版本源，普通 CI 与三平台打包分离，只有合并 Version Packages PR 后才触发 Tauri 发布构建。

## Considered Options

- Changesets + PR 合并触发发布：符合后续“dev 开发、PR 合入 main、main 发布”的流程，版本变更和发布构建有明确入口。
- 每次 push 到 main 都构建三平台：实现简单，但每次代码合并都会消耗大量 Actions 时长。
- 手动 tag 触发发布：发布控制明确，但需要额外维护 tag 创建步骤，自动化程度较低。

## Consequences

- 日常 `dev` 推送和合入 `main` 的 PR 只运行基础 CI。
- Changesets 自动创建或更新 Version Packages PR，合并后运行三平台打包。
- 发布 workflow 创建 `vX.Y.Z` draft release，用户在 GitHub 网页确认后发布。
- 后续新增 Provider 或 UI 功能需要按语义化版本写入 changeset。
