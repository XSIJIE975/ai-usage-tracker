import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TriangleAlert } from "lucide-react";
import { usePanelAutoRefresh, usePanelWindow } from "../hooks/use-panel-window";
import { useNow } from "../hooks/use-now";
import { buildGlanceInstances, type GlanceInstance } from "../components/glance/data";
import { IslandPillContent, IslandPillSideContent, useIslandClock } from "../components/island/IslandPill";
import { IslandPanelContent } from "../components/island/IslandPanel";
import {
  BANNER_MS,
  BANNER_TUNING,
  BANNER_W,
  CLOSE_TUNING,
  OPEN_TUNING,
  PANEL_FADE,
  PANEL_H,
  PANEL_W,
  PILL_FADE,
  PILL_H,
  PILL_TOP,
  PILL_W,
  SIDE_CANVAS_H,
  SIDE_PANEL_H,
  SIDE_PANEL_W,
  SIDE_PILL_H,
  SIDE_PILL_W,
  type IslandDock,
} from "../components/island/constants";
import { Spring, clamp01, lerp, smoothstep } from "../lib/spring";
import { cn } from "../lib/utils";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { useLanguage, useT } from "../i18n";


/**
 * 灵动岛窗口（ADR-0047）：常驻屏幕顶部工作区居中的透明胶囊，悬停驻留展开、离开收起。
 * 展开判定在 Rust 控制器（src-tauri/src/island_window.rs）——本视图只听 island-expanded /
 * island-collapsed 事件驱动形变弹簧；点击穿透也由 Rust 按「光标在命中区」整窗切换。
 * 窗口固定画布（CANVAS_W × CANVAS_H）永不 resize，展开/收起是画布内的 DOM 形变。
 *
 * P1：胶囊可水平拖动换位（位移喂 Rust 换算偏移比例，松手回存设置 islandOffsetX，
 * 拖动期间 Rust 侧抑制展开）；额度告警激活时胶囊临时加宽为横幅（命中区同步放宽），
 * 数秒后自动收回，点击打开主窗口。
 */
