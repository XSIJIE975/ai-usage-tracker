import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ComponentType, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  ArrowUpCircle,
  Bell,
  Gauge,
  LayoutGrid,
  Plus,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../components/ui/command";
import { DeepSeekLogo, GlmLogo, OpenCodeLogo } from "../components/brand/provider-logo";
import { InstanceDialog } from "./instances/InstanceDialog";
import { DeleteInstanceDialog } from "./instances/DeleteInstanceDialog";
import { providerModules } from "../providers";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { selectUnreadCount, useNotificationStore } from "../store/useNotificationStore";
import { Button } from "../components/ui/button";
import { Segmented } from "../components/ui/segmented";
import { EmptyState } from "../components/ui/empty-state";
import { BrandIcon } from "../components/BrandIcon";
import { IconButton } from "../components/ui/icon-button";
import { ProviderCard } from "../components/ProviderCard";
import { NotificationCenterPanel } from "./NotificationCenterPanel";
import { SettingsView } from "./SettingsView";
import { StatsSheet } from "./stats/StatsSheet";
import { formatClock } from "../lib/utils";
import { cn } from "../lib/utils";
import { selectOrderedInstances } from "../lib/instance";
import type { ProviderInstance, ProviderKind } from "../types/ipc";
import { updateSupported, useUpdateStore } from "../store/useUpdateStore";
import { useLanguage, useT } from "../i18n";

type ViewKey = "overview" | "settings";

/** 瀑布流行步长：行高 8px + 行距 16px，跨行数 = ceil((内容高+行距)/步长) */
const MASONRY_STEP = 24;

