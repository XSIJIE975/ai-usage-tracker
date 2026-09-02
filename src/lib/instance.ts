import type { ProviderInstance } from "../types/ipc";

/** 卡片主标题与告警标题共用的显示名：备注优先，留空回退供应商名 */
export function displayName(instance: ProviderInstance, providerName: string): string {
  return instance.note.trim() || providerName;
}
