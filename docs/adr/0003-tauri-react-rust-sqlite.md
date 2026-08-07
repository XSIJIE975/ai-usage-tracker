# Use Tauri 2, React, Rust and SQLite

Status: accepted

应用采用 Tauri 2 作为跨平台桌面外壳，React/TypeScript 负责 UI，Rust 负责托盘、Vault、HTTP 与窗口生命周期，SQLite 保存设置和 Usage Snapshot。

## Considered Options

- Electron：成熟但体积和内存占用更高。
- Tauri 2 + Vue：也可以，但当前团队和组件方案更偏向 React。

## Consequences

- 安装包更小，系统资源占用更低。
- 平台能力依赖 Tauri 插件和 Rust 侧实现。
- Windows/macOS/Linux 需要分别配置系统依赖和 CI 构建。
