import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, Gauge, Lock, RefreshCw, Timer, TriangleAlert, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { selectUnreadCount, useNotificationStore } from "../store/useNotificationStore";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { BrandIcon } from "../components/BrandIcon";
import { ProviderCard } from "../components/ProviderCard";
import { cn, formatClock } from "../lib/utils";

/** 下次自动刷新倒计时（mm:ss）；自动刷新关闭或尚无基准时间时返回 null */
function useNextRefreshCountdown(): string | null {
  const lastRefreshedAt = useAppStore((state) => state.lastRefreshedAt);
  const refreshEnabled = useAppStore((state) => state.settings.refreshEnabled);
  const refreshIntervalMinutes = useAppStore((state) => state.settings.refreshIntervalMinutes);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!refreshEnabled || refreshIntervalMinutes <= 0 || lastRefreshedAt === 0) return null;
  const remaining = Math.max(0, lastRefreshedAt + refreshIntervalMinutes * 60_000 - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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
  const unread = useNotificationStore(selectUnreadCount);
  const alertActiveMap = useAlertStore((state) => state.active);
  const countdown = useNextRefreshCountdown();
  const [ready, setReady] = useState(false);

  const syncFromBackend = useCallback(async () => {
    await loadInitial();
    void useNotificationStore.getState().load();
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
        if (focused) {
          void syncFromBackend();
        } else if (useAppStore.getState().settings.quickAutoHide) {
          void invoke("hide_quick_window").catch(() => undefined);
        }
      });
      const unlistenVault = await listen("vault-status-changed", () => void syncFromBackend());
      const unlistenCredentials = await listen("credentials-changed", () => void syncFromBackend());
      const unlistenQuickShown = await listen("quick-shown", () => void syncFromBackend());
      // 主窗口上下文刷新产生的告警态变化同步到本窗口
      const unlistenAlert = await listen<{ providerId: string; active: boolean }>(
        "alert-state-changed",
        (event) => {
          useAlertStore.setState((state) => ({
            active: { ...state.active, [event.payload.providerId]: event.payload.active },
          }));
        },
      );

      if (disposed) {
        unlistenFocus();
        unlistenVault();
        unlistenCredentials();
        unlistenQuickShown();
        unlistenAlert();
        return;
      }

      unlisteners.push(unlistenFocus, unlistenVault, unlistenCredentials, unlistenQuickShown, unlistenAlert);
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [syncFromBackend]);

  // Esc 关闭面板
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") void invoke("hide_quick_window").catch(() => undefined);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  async function openMain() {
    await invoke("open_main_window");
  }

  async function openMainNotifications() {
    await invoke("open_main_window");
    await import("@tauri-apps/api/event").then(({ emit }) => emit("open-notifications"));
  }

  async function hideQuick() {
    await invoke("hide_quick_window");
  }

  const anyProviderRefreshing = Object.values(refreshingProviders).some(Boolean);
  const refreshing = loading || anyProviderRefreshing;
  const anyAlert = Object.values(alertActiveMap).some(Boolean);

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
          <div className="relative">
            <IconButton
              onClick={() => void openMainNotifications()}
              title="通知中心"
              aria-label={`通知中心${unread > 0 ? `（${unread} 条未读）` : ""}`}
            >
              <Bell className="h-3.5 w-3.5" />
              {unread > 0 && (
                <span className="tnum absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] font-medium leading-none text-white">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </IconButton>
          </div>
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

      {/* 状态条：下次自动刷新倒计时 + 最近更新时间 */}
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface-2/40 px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="flex items-center gap-1">
          <Timer className="h-3 w-3" />
          {countdown ? `${countdown} 后自动刷新` : "自动刷新已关闭"}
        </span>
        <span className="tnum">
          {snapshots.length > 0 ? `最近更新 ${formatClock(Math.max(...snapshots.map((item) => item.updatedAt)))}` : "等待刷新"}
        </span>
      </div>

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
            <p className="text-[13px] text-fg-secondary">
              {vaultStatus?.needsMigration ? "凭据库待迁移" : "凭据库不可用"}
            </p>
            <p className="text-xs leading-relaxed text-fg-muted">
              {vaultStatus?.needsMigration
                ? "打开主窗口完成一次性迁移（最后一次输入旧主密码）"
                : "打开主窗口，在设置中重新录入凭据"}
            </p>
            <Button size="sm" onClick={openMain}>
              打开主窗口
            </Button>
          </div>
        ) : (
          <>
            {anyAlert && (
              <button
                type="button"
                onClick={() => void openMainNotifications()}
                className="mb-3 flex w-full items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-left text-xs text-warning-soft-fg transition-colors hover:bg-warning-soft/80"
              >
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                有额度告警待处理，点击查看通知中心
              </button>
            )}
            {snapshots.length === 0 ? (
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
          </>
        )}
      </main>
    </div>
  );
}
