import { invoke } from "@tauri-apps/api/core";

import { compareVersions } from "./version";

/** 一条更新日志（与 Rust 端 ChangelogEntry 对应，commands.rs；ADR-0044） */
export interface ChangelogEntry {
  version: string;
  date: string;
  /** 该版本一段的 Markdown 原文，由 ReleaseNotes 组件渲染 */
  notes: string;
}

let cache: Promise<ChangelogEntry[]> | null = null;

/** 全量更新日志（安装包内嵌数据，新版本在前）：同一会话只拉一次，失败不缓存可重试 */
export function loadChangelog(): Promise<ChangelogEntry[]> {
  cache ??= invoke<ChangelogEntry[]>("changelog").catch((error: unknown) => {
    cache = null;
    throw error;
  });
  return cache;
}

/**
 * 启动对账：升级后首次启动要不要弹「本次更新内容」，弹哪些条目。
 * 区间 (seen, current]——seen 及之前已看过，current 是刚升级到的版本；跨版本升级
 * （如 0.1.0 → 0.5.0）时区间自然涵盖中间所有版本。同版本、降级（区间为空）不弹，
 * 返回空数组。
 *
 * seen=null 表示来源版本未知：弹窗功能之前的升级用户（库里没有已读记录，ADR-0044）
 * ——只展示 current 一条，来历不明不铺全量；调用方需先排除全新安装（不该弹的场景
 * 由 Dashboard 判定，本函数只管选条目）。
 */
export function resolveChangelogPrompt(
  seen: string | null,
  current: string,
  entries: ChangelogEntry[],
): ChangelogEntry[] {
  if (seen !== null && compareVersions(seen, current) >= 0) return [];
  if (seen === null) {
    return entries.filter((entry) => compareVersions(entry.version, current) === 0);
  }
  return entries.filter(
    (entry) =>
      compareVersions(entry.version, seen) > 0 && compareVersions(entry.version, current) <= 0,
  );
}
