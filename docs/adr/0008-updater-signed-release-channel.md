# 更新通道：Tauri Updater + GitHub Releases 签名产物

Status: accepted

应用内自动更新采用 `tauri-plugin-updater`，更新源是 GitHub Releases 上的静态清单 `latest.json`（`releases/latest/download/latest.json`），由发布 workflow 中的 `tauri-apps/tauri-action` 随安装包一并上传。更新包用 minisign 密钥对签名，公钥固化在 `tauri.conf.json`，私钥仅存开发者本机与 GitHub Secrets。

## Considered Options

- GitHub Releases 静态 `latest.json`：与现有「Version Packages PR → draft release → 手动 Publish」流程零成本衔接，无需额外托管服务。updater 插件不支持 GitHub API 原生解析，静态清单是插件直连的唯一形态。
- 自托管更新服务器（`{target}/{arch}/{current_version}` 动态端点）：可灰度、可回滚，但需要维护一个常驻服务，当前单用户规模不值得。
- MSI 继续作为 Windows 安装包：更新器对 MSI 支持存在已知缺陷（更新成功但版本未变，tauri-apps/tauri#14828），且每次更新触发 UAC 提权；NSIS 按用户安装（HKCU），更新全程静默。

## Consequences

- 手动 Publish 草稿是唯一闸门：草稿期 `releases/latest` 不解析该版本，更新通道与安装包下载同时开放、同时关闭。
- 矩阵任一平台失败时不得 Publish 该草稿：`latest.json` 的泛链会指向缺件的 Release，应废弃草稿重跑。
- macOS 构建必须包含 `app` bundle（`--bundles app,dmg`），否则不产出 `.app.tar.gz` 更新件；Windows / Linux 更新件是安装器本体（`.exe` / `.AppImage`）就地签名。
- 配置入库公钥后，本地无密钥构建会被 CLI 拒绝，需用 `pnpm tauri build --no-sign`；CI 从 Secrets 注入私钥。
- 私钥丢失即失去更新通道：只能让用户手动重装，故密钥存于仓库外并在 GitHub Secrets 双份留底。
- 鸡生蛋：首个带更新能力的版本（0.2.0）无法被更老的 0.1.0 安装自动升级到，后者必须手动重装一次；之后的版本均可自动更新。
- 后续发布不得混用 prerelease：`releases/latest` 忽略 prerelease 与草稿。
