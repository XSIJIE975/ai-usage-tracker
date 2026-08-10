import { useEffect, useState } from "react";
import { RefreshCw, Settings, LayoutGrid } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { ProviderCard } from "../components/ProviderCard";
import { SettingsView } from "./SettingsView";
import { formatClock } from "../lib/utils";
import { cn } from "../lib/utils";

export function Dashboard() {
  const {
    vaultStatus,
    settings,
    snapshots,
    refreshAll,
    refreshProvider,
    refreshingProviders,
    loading,
    error,
    clearError,
    lastRefreshedAt: storeLastRefreshedAt,
  } = useAppStore();
  const [view, setView] = useState<"overview" | "settings">("overview");
  const [remoteRefreshedAt, setRemoteRefreshedAt] = useState(0);

  useEffect(() => {
    let disposed = false;
    let stopListening: UnlistenFn | undefined;

    void listen<{ refreshedAt: number }>("refresh-completed", (event) => {
      if (disposed) return;
      setRemoteRefreshedAt((current) => Math.max(current, event.payload.refreshedAt));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stopListening = unlisten;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const lastRefreshedAt = Math.max(storeLastRefreshedAt, remoteRefreshedAt);

  useEffect(() => {
    if (!vaultStatus?.unlocked) return;
    if (lastRefreshedAt === 0) {
      void refreshAll(false);
      return;
    }
    if (!settings.refreshEnabled || settings.refreshIntervalMinutes <= 0) return;

    const elapsed = Date.now() - lastRefreshedAt;
    const delay = Math.max(0, settings.refreshIntervalMinutes * 60_000 - elapsed);
    const timer = window.setTimeout(() => {
      void refreshAll(false);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    vaultStatus?.unlocked,
    settings.refreshEnabled,
    settings.refreshIntervalMinutes,
    lastRefreshedAt,
    refreshAll,
  ]);

  const latest = snapshots.length > 0 ? Math.max(...snapshots.map((item) => item.updatedAt)) : null;
  const anyProviderRefreshing = Object.values(refreshingProviders).some(Boolean);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">AI 用量助手</h1>
          <p className="mt-0.5 text-xs text-slate-400">
            {latest ? `最近更新 ${formatClock(latest)}` : "等待刷新"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-slate-200 bg-slate-50 p-0.5">
            <button
              type="button"
              onClick={() => setView("overview")}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium",
                view === "overview" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              <LayoutGrid className="h-3.5 w-3.5" /> 总览
            </button>
            <button
              type="button"
              onClick={() => setView("settings")}
              className={cn(
                "inline-flex items-center gap-1 rounded px-2.5 py-1.5 text-xs font-medium",
                view === "settings" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500",
              )}
            >
              <Settings className="h-3.5 w-3.5" /> 设置
            </button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void refreshAll(true)} disabled={loading || anyProviderRefreshing}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> 刷新
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 flex items-center justify-between rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span>{error}</span>
            <button type="button" onClick={clearError} className="text-xs underline">
              关闭
            </button>
          </div>
        )}
        {view === "overview" ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {snapshots.length > 0 ? (
              snapshots.map((snapshot) => (
                <ProviderCard
                  key={snapshot.providerId}
                  snapshot={snapshot}
                  refreshing={loading || refreshingProviders[snapshot.providerId]}
                  onRefresh={() => void refreshProvider(snapshot.providerId)}
                />
              ))
            ) : (
              <div className="rounded-lg border border-dashed border-slate-300 p-10 text-center text-sm text-slate-400">
                还没有用量数据，请先刷新。
              </div>
            )}
          </div>
        ) : (
          <SettingsView />
        )}
      </main>
    </div>
  );
}
