import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { AppSettings, ProviderSnapshot, StoredSnapshot, VaultStatus } from "../types/ipc";
import { providerModules } from "../providers";

const DEFAULT_SETTINGS: AppSettings = {
  refreshEnabled: true,
  refreshIntervalMinutes: 5,
  providers: Object.fromEntries(providerModules.map((provider) => [provider.id, true])),
};

function waitForTauriRuntime(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise<void>((resolve, reject) => {
    const check = () => {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      if (internals) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Tauri 运行时尚未就绪"));
        return;
      }
      window.setTimeout(check, 100);
    };
    check();
  });
}

function emitRefreshCompleted(refreshedAt: number) {
  void emit("refresh-completed", { refreshedAt }).catch(() => undefined);
}

async function invokeWithTimeout<T>(command: string, timeoutMs: number): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${command} 加载超时`)), timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => invoke<T>(command)),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

async function invokeWithRetry<T>(command: string, timeoutMs = 4_000, attempts = 3): Promise<T> {
  await waitForTauriRuntime();

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await invokeWithTimeout<T>(command, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 300));
      }
    }
  }
  throw lastError;
}

interface AppStore {
  vaultStatus: VaultStatus | null;
  settings: AppSettings;
  snapshots: ProviderSnapshot[];
  loading: boolean;
  refreshingProviders: Record<string, boolean>;
  error: string | null;
  lastRefreshedAt: number;
  /** 手动全局刷新序号（顶栏「刷新」）；统计页据此联动刷新。自动定时刷新不递增。 */
  manualRefreshTick: number;
  loadInitial: () => Promise<void>;
  refreshAll: (showLoading?: boolean, options?: { auto?: boolean }) => Promise<void>;
  refreshProvider: (providerId: string) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  setVaultStatus: (status: VaultStatus) => void;
  clearError: () => void;
}

function toProviderSnapshot(payload: ProviderSnapshot): ProviderSnapshot {
  return payload;
}

function vaultBlockedReason(status: VaultStatus | null): string | null {
  if (!status) return "凭据库状态未知";
  if (status.unlocked) return null;
  if (status.needsMigration) return "凭据库待迁移，请在设置中完成一次性迁移";
  if (status.keychainLost) return "本机设备密钥丢失，请在设置中重新录入凭据";
  return "Credential Vault 未解锁";
}

export const useAppStore = create<AppStore>((set, get) => ({
  vaultStatus: null,
  settings: DEFAULT_SETTINGS,
  snapshots: [],
  loading: false,
  refreshingProviders: {},
  error: null,
  lastRefreshedAt: 0,
  manualRefreshTick: 0,

  loadInitial: async () => {
    try {
      const vaultStatus = await invokeWithRetry<VaultStatus>("vault_status");
      set({ vaultStatus, error: null });
    } catch (error) {
      set({
        vaultStatus: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      const [settings, snapshots] = await Promise.all([
        invokeWithTimeout<AppSettings>("get_settings", 4_000),
        invokeWithTimeout<StoredSnapshot[]>("get_latest_snapshots", 4_000),
      ]);
      set({
        settings: { ...DEFAULT_SETTINGS, ...settings, providers: { ...DEFAULT_SETTINGS.providers, ...settings.providers } },
        snapshots: snapshots.map((item) => toProviderSnapshot(item.payload)),
        error: null,
      });
    } catch (error) {
      set({
        settings: DEFAULT_SETTINGS,
        snapshots: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  refreshAll: async (showLoading = true, options) => {
    if (showLoading) set({ loading: true, error: null });
    if (!options?.auto) {
      set((state) => ({ manualRefreshTick: state.manualRefreshTick + 1 }));
    }
    const { settings, vaultStatus } = get();
    const blockedReason = vaultBlockedReason(vaultStatus);
    if (blockedReason) {
      set({ loading: false, error: blockedReason });
      return;
    }

    const results: ProviderSnapshot[] = [];
    for (const provider of providerModules) {
      if (options?.auto && !settings.providers[provider.id]) continue;
      try {
        const snapshot = await provider.fetch();
        results.push(snapshot);
        await invoke("save_snapshot", { providerId: provider.id, payload: snapshot });
      } catch (error) {
        results.push({
          providerId: provider.id,
          providerName: provider.name,
          status: "error",
          updatedAt: Date.now(),
          message: error instanceof Error ? error.message : String(error),
          lines: [],
        });
      }
    }

    let refreshedAt = Date.now();
    try {
      const stored = await invoke<StoredSnapshot[]>("get_latest_snapshots");
      refreshedAt = Date.now();
      set({
        snapshots: stored.map((item) => toProviderSnapshot(item.payload)),
        loading: false,
        error: null,
        lastRefreshedAt: refreshedAt,
      });
    } catch (error) {
      refreshedAt = Date.now();
      set({
        snapshots: results,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
        lastRefreshedAt: refreshedAt,
      });
    }
    emitRefreshCompleted(refreshedAt);
  },

  refreshProvider: async (providerId) => {
    const provider = providerModules.find((item) => item.id === providerId);
    if (!provider || get().refreshingProviders[providerId]) return;
    const blockedReason = vaultBlockedReason(get().vaultStatus);
    if (blockedReason) {
      set({ error: blockedReason });
      return;
    }

    set((state) => ({
      refreshingProviders: { ...state.refreshingProviders, [providerId]: true },
      error: null,
    }));

    let result: ProviderSnapshot;
    try {
      result = await provider.fetch();
    } catch (error) {
      result = {
        providerId: provider.id,
        providerName: provider.name,
        status: "error",
        updatedAt: Date.now(),
        message: error instanceof Error ? error.message : String(error),
        lines: [],
      };
    }

    let refreshedAt = Date.now();
    try {
      await invoke("save_snapshot", { providerId, payload: result });
      const stored = await invoke<StoredSnapshot[]>("get_latest_snapshots");
      refreshedAt = Date.now();
      set({
        snapshots: stored.map((item) => toProviderSnapshot(item.payload)),
        error: null,
        lastRefreshedAt: refreshedAt,
      });
    } catch (error) {
      refreshedAt = Date.now();
      set({
        snapshots: [...get().snapshots.filter((item) => item.providerId !== providerId), result],
        error: error instanceof Error ? error.message : String(error),
        lastRefreshedAt: refreshedAt,
      });
    } finally {
      set((state) => ({
        refreshingProviders: { ...state.refreshingProviders, [providerId]: false },
      }));
      emitRefreshCompleted(refreshedAt);
    }
  },

  saveSettings: async (settings) => {
    set({ settings });
    await invoke("save_settings", { settings });
  },

  setVaultStatus: (vaultStatus) => set({ vaultStatus }),
  clearError: () => set({ error: null }),
}));
