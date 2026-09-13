import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore, type RefreshCompletedPayload } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { applyTheme } from "../lib/theme";
import type { AppSettings } from "../types/ipc";

export interface PanelWindowConfig {
  /** 唤起事件名（quick-shown / glance-shown）：Rust 侧显示窗口前发出 */
  shownEvent: string;
  /** 收起窗口的后端命令（hide_quick_window / hide_glance_window） */
  hideCommand: string;
  /** 失焦自动隐藏对应的设置键 */
  autoHideKey: "quickAutoHide" | "glanceAutoHide";
  /** 焦点回到窗口时的守卫：返回 false 跳过本次数据同步（快速面板的拖动回焦不算「用户回来看数据」） */
  onFocusGained?: () => boolean;
  /** Esc 按下的前置处理：返回 true 表示已消费（如快速面板先关闭通知面板） */
  onEscape?: () => boolean;
}

/**
 * 常驻面板窗口的公共基建（快速面板与速览面板共用，ADR-0016 抽取）：
 * 启动轻量同步并标记就绪、唤起事件重读主题+全量刷新、失焦按光标位置自动隐藏、
 * 跨窗口事件（凭据库/设置/实例/告警/刷新完成）同步、Esc 收起。面板组件只保留布局与交互差异。
 * 零抓取门控（ADR-0023）：面板隐藏时不发起任何供应商网络请求——挂载与 vault/实例事件
 * 走轻量路径（本地 IPC），网络刷新只发生在唤起/聚焦语境；主窗口豁免（驻留心跳）。
 *
 * 跨窗口事件契约（全局广播，@tauri-apps/api/event 的 emit/listen）：
 * - settings-changed        设置整体（saveSettings 发出，payload 为完整 AppSettings）
 * - theme-changed           主题模式（lib/theme.ts，main.tsx 的 initThemeSync 全窗口监听）
 * - instances-changed       实例增删/排序（Rust 命令发出）
 * - alert-state-changed     实例告警态（告警协调器发出）
 * - refresh-completed       刷新完成：倒计时基准 + 快照事实源已更新（ADR-0019 快照收敛，
 *                           新窗口接入必须两者都挂，只挂基准会表现为「面板数字停在旧值」）
 * - vault-status-changed / credentials-changed（Rust 发出）
 * 注意：事件与窗口 API 受 Tauri capabilities 管控——capabilities/default.json 对窗口标签
 * 用 glob 全量授权，新增窗口不要改回逐个列举，否则新窗口会静默失去全部事件（速览面板配置
 * 不同步、失焦不隐藏、高度不自适应即此因）。
 */
