# Glossary

## 基础 CI

在 `dev` 分支推送或向 `main` 发起 PR 时运行的轻量检查流程。它只执行前端测试、前端构建和 Rust 测试，不生成安装包。

## Version Packages PR

由 Changesets 自动创建或更新的发布 PR。合并该 PR 会更新版本号、CHANGELOG 和 Tauri 配置，并成为打包流程的触发入口。

## Draft Release

发布 workflow 创建的暂存 GitHub Release。安装包上传完成后仍为草稿，需要用户在 GitHub 网页手动发布。

## 版本源

`package.json` 中的版本号是唯一版本源。发布脚本会在 Changesets 更新版本后同步 `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 和 `src-tauri/tauri.conf.json`。
