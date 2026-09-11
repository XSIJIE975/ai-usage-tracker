import { useRef, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bell, Gauge, LayoutGrid, List, ListX, Lock, RefreshCw, X } from "lucide-react";
import { useFitWindowHeight } from "../hooks/use-fit-window-height";
import { usePanelAutoRefresh, usePanelWindow } from "../hooks/use-panel-window";
import { BrandIcon } from "../components/BrandIcon";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { Segmented } from "../components/ui/segmented";
import { GlanceCards } from "../components/glance/GlanceCards";
import { GlanceRows } from "../components/glance/GlanceRows";
import { buildGlanceInstances } from "../components/glance/data";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { selectUnreadCount, useNotificationStore } from "../store/useNotificationStore";
import { cn } from "../lib/utils";
import { useT } from "../i18n";

/**
 * 速览面板（ADR-0016）：托盘左键单击唤起，由 Rust 侧锚定到托盘图标旁。
 * 全新布局，不与快速面板共用卡片组件；行列表/迷你卡片两种形态面板内切换并持久化，
 * 实例范围与字段开关在设置页配置。窗口基建（数据同步/失焦隐藏/跨窗口事件/自动刷新）
 * 与快速面板共用 usePanelWindow。
 */
export function GlanceWindow() {
  // 按字段订阅：面板窗口同样不该被无关 store 写入整树重渲染
  const vaultStatus = useAppStore((state) => state.vaultStatus);
  const settings = useAppStore((state) => state.settings);
  const instances = useAppStore((state) => state.instances);
  const snapshots = useAppStore((state) => state.snapshots);
  const refreshAll = useAppStore((state) => state.refreshAll);
  const refreshingInstances = useAppStore((state) => state.refreshingInstances);
  const loading = useAppStore((state) => state.loading);
  const unread = useNotificationStore(selectUnreadCount);
  const alertActiveMap = useAlertStore((state) => state.active);
  const t = useT();

  const { ready, panelVisible, hideWindow } = usePanelWindow({
    shownEvent: "glance-shown",
    hideCommand: "hide_glance_window",
    autoHideKey: "glanceAutoHide",
  });
  usePanelAutoRefresh(panelVisible);

  async function openMain() {
    await invoke("open_main_window");
    await hideWindow();
  }

  const anyProviderRefreshing = Object.values(refreshingInstances).some(Boolean);
  const refreshing = loading || anyProviderRefreshing;

  // 实例范围过滤 + 展示数据构建
  const scopedInstances =
    settings.glanceInstanceScope === "custom"
      ? instances.filter((instance) => settings.glanceInstanceIds.includes(instance.id))
      : instances;
  const glanceItems = buildGlanceInstances(scopedInstances, snapshots, {
    alertActive: alertActiveMap,
    refreshing: refreshingInstances,
    loading,
    translate: t,
  });
  const fields = {
    showAlerts: settings.glanceShowAlerts,
    showBalance: settings.glanceShowBalance,
    showReset: settings.glanceShowReset,
    showWindows: settings.glanceShowWindows,
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useFitWindowHeight(rootRef, contentRef, { minHeight: 180, keepBottom: true });

  return (
    <div
      ref={rootRef}
      className="relative flex h-screen flex-col overflow-hidden bg-surface shadow-pop"
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface-2/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrandIcon size={20} className="rounded-[5px]" />
          <span className="truncate text-[13px] font-semibold text-fg">{t("AI 用量助手")}</span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Segmented
            size="sm"
            value={settings.glanceLayout}
            onChange={(value) => {
              void useAppStore.getState().saveSettings({
                ...useAppStore.getState().settings,
                glanceLayout: value,
              });
            }}
            options={[
              { value: "list", label: "", icon: <List className="h-3.5 w-3.5" /> },
              { value: "cards", label: "", icon: <LayoutGrid className="h-3.5 w-3.5" /> },
            ]}
          />
          <IconButton
            onClick={() => void refreshAll()}
            disabled={refreshing}
            title={t("刷新")}
            aria-label={t("刷新")}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          </IconButton>
          <IconButton onClick={() => void hideWindow()} title={t("隐藏")} aria-label={t("隐藏")}>
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </header>

      {/* min-h-0：flex 子项默认不可小于内容高，内容超过窗口上限时必须让 main 收缩并内部滚动，
          否则内容把 footer 挤出窗口、整体不可滚动 */}
      <main className="no-scrollbar min-h-0 flex-1 overflow-y-auto bg-canvas p-2.5">
        {/* 高度测量的参照物：包裹层的自然高度不受视口钳制，内容超出上限时 main 内部滚动 */}
        <div ref={contentRef}>
          {!ready ? (
            <div className="flex h-40 items-center justify-center">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
            </div>
          ) : !vaultStatus?.unlocked ? (
            <div className="flex h-44 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-line-strong bg-surface p-4 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
                <Lock className="h-5 w-5" />
              </div>
              <p className="text-[13px] text-fg-secondary">
                {vaultStatus?.needsMigration ? t("凭据库待迁移") : t("凭据库不可用")}
              </p>
              <Button size="sm" onClick={() => void openMain()}>
                {t("打开主窗口")}
              </Button>
            </div>
          ) : glanceItems.length === 0 && instances.length === 0 ? (
            <EmptyHint
              icon={<Gauge className="h-5 w-5" />}
              text={t("还没有用量数据")}
              action={
                <Button size="sm" onClick={() => void refreshAll()}>
                  {t("立即刷新")}
                </Button>
              }
            />
          ) : glanceItems.length === 0 ? (
            // 有实例但范围/勾选把它们全部排除：不是「没有数据」，刷新无意义，应引导去设置
            <EmptyHint
              icon={<ListX className="h-5 w-5" />}
              text={t("未选择展示的实例")}
              description={t("可在设置的「速览面板」中勾选要在此展示的实例")}
              action={
                <Button size="sm" onClick={() => void openMain()}>
                  {t("打开主窗口")}
                </Button>
              }
            />
          ) : settings.glanceLayout === "cards" ? (
            <GlanceCards items={glanceItems} fields={fields} translate={t} />
          ) : (
            <GlanceRows items={glanceItems} fields={fields} translate={t} />
          )}
        </div>
      </main>

      {settings.glanceShowFooter && (
        <footer className="flex shrink-0 items-center justify-between border-t border-line bg-surface-2/40 px-3 py-1.5">
          <button
            type="button"
            onClick={() => void openMain()}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-fg-secondary"
          >
            <Bell className="h-3 w-3" />
            {unread > 0 ? `${unread} ${t("条未读")}` : t("通知中心")}
          </button>
          <button
            type="button"
            onClick={() => void openMain()}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-fg-muted transition-colors hover:text-fg-secondary"
          >
            <Gauge className="h-3 w-3" />
            {t("打开主窗口")}
          </button>
        </footer>
      )}
    </div>
  );
}

/** 空态卡片：图标 + 主文案 + 可选说明 + 动作按钮 */
function EmptyHint({
  icon,
  text,
  description,
  action,
}: {
  icon: ReactNode;
  text: string;
  description?: string;
  action: ReactNode;
}) {
  return (
    <div className="flex h-44 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface p-4 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
        {icon}
      </div>
      <p className="text-[13px] text-fg-secondary">{text}</p>
      {description && <p className="text-[11px] leading-4 text-fg-muted">{description}</p>}
      <div className="mt-1">{action}</div>
    </div>
  );
}
