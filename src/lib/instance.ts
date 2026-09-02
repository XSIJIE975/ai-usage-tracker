import type { ProviderInstance } from "../types/ipc";

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
