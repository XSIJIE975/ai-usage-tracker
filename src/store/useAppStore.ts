import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type {
  AppSettings,
  ProviderInstance,
  ProviderKind,
  ProviderSnapshot,
  StoredSnapshot,
  VaultStatus,
} from "../types/ipc";
import { getProviderModule } from "../providers";
import { useAlertStore } from "./useAlertStore";

const DEFAULT_SETTINGS: AppSettings = {
  refreshEnabled: true,
  refreshIntervalMinutes: 5,
  alertsEnabled: true,
  quickPanelShortcut: "Alt+KeyU",
  quickAutoHide: true,
  resetTimeDisplay: "relative",
  interfaceLanguage: "auto",
};

function normalizeSettings(settings: Partial<AppSettings>): AppSettings {
  return { ...DEFAULT_SETTINGS, ...settings };
}

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

/** 实例 patch：字段缺省=不改，threshold null=清除 */
export interface InstancePatch {
  note?: string;
  autoRefresh?: boolean;
  pinned?: boolean;
  threshold?: number | null;
}

interface AppStore {
  vaultStatus: VaultStatus | null;
  settings: AppSettings;
  instances: ProviderInstance[];
  /** loadInitial 是否完成（instances/snapshots 已就位）；初始刷新必须等它，避免空列表跑空循环 */
  initialLoaded: boolean;
  snapshots: ProviderSnapshot[];
  loading: boolean;
  refreshingInstances: Record<string, boolean>;
  error: string | null;
  lastRefreshedAt: number;
  /** 手动全局刷新序号（顶栏「刷新」）；统计页据此联动刷新。自动定时刷新不递增。 */
  manualRefreshTick: number;
  loadInitial: () => Promise<void>;
  reloadInstances: () => Promise<void>;
  refreshAll: (options?: { auto?: boolean }) => Promise<void>;
  refreshInstance: (instanceId: string) => Promise<void>;
  addInstance: (
    providerId: ProviderKind,
    note: string,
    credentials?: Record<string, string>,
    options?: { autoRefresh?: boolean; threshold?: number | null },
  ) => Promise<ProviderInstance>;
  updateInstance: (id: string, patch: InstancePatch) => Promise<void>;
  removeInstance: (id: string) => Promise<void>;
  reorderInstances: (orderedIds: string[]) => Promise<void>;
  saveInstanceCredentials: (id: string, credentials: Record<string, string | null>) => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  setVaultStatus: (status: VaultStatus) => void;
  clearError: () => void;
}

/** 行的 instance_id 是唯一事实（旧版快照 payload 里没有该字段） */
function toSnapshot(item: StoredSnapshot): ProviderSnapshot {
  return { ...item.payload, instanceId: item.instance_id };
}

function vaultBlockedReason(status: VaultStatus | null): string | null {
  if (!status) return "凭据库状态未知";
  if (status.unlocked) return null;
  if (status.needsMigration) return "凭据库待迁移，请在设置中完成一次性迁移";
  if (status.keychainLost) return "本机设备密钥丢失，请在设置中重新录入凭据";
  return "Credential Vault 未解锁";
}

function fallbackSnapshot(instance: ProviderInstance, error: unknown): ProviderSnapshot {
  const module = getProviderModule(instance.providerId);
  return {
    instanceId: instance.id,
    providerId: instance.providerId,
    providerName: module?.name ?? instance.providerId,
    status: "error",
    updatedAt: Date.now(),
    message: error instanceof Error ? error.message : String(error),
    lines: [],
  };
}

