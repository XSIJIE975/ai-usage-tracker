import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useFitWindowHeight } from "../hooks/use-fit-window-height";
import { Bell, Gauge, LoaderCircle, Lock, RefreshCw, Timer, TriangleAlert, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { selectUnreadCount, useNotificationStore } from "../store/useNotificationStore";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { BrandIcon } from "../components/BrandIcon";
import { ProviderCard } from "../components/ProviderCard";
import { NotificationCenterPanel } from "./NotificationCenterPanel";
import { cn, formatClock } from "../lib/utils";
import { selectOrderedInstances } from "../lib/instance";
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
    instances,
    snapshots,
    settings,
    initialLoaded,
    lastRefreshedAt,
    loadInitial,
    refreshAll,
    refreshInstance,
    refreshingInstances,
    loading,
  } = useAppStore();
  const unread = useNotificationStore(selectUnreadCount);
  const alertActiveMap = useAlertStore((state) => state.active);
  const countdown = useNextRefreshCountdown();
  const [ready, setReady] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  // quick 窗口启动即隐藏（tauri.conf.json visible=false），由 quick-shown 唤醒。
  // 自动刷新定时器只在面板可见时调度，避免与主窗口对同一批实例双倍抓取
  const [panelVisible, setPanelVisible] = useState(false);
  // 标题栏自管拖动：记录拖动起手时刻。拖动循环会先失焦再回焦，
  // 回焦若无条件刷新，表现为「每次拖完面板自动刷新倒计时就被重置」
  const dragStartedAtRef = useRef(0);
  const t = useT();

  const syncFromBackend = useCallback(async () => {
    await loadInitial();
    void useNotificationStore.getState().load();
    if (useAppStore.getState().vaultStatus?.unlocked) {
      await refreshAll();
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
          // 拖动结束的回焦不算「用户回来看数据」：起手后 10 秒内的回焦直接跳过
          if (dragStartedAtRef.current > 0 && Date.now() - dragStartedAtRef.current < 10_000) {
            return;
          }
          dragStartedAtRef.current = 0;
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
            if (!inside) {
              setPanelVisible(false);
              await invoke("hide_quick_window");
            }
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
        setPanelVisible(true);
        void syncFromBackend();
      });
      // 主窗口（或本窗口）刷新完成时同步倒计时基准，两边窗口的自动刷新节奏保持一致
      const unlistenRefreshed = await listen<{ refreshedAt: number }>("refresh-completed", (event) => {
        useAppStore.setState((state) => ({
          lastRefreshedAt: Math.max(state.lastRefreshedAt, event.payload.refreshedAt),
        }));
      });
      // 主窗口保存设置（界面语言、自动刷新等）时实时同步到本窗口，无需等聚焦重载
      const unlistenSettings = await listen<AppSettings>("settings-changed", (event) => {
        useAppStore.setState({ settings: event.payload });
      });
      // 主窗口增删/排序实例时重载（高度随后自然跟随）
      const unlistenInstances = await listen("instances-changed", () => {
        if (!disposed) void syncFromBackend();
      });
      // 主窗口上下文刷新产生的告警态变化同步到本窗口
      const unlistenAlert = await listen<{ instanceId: string; active: boolean }>(
        "alert-state-changed",
        (event) => {
          useAlertStore.setState((state) => ({
            active: { ...state.active, [event.payload.instanceId]: event.payload.active },
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
        unlistenInstances();
        unlistenRefreshed();
        return;
      }

      unlisteners.push(unlistenFocus, unlistenVault, unlistenCredentials, unlistenQuickShown, unlistenAlert, unlistenSettings, unlistenInstances, unlistenRefreshed);
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [syncFromBackend]);

  // 自动刷新调度：与主窗口 Dashboard 同款——以 lastRefreshedAt 为基准排单次定时器，
  // 刷新完成后 lastRefreshedAt 更新，effect 随之重排下一轮。仅面板可见时调度，
  // 隐藏期间不抓取（再次呼出时 quick-shown → syncFromBackend 兜底刷新）
  useEffect(() => {
    if (!panelVisible) return;
    if (!vaultStatus?.unlocked) return;
    if (!initialLoaded) return;
    // 首轮数据由 quick-shown 的 syncFromBackend 拉取，这里只负责后续周期
    if (lastRefreshedAt === 0) return;
    if (!settings.refreshEnabled || settings.refreshIntervalMinutes <= 0) return;
    if (!instances.some((instance) => instance.autoRefresh)) return;

    const elapsed = Date.now() - lastRefreshedAt;
    const delay = Math.max(0, settings.refreshIntervalMinutes * 60_000 - elapsed);
    const timer = window.setTimeout(() => {
      void refreshAll({ auto: true });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    panelVisible,
    vaultStatus?.unlocked,
    initialLoaded,
    lastRefreshedAt,
    settings.refreshEnabled,
    settings.refreshIntervalMinutes,
    instances,
    refreshAll,
  ]);

  // Esc：通知面板打开时先关面板，否则收起整个窗口
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (noticeOpen) setNoticeOpen(false);
      else {
        setPanelVisible(false);
        void invoke("hide_quick_window").catch(() => undefined);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [noticeOpen]);

  async function openMain() {
    await invoke("open_main_window");
  }

  async function hideQuick() {
    setPanelVisible(false);
    await invoke("hide_quick_window");
  }

  const anyProviderRefreshing = Object.values(refreshingInstances).some(Boolean);
  const refreshing = loading || anyProviderRefreshing;
  const anyAlert = Object.values(alertActiveMap).some(Boolean);

  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useFitWindowHeight(rootRef, contentRef);

  // 顶栏拖动与双击自管（不走 data-tauri-drag-region 的注入脚本，双击行为确定可控）：
  // 按钮上不进入拖动（否则系统拖动循环吞掉 click，表现为按钮要双击）；
  // 空白区单击进入系统拖动，双击的第二次按下放行给 dblclick（与 Tauri drag.js 同手法）
  function handleHeaderMouseDown(event: React.MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.button !== 0 || event.detail !== 1) return;
    event.preventDefault();
    dragStartedAtRef.current = Date.now();
    void getCurrentWindow().startDragging();
  }

  function handleHeaderDoubleClick(event: React.MouseEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    // 双击即「去主窗口操作」：主窗口起来后收起面板（光标在面板内，失焦自动隐藏不会触发）
    void openMain().then(() => hideQuick());
  }

  return (
    // 窗口圆角由系统绘制，这里不再自绘圆角（避免滚动到底部时圆角与滚动内容错位）
    <div
      ref={rootRef}
      className="relative flex h-screen flex-col overflow-hidden bg-surface shadow-pop"
    >
      <header
        data-quick-header
        onMouseDown={handleHeaderMouseDown}
        onDoubleClick={handleHeaderDoubleClick}
        className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface-2/60 px-3"
      >
        <div className="flex items-center gap-2">
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
            onClick={() => void refreshAll()}
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

      {/* 状态条：下次自动刷新倒计时 + 最近更新时间；刷新进行中倒计时基准未更新，
          继续走秒会像卡住，此时显示「刷新中」提示 */}
      <div className="flex shrink-0 items-center justify-between border-b border-line bg-surface-2/40 px-3 py-1.5 text-[11px] text-fg-muted">
        <span className="flex items-center gap-1">
          {refreshing ? (
            <LoaderCircle className="h-3 w-3 animate-spin" />
          ) : (
            <Timer className="h-3 w-3" />
          )}
          {refreshing
            ? t("刷新中")
            : countdown
              ? `${countdown} ${t("后自动刷新")}`
              : t("自动刷新已关闭")}
        </span>
        <span className="tnum">
          {snapshots.length > 0 ? `${t("最近更新")} ${formatClock(Math.max(...snapshots.map((item) => item.updatedAt)))}` : t("等待刷新")}
        </span>
      </div>

      <main className="flex-1 overflow-y-auto bg-canvas p-3">
        {/* 高度测量的参照物：包裹层的自然高度不受视口钳制，内容超出上限时 main 内部滚动 */}
        <div ref={contentRef}>
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
              // 通知中心直接在快速面板内查看，无需跳转主窗口；
              // 只定位不钉高度，面板按内容自适应（上限在组件内，内部滚动）
              <div className="absolute inset-x-2 top-12 z-40">
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
            {instances.length === 0 && snapshots.length === 0 ? (
              <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-4 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
                  <Gauge className="h-5 w-5" />
                </div>
                <p className="text-[13px] text-fg-secondary">{t("还没有用量数据")}</p>
                <Button size="sm" onClick={() => void refreshAll()}>
                  {t("立即刷新")}
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {selectOrderedInstances(instances).map((instance) => (
                  <ProviderCard
                    key={instance.id}
                    instance={instance}
                    snapshot={
                      snapshots.find((snapshot) => snapshot.instanceId === instance.id) ?? null
                    }
                    compact
                    refreshing={
                      loading || refreshingInstances[instance.id]
                    }
                    onRefresh={() => void refreshInstance(instance.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
        </div>
      </main>
    </div>
  );
}
