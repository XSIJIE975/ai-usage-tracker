import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GripHorizontal, RefreshCw, Settings, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { ProviderCard } from "../components/ProviderCard";
import { cn } from "../lib/utils";

export function QuickWindow() {
  const {
    vaultStatus,
    snapshots,
    loadInitial,
    refreshAll,
    refreshProvider,
    refreshingProviders,
    loading,
  } = useAppStore();
  const [ready, setReady] = useState(false);

  const syncFromBackend = useCallback(async () => {
    await loadInitial();
    if (useAppStore.getState().vaultStatus?.unlocked) {
      await refreshAll(false);
    }
  }, [loadInitial, refreshAll]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      await syncFromBackend();
      if (disposed) return;
      setReady(true);

      const window = getCurrentWindow();
      const unlistenFocus = await window.onFocusChanged(({ payload: focused }) => {
        if (focused) void syncFromBackend();
      });
      const unlistenVault = await listen("vault-status-changed", () => void syncFromBackend());
      const unlistenCredentials = await listen("credentials-changed", () => void syncFromBackend());
      const unlistenQuickShown = await listen("quick-shown", () => void syncFromBackend());

      if (disposed) {
        unlistenFocus();
        unlistenVault();
        unlistenCredentials();
        unlistenQuickShown();
        return;
      }

      unlisteners.push(unlistenFocus, unlistenVault, unlistenCredentials, unlistenQuickShown);
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [syncFromBackend]);

  async function openMain() {
    await invoke("open_main_window");
  }

  async function hideQuick() {
    await invoke("hide_quick_window");
  }

  const anyProviderRefreshing = Object.values(refreshingProviders).some(Boolean);

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
      <header
        data-tauri-drag-region
        className="flex h-12 shrink-0 items-center justify-between border-b border-slate-100 bg-slate-50 px-3"
      >
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <GripHorizontal className="h-4 w-4 text-slate-400" />
          <span className="text-sm font-semibold text-slate-800">AI 用量助手</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refreshAll(true)}
            disabled={loading || anyProviderRefreshing}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200 disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={openMain}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200"
            title="打开主窗口"
          >
            <Settings className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={hideQuick}
            className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-200"
            title="隐藏"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-slate-50 p-3">
        {!ready ? (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">加载中...</div>
        ) : !vaultStatus?.unlocked ? (
          <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center">
            <p className="text-sm text-slate-600">Credential Vault 未解锁</p>
            <Button size="sm" onClick={openMain}>
              打开主窗口解锁
            </Button>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center">
            <p className="text-sm text-slate-600">还没有用量数据</p>
            <Button size="sm" onClick={() => void refreshAll(true)}>
              立即刷新
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {snapshots.map((snapshot) => (
              <ProviderCard
                key={snapshot.providerId}
                snapshot={snapshot}
                compact
                refreshing={loading || refreshingProviders[snapshot.providerId]}
                onRefresh={() => void refreshProvider(snapshot.providerId)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
