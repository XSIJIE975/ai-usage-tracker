import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
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
  loadInitial: () => Promise<void>;
  refreshAll: (showLoading?: boolean) => Promise<void>;
  refreshProvider: (providerId: string) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  setVaultStatus: (status: VaultStatus) => void;
  clearError: () => void;
}

function toProviderSnapshot(payload: ProviderSnapshot): ProviderSnapshot {
  return payload;
}

export const useAppStore = create<AppStore>((set, get) => ({
  vaultStatus: null,
  settings: DEFAULT_SETTINGS,
  snapshots: [],
  loading: false,
  refreshingProviders: {},
  error: null,

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

  refreshAll: async (showLoading = true) => {
    if (showLoading) set({ loading: true, error: null });
    const { settings, vaultStatus } = get();
    if (!vaultStatus?.unlocked) {
      set({ loading: false, error: "Credential Vault 未解锁" });
      return;
    }

    const results: ProviderSnapshot[] = [];
    for (const provider of providerModules) {
      if (!settings.providers[provider.id]) continue;
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

    try {
      const stored = await invoke<StoredSnapshot[]>("get_latest_snapshots");
      set({
        snapshots: stored.map((item) => toProviderSnapshot(item.payload)),
        loading: false,
        error: null,
      });
    } catch (error) {
      set({
        snapshots: results,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  refreshProvider: async (providerId) => {
    const provider = providerModules.find((item) => item.id === providerId);
    if (!provider || get().refreshingProviders[providerId]) return;
    if (!get().vaultStatus?.unlocked) {
      set({ error: "Credential Vault 未解锁" });
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

    try {
      await invoke("save_snapshot", { providerId, payload: result });
      const stored = await invoke<StoredSnapshot[]>("get_latest_snapshots");
      set({
        snapshots: stored.map((item) => toProviderSnapshot(item.payload)),
        error: null,
      });
    } catch (error) {
      set({
        snapshots: [...get().snapshots.filter((item) => item.providerId !== providerId), result],
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      set((state) => ({
        refreshingProviders: { ...state.refreshingProviders, [providerId]: false },
      }));
    }
  },

  saveSettings: async (settings) => {
    set({ settings });
    await invoke("save_settings", { settings });
  },

  setVaultStatus: (vaultStatus) => set({ vaultStatus }),
  clearError: () => set({ error: null }),
}));
