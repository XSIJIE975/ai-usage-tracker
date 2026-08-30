import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateStoreState {
  status: UpdateStatus;
  version: string | null;
  notes: string | null;
  currentVersion: string | null;
  downloadedBytes: number;
  contentLength: number | null;
  error: string | null;
  loadCurrentVersion: () => Promise<void>;
  check: (options?: { silent?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
}

let pendingUpdate: Update | null = null;

/** 仅已安装的桌面运行时支持更新；开发构建与浏览器预览不可用。 */
export const updateSupported = (): boolean => isTauri() && !import.meta.env.DEV;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const useUpdateStore = create<UpdateStoreState>()((set, get) => ({
  status: "idle",
  version: null,
  notes: null,
  currentVersion: null,
  downloadedBytes: 0,
  contentLength: null,
  error: null,

  loadCurrentVersion: async () => {
    if (get().currentVersion) return;
    try {
      set({ currentVersion: await getVersion() });
    } catch {
      // 版本号仅作展示，获取失败不进入错误态
    }
  },

  check: async (options) => {
    const { status } = get();
    if (status === "checking" || status === "downloading" || status === "ready") return;
    const silent = options?.silent === true;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      if (update === null) {
        pendingUpdate = null;
        set({ status: "up-to-date", version: null, notes: null });
        return;
      }
      pendingUpdate = update;
      set({
        status: "available",
        version: update.version,
        notes: update.body?.trim() || null,
        downloadedBytes: 0,
        contentLength: null,
      });
    } catch (error) {
      pendingUpdate = null;
      if (silent) {
        // 静默检查失败不打扰用户（如网络不可达、尚未发布任何 Release）
        console.warn("后台检查更新失败：", errorMessage(error));
        set({ status: "idle" });
        return;
      }
      set({ status: "error", error: `检查更新失败：${errorMessage(error)}` });
    }
  },

  downloadAndInstall: async () => {
    const update = pendingUpdate;
    if (!update || get().status === "downloading") return;
    set({ status: "downloading", downloadedBytes: 0, contentLength: null, error: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          set({ contentLength: event.data.contentLength ?? null });
        } else if (event.event === "Progress") {
          set((state) => ({ downloadedBytes: state.downloadedBytes + event.data.chunkLength }));
        }
      });
      set({ status: "ready" });
      // Windows 由 NSIS 安装器自行重启应用，此处主要覆盖 macOS / Linux
      await relaunch();
    } catch (error) {
      set({ status: "error", error: `更新安装失败：${errorMessage(error)}` });
    }
  },
}));
