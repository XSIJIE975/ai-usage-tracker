import { create } from "zustand";

export type ChangelogDialogMode = "manual" | "whats-new";

interface ChangelogDialogState {
  open: boolean;
  mode: ChangelogDialogMode;
  /** whats-new 模式的区间下界（升级前版本，不含）；null = 来源版本未知（弹窗功能
   *  之前的升级用户，只展示 toVersion 一条，ADR-0044）；manual 模式忽略 */
  fromVersion: string | null;
  /** whats-new 模式的区间上界（刚升级到的版本，含） */
  toVersion: string | null;
  openManual: () => void;
  openWhatsNew: (from: string | null, to: string) => void;
  close: () => void;
}

/** 更新日志弹窗的开关与模式：顶栏更新 icon、设置抽屉「查看更新日志」入口（manual）
 *  与启动对账（whats-new）共用同一实例（挂载在 Dashboard） */
export const useChangelogDialogStore = create<ChangelogDialogState>()((set) => ({
  open: false,
  mode: "manual",
  fromVersion: null,
  toVersion: null,
  openManual: () => set({ open: true, mode: "manual", fromVersion: null, toVersion: null }),
  openWhatsNew: (from, to) => set({ open: true, mode: "whats-new", fromVersion: from, toVersion: to }),
  close: () => set({ open: false }),
}));
