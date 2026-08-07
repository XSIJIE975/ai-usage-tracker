import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { AppSettings, ProviderSnapshot, StoredSnapshot, VaultStatus } from "../types/ipc";
import { providerModules } from "../providers";

const DEFAULT_SETTINGS: AppSettings = {
  refreshEnabled: true,
  refreshIntervalMinutes: 5,
  providers: Object.fromEntries(providerModules.map((provider) => [provider.id, true])),
};

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
      const [vaultStatus, settings, snapshots] = await Promise.all([
        invoke<VaultStatus>("vault_status"),
        invoke<AppSettings>("get_settings"),
        invoke<StoredSnapshot[]>("get_latest_snapshots"),
      ]);
      set({
        vaultStatus,
        settings: { ...DEFAULT_SETTINGS, ...settings, providers: { ...DEFAULT_SETTINGS.providers, ...settings.providers } },
        snapshots: snapshots.map((item) => toProviderSnapshot(item.payload)),
        error: null,
      });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
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
