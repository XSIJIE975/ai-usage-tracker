import type { ProviderInstance, ProviderKind, ProviderSite } from "../types/ipc";

/**
 * 种类 → 可选站点集（ADR-0031）：多站供应商的单一判据。弹窗要不要出「站点」下拉、
 * 卡片要不要出站点徽标，都从这里问，不散落 `kind === "xxx"` 的硬判断。
 * 只登记多站种类；未登记的种类按单站处理（实例 site 走缺省 china，界面不出站点痕迹），
 * 后续供应商接双站只加一行。
 */
const PROVIDER_SITES: Partial<Record<ProviderKind, ProviderSite[]>> = {
  qoder: ["china", "international"],
  workbuddy: ["china", "international"],
};

export function providerSites(kind: ProviderKind): ProviderSite[] {
  return PROVIDER_SITES[kind] ?? [];
}

/** 该种类是否需要区分站点（决定下拉与徽标要不要出现） */
export function hasMultipleSites(kind: ProviderKind): boolean {
  return providerSites(kind).length > 1;
}

/** 站点的界面短名（徽标与下拉共用；带域名的长标签在各供应商模块里） */
export const SITE_LABELS: Record<ProviderSite, string> = {
  china: "中国站",
  international: "国际站",
};

/** 卡片主标题与告警标题共用的显示名：备注优先，留空回退供应商名 */
export function displayName(instance: ProviderInstance, providerName: string): string {
  return instance.note.trim() || providerName;
}

/** 网格顺序的唯一事实：置顶优先，其次持久化顺序，最后按创建时间稳定排列 */
export function selectOrderedInstances(instances: ProviderInstance[]): ProviderInstance[] {
  return [...instances].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.createdAt - b.createdAt;
  });
}
