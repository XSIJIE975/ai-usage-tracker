import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, ArrowUpCircle, Bell, Gauge, LayoutGrid, PieChart, RefreshCw, Settings, X } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { selectUnreadCount, useNotificationStore } from "../store/useNotificationStore";
import { providerModules } from "../providers";
import { Button } from "../components/ui/button";
import { Segmented } from "../components/ui/segmented";
import { EmptyState } from "../components/ui/empty-state";
import { BrandIcon } from "../components/BrandIcon";
import { IconButton } from "../components/ui/icon-button";
import { ProviderCard } from "../components/ProviderCard";
import { NotificationCenterPanel } from "./NotificationCenterPanel";
import { SettingsView } from "./SettingsView";
import { StatsView } from "./stats/StatsView";
import { formatClock } from "../lib/utils";
import { cn } from "../lib/utils";
import { updateSupported, useUpdateStore } from "../store/useUpdateStore";

type ViewKey = "overview" | "stats" | "settings";

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
  const [view, setView] = useState<ViewKey>("overview");
  const [noticeOpen, setNoticeOpen] = useState(false);
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

  const updateStatus = useUpdateStore((state) => state.status);
  const updateVersion = useUpdateStore((state) => state.version);
  const updateNotice =
    updateStatus === "available" || updateStatus === "downloading" || updateStatus === "ready";

  // 启动后静默检查一次更新；失败不打扰用户，手动入口在设置页
  useEffect(() => {
    if (!updateSupported()) return;
    const timer = window.setTimeout(() => {
      void useUpdateStore.getState().check({ silent: true });
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!vaultStatus?.unlocked) return;
    if (lastRefreshedAt === 0) {
      void refreshAll(false);
      return;
    }
    if (!settings.refreshEnabled || settings.refreshIntervalMinutes <= 0) return;
    if (!providerModules.some((provider) => settings.providers[provider.id])) return;

    const elapsed = Date.now() - lastRefreshedAt;
    const delay = Math.max(0, settings.refreshIntervalMinutes * 60_000 - elapsed);
    const timer = window.setTimeout(() => {
      void refreshAll(false, { auto: true });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    vaultStatus?.unlocked,
    settings.refreshEnabled,
    settings.refreshIntervalMinutes,
    settings.providers,
    lastRefreshedAt,
    refreshAll,
  ]);

  const latest = snapshots.length > 0 ? Math.max(...snapshots.map((item) => item.updatedAt)) : null;
  const anyProviderRefreshing = Object.values(refreshingProviders).some(Boolean);
  const refreshing = loading || anyProviderRefreshing;

  // 通知中心：主窗口启动时加载历史；未读数驱动铃铛徽标
  const unread = useNotificationStore(selectUnreadCount);
  useEffect(() => {
    void useNotificationStore.getState().load();
  }, []);

  // 托盘图标随告警状态切换（去重，避免重复 set）
  const alertActiveMap = useAlertStore((state) => state.active);
  const anyAlertActive = Object.values(alertActiveMap).some(Boolean);
  const trayAlertRef = useRef(false);
  useEffect(() => {
    if (trayAlertRef.current === anyAlertActive) return;
    trayAlertRef.current = anyAlertActive;
    void invoke("set_tray_alert", { active: anyAlertActive }).catch(() => undefined);
  }, [anyAlertActive]);

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex items-center justify-between border-b border-line bg-surface px-6 py-3.5">
        <div className="flex items-center gap-3">
          <BrandIcon size={32} className="rounded-md shadow-sm" />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-fg">AI 用量助手</h1>
            <p className="mt-px flex items-center gap-1.5 text-xs text-fg-muted">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  latest ? "bg-success" : "bg-line-strong",
                )}
              />
              {latest ? `最近更新 ${formatClock(latest)}` : "等待刷新"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <Segmented<ViewKey>
            value={view}
            onChange={setView}
            options={[
              { value: "overview", label: "总览", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
              { value: "stats", label: "统计", icon: <PieChart className="h-3.5 w-3.5" /> },
              { value: "settings", label: "设置", icon: <Settings className="h-3.5 w-3.5" /> },
            ]}
          />
          {updateNotice && (
            <Button
              size="sm"
              variant="outline"
              className="border-brand/40 text-brand"
              onClick={() => setView("settings")}
              title="前往设置安装新版本"
              aria-label={`新版本 v${updateVersion} 可用，前往设置安装`}
            >
              <ArrowUpCircle className="h-3.5 w-3.5" /> 新版本 v{updateVersion}
            </Button>
          )}
          <div className="relative">
            <IconButton
              onClick={() => setNoticeOpen((open) => !open)}
              title="通知中心"
              aria-label={`通知中心${unread > 0 ? `（${unread} 条未读）` : ""}`}
              className="relative h-8"
            >
              <Bell className="h-4 w-4" />
              {unread > 0 && (
                <span className="tnum absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-medium leading-none text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </IconButton>
            {noticeOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setNoticeOpen(false)} aria-hidden />
                <NotificationCenterPanel onClose={() => setNoticeOpen(false)} />
              </>
            )}
          </div>
          <Button size="sm" variant="outline" onClick={() => void refreshAll(true)} disabled={refreshing}>
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> 刷新
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className={cn("mx-auto", view === "stats" ? "max-w-5xl" : "max-w-4xl")}>
          {error && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-danger/20 bg-danger-soft px-4 py-2.5 text-[13px] text-danger-soft-fg">
              <span className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </span>
              <button
                type="button"
                onClick={clearError}
                className="rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
                aria-label="关闭"
              >
                <X className="h-3.5 w-3.5" />
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
                <div className="lg:col-span-2">
                  <EmptyState
                    icon={<Gauge className="h-5 w-5" />}
                    title="还没有用量数据"
                    description="点击右上角「刷新」获取各 Provider 的最新用量。"
                    action={
                      <Button size="sm" onClick={() => void refreshAll(true)} disabled={refreshing}>
                        <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> 立即刷新
                      </Button>
                    }
                  />
                </div>
              )}
            </div>
          ) : view === "stats" ? (
            <StatsView />
          ) : (
            <SettingsView />
          )}
        </div>
      </main>
    </div>
  );
}