export const useAppStore = create<AppStore>((set, get) => ({
  vaultStatus: null,
  settings: DEFAULT_SETTINGS,
  instances: [],
  initialLoaded: false,
  snapshots: [],
  loading: false,
  refreshingInstances: {},
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
      const [settings, snapshots, instances] = await Promise.all([
        invokeWithTimeout<AppSettings>("get_settings", 4_000),
        invokeWithTimeout<StoredSnapshot[]>("get_latest_snapshots", 4_000),
        invokeWithTimeout<ProviderInstance[]>("list_instances", 4_000),
      ]);
      set({
        settings: normalizeSettings(settings),
        instances,
        initialLoaded: true,
        snapshots: snapshots.map(toSnapshot),
        error: null,
      });
    } catch (error) {
      set({
        settings: DEFAULT_SETTINGS,
        instances: [],
        initialLoaded: true,
        snapshots: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  reloadInstances: async () => {
    try {
      const instances = await invoke<ProviderInstance[]>("list_instances");
      set({ instances });
    } catch {
      // 留旧值兜底，下一轮事件/聚焦会再同步
    }
  },

  // 刷新一律置 loading：手动、聚焦回填、自动定时刷新都要让顶栏与卡片按钮联动转起来，
  // 否则自动刷新全程无可见反馈，用户只能靠更新时间变化才能察觉
  refreshAll: async (options) => {
    set({ loading: true, error: null });
    if (!options?.auto) {
      set((state) => ({ manualRefreshTick: state.manualRefreshTick + 1 }));
    }
    const { instances, vaultStatus } = get();
    const blockedReason = vaultBlockedReason(vaultStatus);
    if (blockedReason) {
      set({ loading: false, error: blockedReason });
      return;
    }

    const targets = options?.auto ? instances.filter((instance) => instance.autoRefresh) : instances;
    const results: ProviderSnapshot[] = [];
    for (const instance of targets) {
      const module = getProviderModule(instance.providerId);
      if (!module) continue;
      try {
        const snapshot = await module.fetch(instance);
        results.push(snapshot);
        await invoke("save_snapshot", { instanceId: instance.id, payload: snapshot });
      } catch (error) {
        results.push(fallbackSnapshot(instance, error));
      }
    }

    let refreshedAt = Date.now();
    try {
      const stored = await invoke<StoredSnapshot[]>("get_latest_snapshots");
      refreshedAt = Date.now();
      set({
        snapshots: stored.map(toSnapshot),
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
    // 刷新落库后评估阈值告警（成功与失败的快照都参与，失败会解除告警态）
    const observed = new Map(get().instances.map((instance) => [instance.id, instance]));
    for (const result of results) {
      const instance = observed.get(result.instanceId);
      if (!instance) continue;
      useAlertStore.getState().observe(instance, result, get().settings);
    }
    emitRefreshCompleted(refreshedAt);
  },

  refreshInstance: async (instanceId) => {
    const instance = get().instances.find((item) => item.id === instanceId);
    const module = instance ? getProviderModule(instance.providerId) : undefined;
    if (!instance || !module || get().refreshingInstances[instanceId]) return;
    const blockedReason = vaultBlockedReason(get().vaultStatus);
    if (blockedReason) {
      set({ error: blockedReason });
      return;
    }

    set((state) => ({
      refreshingInstances: { ...state.refreshingInstances, [instanceId]: true },
      error: null,
    }));

    let result: ProviderSnapshot;
    try {
      result = await module.fetch(instance);
    } catch (error) {
      result = fallbackSnapshot(instance, error);
    }

    let refreshedAt = Date.now();
    try {
      await invoke("save_snapshot", { instanceId, payload: result });
      const stored = await invoke<StoredSnapshot[]>("get_latest_snapshots");
      refreshedAt = Date.now();
      set({
        snapshots: stored.map((item) => item.payload),
        error: null,
        lastRefreshedAt: refreshedAt,
      });
    } catch (error) {
      refreshedAt = Date.now();
      set({
        snapshots: [...get().snapshots.filter((item) => item.instanceId !== instanceId), result],
        error: error instanceof Error ? error.message : String(error),
        lastRefreshedAt: refreshedAt,
      });
    } finally {
      set((state) => ({
        refreshingInstances: { ...state.refreshingInstances, [instanceId]: false },
      }));
      useAlertStore.getState().observe(instance, result, get().settings);
      emitRefreshCompleted(refreshedAt);
    }
  },

  addInstance: async (providerId, note, credentials, options) => {
    const instance = await invoke<ProviderInstance>("create_instance", {
      providerId,
      note,
      credentials: credentials ?? undefined,
      autoRefresh: options?.autoRefresh ?? true,
      threshold: options?.threshold ?? null,
    });
    await get().reloadInstances();
    return instance;
  },

  updateInstance: async (id, patch) => {
    await invoke("update_instance", { id, patch });
    set((state) => ({
      instances: state.instances.map((instance) => {
        if (instance.id !== id) return instance;
        return {
          ...instance,
          note: patch.note !== undefined ? patch.note : instance.note,
          autoRefresh: patch.autoRefresh !== undefined ? patch.autoRefresh : instance.autoRefresh,
          pinned: patch.pinned !== undefined ? patch.pinned : instance.pinned,
          threshold: patch.threshold !== undefined ? patch.threshold : instance.threshold,
        };
      }),
    }));
  },

  removeInstance: async (id) => {
    await invoke("delete_instance", { id });
    set((state) => ({
      instances: state.instances.filter((instance) => instance.id !== id),
      snapshots: state.snapshots.filter((snapshot) => snapshot.instanceId !== id),
    }));
  },

  reorderInstances: async (orderedIds) => {
    const previous = get().instances;
    const byId = new Map(previous.map((instance) => [instance.id, instance]));
    const next = orderedIds
      .map((id, index) => {
        const instance = byId.get(id);
        return instance ? { ...instance, sortOrder: index } : null;
      })
      .filter((instance): instance is ProviderInstance => instance !== null);
    // 乐观更新，失败回滚并由事件重载收敛
    set({ instances: next });
    try {
      await invoke("reorder_instances", { orderedIds });
    } catch (error) {
      set({ instances: previous });
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  saveInstanceCredentials: async (id, credentials) => {
    await invoke("vault_save_credentials", { instanceId: id, credentials });
  },

  saveSettings: async (settings) => {
    set({ settings });
    await invoke("save_settings", { settings });
    // 广播到所有窗口（含本窗口）：快速面板等常驻窗口靠它实时跟随界面语言等设置变化
    void emit("settings-changed", settings);
  },

  setVaultStatus: (vaultStatus) => set({ vaultStatus }),
  clearError: () => set({ error: null }),
}));