/** 按内层自然高度换算网格跨行数（外层被 span 拉伸，不能测外层，否则高度反馈成环） */
function useMasonrySpan(ref: RefObject<HTMLElement | null>): number {
  const [span, setSpan] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const height = el.offsetHeight;
      if (height > 0) setSpan(Math.max(1, Math.ceil((height + 16) / MASONRY_STEP)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return span;
}

/** 可排序卡片：拖拽手柄在卡片头部左侧，排序变更提交后端持久化 */
function SortableProviderCard({
  instance,
  snapshot,
  refreshing,
  onRefresh,
  onTogglePin,
  onEdit,
  onDelete,
  onOpenStats,
}: {
  instance: ProviderInstance;
  snapshot: ReturnType<typeof useAppStore.getState>["snapshots"][number] | null;
  refreshing: boolean;
  onRefresh: () => void;
  onTogglePin: () => void;
  onEdit?: () => void;
  onDelete: () => void;
  onOpenStats: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: instance.id,
  });
  const measureRef = useRef<HTMLDivElement>(null);
  // 变高卡片的位移换算按格子均一假设会算错，瀑布流下不做实时位移，落点由最近卡判定
  const span = useMasonrySpan(measureRef);
  return (
    <div ref={setNodeRef} style={{ gridRowEnd: `span ${span}` }} className="list-none">
      <div ref={measureRef}>
        <ProviderCard
          instance={instance}
          snapshot={snapshot}
          refreshing={refreshing}
          onRefresh={onRefresh}
          onTogglePin={onTogglePin}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenStats={onOpenStats}
          handleProps={
            { ...attributes, ...listeners } as ComponentPropsWithoutRef<"button">
          }
          dragging={isDragging}
        />
      </div>
    </div>
  );
}

export function Dashboard() {
  const {
    vaultStatus,
    settings,
    instances,
    initialLoaded,
    snapshots,
    refreshAll,
    refreshInstance,
    refreshingInstances,
    loading,
    error,
    clearError,
    updateInstance,
    removeInstance,
    reorderInstances,
    lastRefreshedAt: storeLastRefreshedAt,
  } = useAppStore();
  const [view, setView] = useState<ViewKey>("overview");
  const t = useT();
  const language = useLanguage();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [remoteRefreshedAt, setRemoteRefreshedAt] = useState(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [creatingKind, setCreatingKind] = useState<ProviderKind | null>(null);
  const [editing, setEditing] = useState<ProviderInstance | null>(null);
  const [deleting, setDeleting] = useState<ProviderInstance | null>(null);
  const [statsInstance, setStatsInstance] = useState<ProviderInstance | null>(null);

  const ordered = useMemo(() => selectOrderedInstances(instances), [instances]);
  const snapshotOf = (instanceId: string) =>
    snapshots.find((snapshot) => snapshot.instanceId === instanceId) ?? null;

  const sensors = useSensors(
    // 4px 激活阈值：避免拖拽吞掉卡内按钮点击
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = ordered.findIndex((instance) => instance.id === active.id);
    const newIndex = ordered.findIndex((instance) => instance.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(ordered, oldIndex, newIndex);
    void reorderInstances(next.map((instance) => instance.id));
  };

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
    if (!initialLoaded) return;
    if (lastRefreshedAt === 0) {
      void refreshAll();
      return;
    }
    if (!settings.refreshEnabled || settings.refreshIntervalMinutes <= 0) return;
    if (!instances.some((instance) => instance.autoRefresh)) return;

    const elapsed = Date.now() - lastRefreshedAt;
    const delay = Math.max(0, settings.refreshIntervalMinutes * 60_000 - elapsed);
    const timer = window.setTimeout(() => {
      void refreshAll({ auto: true });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    vaultStatus?.unlocked,
    initialLoaded,
    settings.refreshEnabled,
    settings.refreshIntervalMinutes,
    instances,
    lastRefreshedAt,
    refreshAll,
  ]);

  const latest = snapshots.length > 0 ? Math.max(...snapshots.map((item) => item.updatedAt)) : null;
  const anyProviderRefreshing = Object.values(refreshingInstances).some(Boolean);
  const refreshing = loading || anyProviderRefreshing;

  // 通知中心：主窗口启动时加载历史；未读数驱动铃铛徽标
  const unread = useNotificationStore(selectUnreadCount);
  useEffect(() => {
    void useNotificationStore.getState().load();
  }, []);

  // 快速面板触发的"打开通知中心"
  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen("open-notifications", () => {
      if (!disposed) setNoticeOpen(true);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // 其他窗口（快速面板）刷新产生的告警态变化同步到本窗口
  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen<{ instanceId: string; active: boolean }>("alert-state-changed", (event) => {
      if (disposed) return;
      useAlertStore.setState((state) => ({
        active: { ...state.active, [event.payload.instanceId]: event.payload.active },
      }));
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // 其他窗口增删/排序实例时同步到本窗口
  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;
    void listen("instances-changed", () => {
      if (!disposed) void useAppStore.getState().reloadInstances();
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  // 界面语言变化 → 重建托盘右键菜单（挂载时执行一次，与启动检测语言对齐）
  useEffect(() => {
    void invoke("refresh_tray_menu", { language }).catch(() => undefined);
  }, [language]);

  // 托盘图标随告警状态切换；语言变化时同步提示文案（去重，避免重复 set）
  const alertActiveMap = useAlertStore((state) => state.active);
  const anyAlertActive = Object.values(alertActiveMap).some(Boolean);
  const trayStateRef = useRef("");
  useEffect(() => {
    const key = `${anyAlertActive}|${language}`;
    if (trayStateRef.current === key) return;
    trayStateRef.current = key;
    void invoke("set_tray_alert", { active: anyAlertActive, language }).catch(() => undefined);
  }, [anyAlertActive, language]);

  const draggingInstance = draggingId
    ? ordered.find((instance) => instance.id === draggingId) ?? null
    : null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="flex items-center justify-between border-b border-line bg-surface px-6 py-3.5">
        <div className="flex items-center gap-3">
          <BrandIcon size={32} className="rounded-md shadow-sm" />
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-fg">{t("AI 用量助手")}</h1>
            <p className="mt-px flex items-center gap-1.5 text-xs text-fg-muted">
              <span
                className={cn(
                  "inline-block h-1.5 w-1.5 rounded-full",
                  latest ? "bg-success" : "bg-line-strong",
                )}
              />
              {latest ? `${t("最近更新")} ${formatClock(latest)}` : t("等待刷新")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <Segmented<ViewKey>
            value={view}
            onChange={setView}
            options={[
              { value: "overview", label: t("总览"), icon: <LayoutGrid className="h-3.5 w-3.5" /> },
              { value: "settings", label: t("设置"), icon: <Settings className="h-3.5 w-3.5" /> },
            ]}
          />
          <Popover open={addOpen} onOpenChange={setAddOpen}>
            <PopoverTrigger asChild>
              <IconButton
                aria-label={t("添加供应商")}
                title={t("添加供应商")}
                className="rounded-full bg-brand text-brand-fg shadow-sm hover:bg-brand-hover hover:text-brand-fg"
              >
                <Plus className="h-4 w-4" />
              </IconButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0">
              <Command>
                <CommandInput placeholder={t("搜索供应商…")} />
                <CommandList>
                  <CommandEmpty>{t("没有匹配的供应商")}</CommandEmpty>
                  {providerModules.map((module) => (
                    <CommandItem
                      key={module.id}
                      value={`${module.name} ${module.description}`}
                      onSelect={() => {
                        setAddOpen(false);
                        setCreatingKind(module.id);
                      }}
                    >
                      <ProviderKindLogo providerId={module.id} />
                      <div className="min-w-0">
                        <p className="font-medium text-fg">{module.name}</p>
                        <p className="truncate text-xs text-fg-muted">{t(module.description)}</p>
                      </div>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {updateNotice && (
            <Button
              size="sm"
              variant="outline"
              className="border-brand/40 text-brand"
              onClick={() => setView("settings")}
              title={t("前往设置安装新版本")}
              aria-label={`新版本 v${updateVersion} 可用，前往设置安装`}
            >
              <ArrowUpCircle className="h-3.5 w-3.5" /> {t("新版本")} v{updateVersion}
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
          <Button size="sm" variant="outline" onClick={() => void refreshAll()} disabled={refreshing}>
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> {t("刷新")}
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        <div className={cn(view === "settings" && "mx-auto max-w-3xl")}>
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
                aria-label={t("关闭")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {view === "overview" ? (
            ordered.length === 0 ? (
              initialLoaded && (
                <EmptyState
                  icon={<Gauge className="h-5 w-5" />}
                  title={t("还没有供应商")}
                  description={t("添加一份凭据，开始追踪该供应商的用量。")}
                  action={
                    <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
                      <Plus className="h-3.5 w-3.5" /> {t("添加供应商")}
                    </Button>
                  }
                />
              )
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragCancel={() => setDraggingId(null)}
              >
                <SortableContext items={ordered.map((instance) => instance.id)}>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] justify-center gap-4 [grid-auto-rows:8px]">
                    {ordered.map((instance) => (
                      <SortableProviderCard
                        key={instance.id}
                        instance={instance}
                        snapshot={snapshotOf(instance.id)}
                        refreshing={loading || refreshingInstances[instance.id]}
                        onRefresh={() => void refreshInstance(instance.id)}
                        onTogglePin={() =>
                          void updateInstance(instance.id, { pinned: !instance.pinned })
                        }
                        onEdit={() => setEditing(instance)}
                        onDelete={() => setDeleting(instance)}
                        onOpenStats={() => setStatsInstance(instance)}
                      />
                    ))}
                  </div>
                </SortableContext>
                <DragOverlay dropAnimation={null}>
                  {draggingInstance && (
                    <div className="w-full max-w-[460px] shadow-pop">
                      <ProviderCard
                        instance={draggingInstance}
                        snapshot={snapshotOf(draggingInstance.id)}
                      />
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            )
          ) : (
            <SettingsView />
          )}
        </div>
      </main>

      <InstanceDialog
        open={creatingKind !== null}
        onOpenChange={(open) => {
          if (!open) setCreatingKind(null);
        }}
        instance={null}
        providerId={creatingKind ?? "deepseek"}
      />
      <InstanceDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        instance={editing}
        providerId={editing?.providerId ?? "deepseek"}
      />
      <StatsSheet
        instance={statsInstance}
        open={statsInstance !== null}
        onOpenChange={(open) => {
          if (!open) setStatsInstance(null);
        }}
      />
      <DeleteInstanceDialog
        instance={deleting}
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting) void removeInstance(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

const KIND_LOGOS: Record<ProviderKind, ComponentType<{ className?: string }>> = {
  deepseek: DeepSeekLogo,
  "opencode-go": OpenCodeLogo,
  glm: GlmLogo,
};

function ProviderKindLogo({ providerId }: { providerId: ProviderKind }) {
  const Logo = KIND_LOGOS[providerId];
  return <Logo className="h-5 w-5 shrink-0" />;
}
