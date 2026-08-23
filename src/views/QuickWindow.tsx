import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Gauge, Lock, RefreshCw, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { BrandIcon } from "../components/BrandIcon";
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
  const refreshing = loading || anyProviderRefreshing;

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-pop">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface-2/60 px-3"
      >
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <BrandIcon size={20} className="rounded-[5px]" />
          <span className="text-[13px] font-semibold text-fg">AI 用量助手</span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton
            onClick={() => void refreshAll(true)}
            disabled={refreshing}
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </IconButton>
          <IconButton onClick={openMain} title="打开主窗口" aria-label="打开主窗口">
            <Gauge className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={hideQuick} title="隐藏" aria-label="隐藏">
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-canvas p-3">
        {!ready ? (
          <div className="flex h-40 items-center justify-center">
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
          </div>
        ) : !vaultStatus?.unlocked ? (
          <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
              <Lock className="h-5 w-5" />
            </div>
            <p className="text-[13px] text-fg-secondary">Credential Vault 未解锁</p>
            <Button size="sm" onClick={openMain}>
              打开主窗口解锁
            </Button>
          </div>
        ) : snapshots.length === 0 ? (
          <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
              <Gauge className="h-5 w-5" />
            </div>
            <p className="text-[13px] text-fg-secondary">还没有用量数据</p>
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