export function usePanelWindow(config: PanelWindowConfig) {
  const { shownEvent, hideCommand, autoHideKey } = config;
  const loadInitial = useAppStore((state) => state.loadInitial);
  const refreshAll = useAppStore((state) => state.refreshAll);
  const [ready, setReady] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);

  // 回调经 ref 透传：事件管道只在挂载时建立一次，组件每渲染重写 ref 即可拿到最新闭包
  const focusGuardRef = useRef(config.onFocusGained);
  focusGuardRef.current = config.onFocusGained;
  const escapeRef = useRef(config.onEscape);
  escapeRef.current = config.onEscape;
  // 可见性同样经 ref 透传：事件管道只在挂载时建立一次，而快照收敛（ADR-0019）要读「当时」的可见性
  const panelVisibleRef = useRef(false);
  panelVisibleRef.current = panelVisible;

  // 轻量同步（ADR-0023 零抓取）：只重读本地状态（IPC 读库），不发起任何供应商网络请求。
  // 隐藏中的面板收到 vault/实例变化事件时走这条路——结构正确性靠它，新鲜度靠唤起兜底
  const syncFromBackendLight = useCallback(async () => {
    await loadInitial();
    void useNotificationStore.getState().load();
  }, [loadInitial]);

  // 完整同步：轻量同步 + 全量刷新。只在面板可见的语境调用（唤起、聚焦）；
  // 面板隐藏时不抓取，主窗口不受此约束——它的自动刷新是驻留心跳（ADR-0023）
  const syncFromBackend = useCallback(async () => {
    await syncFromBackendLight();
    if (useAppStore.getState().vaultStatus?.unlocked) {
      await refreshAll();
    }
  }, [syncFromBackendLight, refreshAll]);

  const hideWindow = useCallback(async () => {
    setPanelVisible(false);
    await invoke(hideCommand).catch(() => undefined);
  }, [hideCommand]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    // 边注册边入列：注册途中卸载/出错时，已注册的监听也能被清理，不泄漏
    const track = (unlisten: UnlistenFn) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };

    void (async () => {
      // 挂载同步走轻量路径（ADR-0023 零抓取）：面板启动时是隐藏的，不发起网络抓取；
      // 新鲜度由唤起事件（shownEvent → 完整同步）兜底
      await syncFromBackendLight();
      if (disposed) return;
      setReady(true);

      try {
        const window = getCurrentWindow();
        track(
          await window.onFocusChanged(({ payload: focused }) => {
            if (focused) {
              if (focusGuardRef.current && !focusGuardRef.current()) return;
              void syncFromBackend();
              return;
            }
            // 失焦自动隐藏：仅当鼠标光标确实在窗口外时才收起。
            // 点击标题栏拖动窗口时 Windows 会触发失焦（进入系统拖动循环），
            // 此时光标仍在窗口内，不能隐藏——否则表现为"一点标题栏窗口就消失、无法拖动"。
            if (!useAppStore.getState().settings[autoHideKey]) return;
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
                  await invoke(hideCommand);
                }
              } catch {
                // 查询失败时保守处理：不隐藏
              }
            })();
          }),
        );
        // 凭据库状态/凭据变化：只做轻量同步（ADR-0023 零抓取）。抓取依赖凭据可用性，
        // 且解锁方（主窗口）刷出的结果会经 refresh-completed 收敛回来，这里不抢跑
        track(await listen("vault-status-changed", () => void syncFromBackendLight()));
        track(await listen("credentials-changed", () => void syncFromBackendLight()));
        track(
          await listen(shownEvent, () => {
            // 兜底：每次显示前重读主题，防止错过广播事件
            applyTheme();
            setPanelVisible(true);
            void syncFromBackend();
          }),
        );
        // 主窗口（或本窗口）刷新完成时同步倒计时基准，各窗口的自动刷新节奏保持一致；
        // 同时按 ADR-0019 收敛快照：别的窗口刷出的结果回流到本窗口，面板展示随之更新。
        // 隐藏中的面板不重读——不可见 webview 不吃数据，唤起事件会把它补上（syncFromBackend
        // 先 loadInitial）；发起方自己刚在 refreshAll 里读过库，也跳过。
        track(
          await listen<RefreshCompletedPayload>("refresh-completed", (event) => {
            useAppStore.setState((state) => ({
              lastRefreshedAt: Math.max(state.lastRefreshedAt, event.payload.refreshedAt),
            }));
            if (event.payload.source === window.label) return;
            if (!panelVisibleRef.current) return;
            void useAppStore.getState().reloadSnapshots();
          }),
        );
        // 主窗口保存设置（界面语言、自动刷新等）时实时同步到本窗口，无需等聚焦重载
        track(
          await listen<AppSettings>("settings-changed", (event) => {
            useAppStore.setState({ settings: event.payload });
          }),
        );
        // 主窗口增删/排序实例时重载（面板高度随后自然跟随）。
        // 零抓取（ADR-0023）：只做本地重读，网络刷新留给唤起事件与主窗口的刷新收敛
        track(
          await listen("instances-changed", () => {
            if (!disposed) {
              void (async () => {
                await useAppStore.getState().reloadInstances();
                await useAppStore.getState().reloadSnapshots();
              })();
            }
          }),
        );
        // 主窗口上下文刷新产生的告警态变化同步到本窗口
        track(
          await listen<{ instanceId: string; active: boolean }>(
            "alert-state-changed",
            (event) => {
              useAlertStore.setState((state) => ({
                active: { ...state.active, [event.payload.instanceId]: event.payload.active },
              }));
            },
          ),
        );
      } catch (error) {
        // 监听注册失败（典型：capabilities 未授权该窗口）绝不能静默——
        // 表现是面板「看起来正常但永不跟随配置」，曾因 glance 未列入 windows 而发生
        console.error(`[panel] 事件监听注册失败（${shownEvent}）：`, error);
      }
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [syncFromBackend, syncFromBackendLight, shownEvent, hideCommand, autoHideKey]);

  // Esc：onEscape 先行（如先关闭通知面板），未消费则收起整个窗口
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (escapeRef.current && escapeRef.current()) return;
      void hideWindow();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hideWindow]);

  return { ready, panelVisible, setPanelVisible, syncFromBackend, hideWindow };
}

/**
 * 面板自动刷新调度：与主窗口 Dashboard 同款——以 lastRefreshedAt 为基准排单次定时器，
 * 刷新完成后 lastRefreshedAt 更新，effect 随之重排下一轮。仅面板可见时调度，
 * 隐藏期间不抓取（避免与主窗口对同一批实例双倍抓取；再次呼出时唤起事件兜底刷新）。
 */
export function usePanelAutoRefresh(panelVisible: boolean) {
  const vaultUnlocked = useAppStore((state) => state.vaultStatus?.unlocked);
  const initialLoaded = useAppStore((state) => state.initialLoaded);
  const lastRefreshedAt = useAppStore((state) => state.lastRefreshedAt);
  const refreshEnabled = useAppStore((state) => state.settings.refreshEnabled);
  const refreshIntervalMinutes = useAppStore((state) => state.settings.refreshIntervalMinutes);
  const instances = useAppStore((state) => state.instances);
  const refreshAll = useAppStore((state) => state.refreshAll);

  useEffect(() => {
    if (!panelVisible) return;
    if (!vaultUnlocked) return;
    if (!initialLoaded) return;
    // 首轮数据由唤起事件的数据同步拉取，这里只负责后续周期
    if (lastRefreshedAt === 0) return;
    if (!refreshEnabled || refreshIntervalMinutes <= 0) return;
    if (!instances.some((instance) => instance.autoRefresh)) return;

    const elapsed = Date.now() - lastRefreshedAt;
    const delay = Math.max(0, refreshIntervalMinutes * 60_000 - elapsed);
    const timer = window.setTimeout(() => {
      void refreshAll({ auto: true });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    panelVisible,
    vaultUnlocked,
    initialLoaded,
    lastRefreshedAt,
    refreshEnabled,
    refreshIntervalMinutes,
    instances,
    refreshAll,
  ]);
}