export function IslandWindow() {
  // 豁免全局 body 底色（styles.css 的 island-canvas 规则）：透明窗口的画布必须透出桌面
  useEffect(() => {
    document.documentElement.classList.add("island-canvas");
    return () => document.documentElement.classList.remove("island-canvas");
  }, []);

  const vaultStatus = useAppStore((state) => state.vaultStatus);
  const settings = useAppStore((state) => state.settings);
  const instances = useAppStore((state) => state.instances);
  const snapshots = useAppStore((state) => state.snapshots);
  const refreshingInstances = useAppStore((state) => state.refreshingInstances);
  const loading = useAppStore((state) => state.loading);
  const refreshAll = useAppStore((state) => state.refreshAll);
  const alertActiveMap = useAlertStore((state) => state.active);
  const t = useT();
  const language = useLanguage();
  const resetDisplay = useAppStore((state) => state.settings.resetTimeDisplay);
  const now = useNow();
  const islandEnabled = settings.islandEnabled;
  // 拖动贴边时 Rust 会改停靠边（松手才回存设置）：本地 state 让形态立刻跟上，
  // 设置里已有的值作为初值/兜底
  const [liveDock, setLiveDock] = useState<IslandDock>(settings.islandDock);
  const dock = liveDock;

  // persistent 模式：无失焦隐藏/无 Esc（岛永不获焦），panelVisible 恒真使快照照常回流
  const { ready } = usePanelWindow({ shownEvent: "island-shown", persistent: true });
  // 自动刷新按岛的启用状态门控：禁用时隐藏的 webview 不驱动任何抓取（ADR-0023）
  usePanelAutoRefresh(ready && islandEnabled);

  const clock = useIslandClock(islandEnabled);

  const anyAlert = Object.values(alertActiveMap).some(Boolean);
  const refreshing = loading || Object.values(refreshingInstances).some(Boolean);

  const glanceItems = useMemo(
    () =>
      buildGlanceInstances(instances, snapshots, {
        alertActive: alertActiveMap,
        refreshing: refreshingInstances,
        loading,
        translate: t,
        language,
      }),
    [instances, snapshots, alertActiveMap, refreshingInstances, loading, t, language],
  );
  const overallTightest = useMemo(() => pickOverallTightest(glanceItems), [glanceItems]);

  async function openMain() {
    await invoke("open_main_window");
  }

  // ---- 形变弹簧：进度 0=收起 1=展开 + 横幅宽度弹簧，直接写 DOM 不走 React 渲染 ----
  const morphRef = useRef<HTMLDivElement>(null);
  const pillLayerRef = useRef<HTMLDivElement>(null);
  const panelLayerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(new Spring(0, CLOSE_TUNING));
  const pillWidthRef = useRef(new Spring(PILL_W, BANNER_TUNING));
  // 当前停靠边：帧循环读它决定形变轴向（设置变更时同步）
  const dockRef = useRef<IslandDock>(settings.islandDock);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number>(0);
  // 帧循环点火口：tick 住在挂载效应的闭包里，外部（横幅/拖动后的宽度变化）经此点火
  const kickRef = useRef<() => void>(() => undefined);
  // 拿起即收起：beginDrag 经此立刻把前端弹簧打向收起态。不等 Rust 的 island-collapsed——
  // 控制线程空闲时 50ms 一拍 + 事件往返，表现为「抓住把手后面板还停留一小段」的迟滞
  const collapseNowRef = useRef<() => void>(() => undefined);
  // 横幅显示中的收回定时器
  const bannerTimerRef = useRef<number | null>(null);

  // ---- 告警横幅：激活边沿触发，自动收回；展开面板时取消（面板内已有告警呈现） ----
  const [banner, setBanner] = useState<string | null>(null);
  // 本次会话内已弹过横幅的实例：同一实例反复跨阈值不再重复打扰
  //（告警本身仍由通知中心与托盘红点持续投影，岛只承担「一次性提示」角色）
  const bannerShownRef = useRef<Set<string>>(new Set());

  function hideBanner() {
    if (bannerTimerRef.current != null) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = null;
    setBanner(null);
    pillWidthRef.current.tune(BANNER_TUNING);
    pillWidthRef.current.target = PILL_W;
    kickRef.current();
    void invoke("set_island_banner_width", { width: 0 }).catch(() => undefined);
  }

  function showBanner(text: string) {
    if (bannerTimerRef.current != null) window.clearTimeout(bannerTimerRef.current);
    setBanner(text);
    pillWidthRef.current.tune(BANNER_TUNING);
    pillWidthRef.current.target = BANNER_W;
    kickRef.current();
    void invoke("set_island_banner_width", { width: BANNER_W }).catch(() => undefined);
    bannerTimerRef.current = window.setTimeout(() => hideBanner(), BANNER_MS);
  }

  // 事件回调里要拿最新列表：经 ref 透传（事件管道只建一次）
  const glanceItemsRef = useRef(glanceItems);
  glanceItemsRef.current = glanceItems;

  // 注意用 useLayoutEffect 而非 useEffect：morph 容器没有 React style 属性（见 JSX 注释），
  // 首次绘制前的几何全靠这里的 apply() 写入——useEffect 在首帧绘制后才跑，会闪出一帧
  // 未定位的空画布
  useLayoutEffect(() => {
    // 上次写入的圆角：只在明显变化时改样式，避免逐帧触发重绘（effect 内局部变量，
    // 不随 React 重渲染重置）
    let lastRadius = 16;

    function kick() {
      if (frameRef.current != null) return;
      lastFrameAtRef.current = performance.now();
      frameRef.current = requestAnimationFrame(tick);
    }

    function tick() {
      const progress = progressRef.current;
      const pillWidth = pillWidthRef.current;
      const timestamp = performance.now();
      const dt = (timestamp - lastFrameAtRef.current) / 1000;
      progress.step(dt);
      pillWidth.step(dt);
      lastFrameAtRef.current = timestamp;
      apply(progress.pos, pillWidth.pos);
      if (progress.settled() && pillWidth.settled()) {
        apply(progress.target, pillWidth.target);
        frameRef.current = null;
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    }

    function apply(p: number, pillW: number) {
      const morph = morphRef.current;
      const pill = pillLayerRef.current;
      const panel = panelLayerRef.current;
      if (!morph) return;
      const progress = clamp01(p);
      // 收起/展开的起止尺寸随停靠边变化：
      // - 顶部：胶囊 196×40 → 面板 424×284（横向）
      // - 侧边：胶囊 36×132 → 面板 424×284（竖向贴边，宽度向屏内长出）
      const side = dockRef.current !== "top";
      const fromW = side ? SIDE_PILL_W : pillW;
      const fromH = side ? SIDE_PILL_H : PILL_H;
      const toW = side ? SIDE_PANEL_W : PANEL_W;
      const toH = side ? SIDE_PANEL_H : PANEL_H;
      const width = lerp(fromW, toW, progress);
      const height = lerp(fromH, toH, progress);
      // 用 width/height 而非 transform:scale——scale 会连内容一起压扁。
      morph.style.width = `${width.toFixed(2)}px`;
      morph.style.height = `${height.toFixed(2)}px`;
      // 圆角：顶部胶囊半高起、侧边胶囊半宽起，都收敛到面板 16px
      const fromRadius = side ? SIDE_PILL_W / 2 : PILL_H / 2;
      const radius = lerp(fromRadius, 16, progress);
      if (Math.abs(radius - lastRadius) > 0.5) {
        morph.style.borderRadius = `${radius.toFixed(1)}px`;
        lastRadius = radius;
      }
      // 位置：侧边贴所在边、竖直居中；顶部水平居中。全部写内联样式（元素不受 React 控制）
      if (side) {
        const right = dockRef.current === "right";
        morph.style.left = right ? "auto" : "6px";
        morph.style.right = right ? "6px" : "auto";
        morph.style.marginInline = "0";
        morph.style.top = `${(SIDE_CANVAS_H - height) / 2}px`;
      } else {
        morph.style.left = "0";
        morph.style.right = "0";
        morph.style.marginInline = "auto";
        morph.style.top = `${PILL_TOP}px`;
      }
      if (pill) {
        pill.style.opacity = String(1 - smoothstep(PILL_FADE[0], PILL_FADE[1], progress));
        pill.style.pointerEvents = progress < 0.5 ? "auto" : "none";
      }
      if (panel) {
        panel.style.opacity = String(smoothstep(PANEL_FADE[0], PANEL_FADE[1], progress));
        panel.style.pointerEvents = progress >= 0.5 ? "auto" : "none";
      }
    }

    function setTarget(expanded: boolean) {
      const spring = progressRef.current;
      spring.tune(expanded ? OPEN_TUNING : CLOSE_TUNING);
      spring.target = expanded ? 1 : 0;
      if (expanded && bannerTimerRef.current != null) hideBanner();
      kick();
    }

    kickRef.current = kick;
    collapseNowRef.current = () => setTarget(false);
    // 挂载即画一次当前状态：保证首帧尺寸/圆角/透明度与弹簧初值一致，
    // 不依赖事件到达（否则窗口刚显示时会停在 JSX 的初始样式上）
    apply(progressRef.current.pos, pillWidthRef.current.pos);
    // 向 Rust 运行时问一次权威停靠边：store 的 settings 初值是默认 "top"，落库值要等
    // loadInitial 完成，而 island-dock-changed 只在真正换边时才发——若落库是 left/right，
    // 前端会一直按顶边画形（侧边画布上横排胶囊，位置/形态全错且永不自愈）
    void invoke<string>("get_island_dock")
      .then((next) => {
        const dockNow = next as IslandDock;
        if (dockNow === dockRef.current) return;
        dockRef.current = dockNow;
        setLiveDock(dockNow);
        apply(progressRef.current.pos, pillWidthRef.current.pos);
      })
      .catch(() => undefined);
    const unlisteners = [
      listen("island-expanded", () => setTarget(true)),
      listen("island-collapsed", () => setTarget(false)),
      // 拖动贴边换边：Rust 侧已换好画布尺寸与停靠边，前端立刻重画一帧
      //（dockRef 在下次渲染时才更新，这里直接同步）
      listen<string>("island-dock-changed", () => {
        void invoke<string>("get_island_dock")
          .then((next) => {
            const dockNow = next as IslandDock;
            // ref 供帧循环立即重画；state 让 JSX 换成对应的胶囊内容（竖排/横排）
            dockRef.current = dockNow;
            setLiveDock(dockNow);
            apply(progressRef.current.pos, pillWidthRef.current.pos);
          })
          .catch(() => undefined);
      }),
    ];
    return () => {
      kickRef.current = () => undefined;
      for (const promise of unlisteners) void promise.then((unlisten) => unlisten());
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (bannerTimerRef.current != null) window.clearTimeout(bannerTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 事件管道只建一次；回调经 ref 访问最新状态
  }, []);

  // settings.islandDock 变化时同步 dockRef/liveDock：settings-changed 由 usePanelWindow
  // 处理（只写 store），不会动本组件的 liveDock；若不同步，主窗口侧的设置落库（或
  // loadInitial 补齐落库值）会让「设置里的停靠边」与「正在画的形」长期分叉。
  // 分歧时不盲信设置值，向 Rust 运行时问权威值——拖动换边后回存失败（saveSettings
  // 抛错被吞）时设置是旧的，Rust 的 dock 才是事实源。拖动中 Rust 实时换边不会触发
  // 本 effect（settings 未变），island-dock-changed 已单独同步。
  // islandEnabled 也在依赖里：启动时岛是禁用的话，Rust 运行时的 dock 一直停在默认
  // top，此后用户重新启用（set_island_enabled 会先从库里读 dock 设好运行时、再由
  // 设置页落设置），islandDock 设置值不变、dock-changed 也不发——必须借这次重渲染
  // 重新对账，否则侧边停靠的岛会按顶边形态画。
  const islandDockSetting = settings.islandDock;
  const islandEnabledSetting = settings.islandEnabled;
  useEffect(() => {
    if (dockRef.current === islandDockSetting) return;
    void invoke<string>("get_island_dock")
      .then((next) => {
        const dockNow = next as IslandDock;
        if (dockNow === dockRef.current) return;
        dockRef.current = dockNow;
        setLiveDock(dockNow);
        kickRef.current();
      })
      .catch(() => undefined);
  }, [islandDockSetting, islandEnabledSetting]);

  // 逐实例监听激活边沿（anyAlert 的 false→true 会漏掉「已有一条告警时又来一条」）；
  // 主窗口是唯一评估方（ADR-0022），本窗口只消费广播
  useEffect(() => {
    if (!islandEnabled) return;
    const promise = listen<{ instanceId: string; active: boolean }>("alert-state-changed", (event) => {
      if (!event.payload.active) return;
      // 同一实例本次会话只弹一次：连续越阈值/多规则同时触发时不再连环打断
      if (bannerShownRef.current.has(event.payload.instanceId)) return;
      bannerShownRef.current.add(event.payload.instanceId);
      const item = glanceItemsRef.current.find((entry) => entry.id === event.payload.instanceId);
      showBanner(item ? `${item.label} ${t("额度告警")}` : t("额度告警"));
    });
    return () => {
      void promise.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- showBanner 只依赖稳定 ref 与 setBanner
  }, [islandEnabled, t]);

  // ---- 拖动换位（对齐岛仔）：展开面板顶部整块是拖动区，悬停 0.3s 才浮现一根指示条；
  // 位移换算全在 Rust 控制线程里做（前端只发 begin/end），避免窗口跟随导致的相对坐标抖动 ----
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const dragActiveRef = useRef(false);

  function beginDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId };
    dragActiveRef.current = true;
    // 拿起即收起：立刻把前端弹簧打向收起态（拖动时以收起态胶囊移动，与岛仔一致）。
    // 不等 Rust 的 island-collapsed——控制线程空闲 50ms 一拍再发事件，抓住把手后面板
    // 会先停留一小段才动，正是「形态变化滞后」的观感之一。Rust 随后照发同一事件，
    // setTarget(false) 幂等。
    collapseNowRef.current();
    void invoke("begin_island_drag").catch(() => {
      dragActiveRef.current = false;
      dragRef.current = null;
    });
    // 拖动中抑制展开（Rust 侧状态机已按 dragging 抑制；这里再报一次保险）
    kickRef.current();
  }

  async function finishDrag(persist: boolean) {
    if (!dragRef.current) return;
    dragRef.current = null;
    dragActiveRef.current = false;
    try {
      const offset = await invoke<number>("end_island_drag");
      if (!persist) return;
      // 停靠边可能在拖动中因贴边而切换：与偏移一起回存，
      // 否则重启后岛会回到旧边、偏移却按新轴解释
      const dock = await invoke<string>("get_island_dock").catch(() => null);
      const current = useAppStore.getState().settings;
      const nextDock = (dock as "top" | "left" | "right" | null) ?? current.islandDock;
      if (current.islandOffsetX !== offset || current.islandDock !== nextDock) {
        await useAppStore.getState().saveSettings({
          ...current,
          islandOffsetX: offset,
          islandDock: nextDock,
        });
      }
    } catch {
      // 回存失败不影响本次拖动效果，下次拖动会重新落
    }
  }

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden bg-transparent">
      {/* morph 容器：胶囊/面板共用的外形层（尺寸、圆角、边框、底色、阴影）。
          位置与尺寸由帧循环的 apply() 按停靠边逐帧写入；这里刻意不带 React style——
          首帧几何由挂载效应（useLayoutEffect 里的 apply()）在绘制前写入，见上方注释。
          阴影收紧（0 6px 18px）：面板距画布边缘仅 10–50px，大扩散阴影会被窗口裁成方形残影。 */}
      <div
        ref={morphRef}
        className="absolute overflow-hidden bg-surface/90 shadow-island ring-1 ring-island-edge ring-inset"
        // 尺寸/位置/圆角全部由帧循环 apply() 逐帧写入。这里刻意不给 style：
        // React 每次重渲染都会用它覆盖掉帧循环刚写的值，拖动/动画中表现为「卡住不动」。
      >
        {/* 收起态内容：横幅优先于常规胶囊；点击打开主窗口（收起态不提供拖动，
            与岛仔一致——先悬停展开，再拖顶部的把手）。
            容器布局按整幅面板排，胶囊内容按自身尺寸居中——外层 scale 缩回时
            正好落到顶部居中的胶囊位置，内容不发生重排 */}
        {/* 胶囊层：内容行高固定 40px（胶囊视觉高度），容器变高时保持垂直居中不拉伸。
            宽度铺满容器——横幅加宽时内容随之铺开 */}
        <div
          ref={pillLayerRef}
          className="absolute inset-0 flex items-center justify-center"
        >
          <div className="h-10 w-full shrink-0">
            {banner != null ? (
              <button
                type="button"
                onClick={() => void openMain()}
                className="h-full w-full cursor-pointer bg-transparent"
                title={t("打开主窗口")}
              >
                <div
                  className={cn(
                    "flex h-full w-full items-center justify-center gap-2",
                    dock === "top" ? "px-3" : "flex-col px-1 py-2",
                  )}
                >
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
                  <span
                    className={cn(
                      "min-w-0 text-[12px] font-medium text-fg",
                      dock === "top" ? "truncate" : "line-clamp-3 text-center text-[10px]",
                    )}
                    title={banner}
                  >
                    {banner}
                  </span>
                </div>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void openMain()}
                aria-label={t("打开主窗口")}
                title={t("打开主窗口")}
                className="h-full w-full cursor-pointer bg-transparent focus-visible:outline-none"
              >
                {dock === "top" ? (
                  <IslandPillContent
                    time={clock}
                    tightest={overallTightest}
                    alertActive={anyAlert}
                    translate={t}
                  />
                ) : (
                  <IslandPillSideContent
                    time={clock}
                    tightest={overallTightest}
                    alertActive={anyAlert}
                    translate={t}
                  />
                )}
              </button>
            )}
          </div>
        </div>
        {/* 展开态内容：铺满容器、绝对定位在左上，随容器尺寸裁剪。
            容器展开到面板尺寸时它正好完整可见；收起时被 overflow-hidden 裁掉 */}
        <div
          ref={panelLayerRef}
          className="pointer-events-none absolute inset-0 opacity-0"
        >
          <IslandPanelContent
            items={glanceItems}
            vaultUnlocked={vaultStatus?.unlocked ?? false}
            refreshing={refreshing}
            translate={t}
            language={language}
            resetDisplay={resetDisplay}
            now={now}
            layout={settings.islandLayout}
            onLayoutChange={(layout) => {
              void useAppStore.getState().saveSettings({
                ...useAppStore.getState().settings,
                islandLayout: layout,
              });
            }}
            onOpenMain={() => void openMain()}
            onRefresh={() => void refreshAll()}
            onDragStart={beginDrag}
            onDragEnd={(persist) => void finishDrag(persist)}
          />
        </div>
      </div>
    </div>
  );
}

/** 全实例最紧读数：已用百分比最高者，平手取重置更近者（与速览单实例口径一致，ADR-0020） */
function pickOverallTightest(items: GlanceInstance[]): GlanceInstance | null {
  let best: GlanceInstance | null = null;
  for (const item of items) {
    if (item.tightestPercent == null) continue;
    if (
      !best ||
      item.tightestPercent > (best.tightestPercent ?? -1) ||
      (item.tightestPercent === best.tightestPercent &&
        resetDistance(item.tightestResetsAt) < resetDistance(best.tightestResetsAt))
    ) {
      best = item;
    }
  }
  return best;
}

function resetDistance(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}
