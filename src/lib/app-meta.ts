/** 应用在 GitHub 上的仓库地址：关于卡入口与更新日志的版本发布链接共用同一来源 */
export const REPO_URL = "https://github.com/XSIJIE975/ai-usage-tracker";

/** 某个版本的 GitHub Release 页（发布 tag 固定为 `v<版本号>`，见 release.yml） */
export function releaseTagUrl(version: string): string {
  return `${REPO_URL}/releases/tag/v${version}`;
}
