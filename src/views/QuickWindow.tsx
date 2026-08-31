import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, Gauge, Lock, RefreshCw, Timer, TriangleAlert, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { selectUnreadCount, useNotificationStore } from "../store/useNotificationStore";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { BrandIcon } from "../components/BrandIcon";
import { ProviderCard } from "../components/ProviderCard";
import { NotificationCenterPanel } from "./NotificationCenterPanel";
import { cn, formatClock } from "../lib/utils";
import { useT } from "../i18n";
import { applyTheme } from "../lib/theme";
import type { AppSettings } from "../types/ipc";

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
  const [noticeOpen, setNoticeOpen] = useState(false);
  const t = useT();

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
          return;
        }
        // 失焦自动隐藏：仅当鼠标光标确实在窗口外时才收起。
        // 点击标题栏拖动窗口时 Windows 会触发失焦（进入系统拖动循环），
        // 此时光标仍在窗口内，不能隐藏——否则表现为"一点标题栏窗口就消失、无法拖动"。
        if (!useAppStore.getState().settings.quickAutoHide) return;
        void (async () => {
          try {
            const [cursor, position, size] = await Promise.all([
              cursorPosition(),
              window.outerPosition(),
              window.outerSize(),
            ]);
            const inside =
              cursor.x >= position.x &&
              cursor.x <= position.x + size.width &&
              cursor.y >= position.y &&
              cursor.y <= position.y + size.height;
            if (!inside) await invoke("hide_quick_window");
          } catch {
            // 查询失败时保守处理：不隐藏
          }
        })();
      });
      const unlistenVault = await listen("vault-status-changed", () => void syncFromBackend());
      const unlistenCredentials = await listen("credentials-changed", () => void syncFromBackend());
      const unlistenQuickShown = await listen("quick-shown", () => {
        // 兜底：每次显示前重读主题，防止错过广播事件
        applyTheme();
        void syncFromBackend();
      });
      // 主窗口保存设置（界面语言、自动刷新等）时实时同步到本窗口，无需等聚焦重载
      const unlistenSettings = await listen<AppSettings>("settings-changed", (event) => {
        useAppStore.setState({ settings: event.payload });
      });
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
        unlistenSettings();
        return;
      }

      unlisteners.push(unlistenFocus, unlistenVault, unlistenCredentials, unlistenQuickShown, unlistenAlert, unlistenSettings);
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [syncFromBackend]);

  // Esc：通知面板打开时先关面板，否则收起整个窗口
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (noticeOpen) setNoticeOpen(false);
      else void invoke("hide_quick_window").catch(() => undefined);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [noticeOpen]);

  async function openMain() {
    await invoke("open_main_window");
  }

  async function hideQuick() {
    await invoke("hide_quick_window");
  }

  const anyProviderRefreshing = Object.values(refreshingProviders).some(Boolean);
  const refreshing = loading || anyProviderRefreshing;
  const anyAlert = Object.values(alertActiveMap).some(Boolean);

  return (
    // 窗口圆角由系统绘制，这里不再自绘圆角（避免滚动到底部时圆角与滚动内容错位）
    <div className="relative flex h-screen flex-col overflow-hidden bg-surface shadow-pop">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface-2/60 px-3"
      >
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <BrandIcon size={20} className="rounded-[5px]" />
          <span className="text-[13px] font-semibold text-fg">{t("AI 用量助手")}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <div className="relative">
            <IconButton
              onClick={() => setNoticeOpen((open) => !open)}
              title={t("通知中心")}
              aria-label={`${t("通知中心")}${unread > 0 ? `（${unread} ${t("条未读")}）` : ""}`}
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
            title={t("刷新")}
            aria-label={t("刷新")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </IconButton>
          <IconButton onClick={openMain} title={t("打开主窗口")} aria-label={t("打开主窗口")}>
            <Gauge className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton onClick={hideQuick} title={t("隐藏")} aria-label={t("隐藏")}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </header>

      {/* 状态条：下次自动刷新倒计时 + 最近更新时间 */}
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface-2/40 px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="flex items-center gap-1">
          <Timer className="h-3 w-3" />
          {countdown ? `${countdown} ${t("后自动刷新")}` : t("自动刷新已关闭")}
        </span>
        <span className="tnum">
          {snapshots.length > 0 ? `${t("最近更新")} ${formatClock(Math.max(...snapshots.map((item) => item.updatedAt)))}` : t("等待刷新")}
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
              {vaultStatus?.needsMigration ? t("凭据库待迁移") : t("凭据库不可用")}
            </p>
            <p className="text-xs leading-relaxed text-fg-muted">
              {vaultStatus?.needsMigration
                ? t("打开主窗口完成一次性迁移（最后一次输入旧主密码）")
                : t("打开主窗口，在设置中重新录入凭据")}
            </p>
            <Button size="sm" onClick={openMain}>
              {t("打开主窗口")}
            </Button>
          </div>
        ) : (
          <>
            {noticeOpen ? (
              // 通知中心直接在快速面板内查看，无需跳转主窗口
              <div className="absolute inset-x-2 top-12 bottom-2 z-40">
                <NotificationCenterPanel inline onClose={() => setNoticeOpen(false)} />
              </div>
            ) : null}
            {anyAlert && !noticeOpen && (
              <button
                type="button"
                onClick={() => setNoticeOpen(true)}
                className="mb-3 flex w-full items-center gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-left text-xs text-warning-soft-fg transition-colors hover:bg-warning-soft/80"
              >
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                {t("有额度告警待处理，点击查看通知中心")}
              </button>
            )}
            {snapshots.length === 0 ? (
              <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-4 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
                  <Gauge className="h-5 w-5" />
                </div>
                <p className="text-[13px] text-fg-secondary">{t("还没有用量数据")}</p>
                <Button size="sm" onClick={() => void refreshAll(true)}>
                  {t("立即刷新")}
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
