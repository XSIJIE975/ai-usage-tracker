import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TriangleAlert } from "lucide-react";
import { usePanelAutoRefresh, usePanelWindow } from "../hooks/use-panel-window";
import { useNow } from "../hooks/use-now";
import { buildGlanceInstances, type GlanceInstance } from "../components/glance/data";
import { IslandPillContent, useIslandClock } from "../components/island/IslandPill";
import { IslandPanelContent } from "../components/island/IslandPanel";
import {
  BANNER_MS,
  BANNER_TUNING,
  BANNER_W,
  CLOSE_TUNING,
  OPEN_TUNING,
  PANEL_FADE,
  PANEL_FLARE,
  PANEL_FLARE_H,
  PANEL_H,
  PANEL_OUTER_W,
  PANEL_RADIUS,
  PILL_FADE,
  PILL_FLARE,
  PILL_FLARE_H,
  PILL_H,
  PILL_RADIUS,
  PILL_TOP,
  PILL_W,
} from "../components/island/constants";
import { islandOutlinePath } from "../components/island/shape";
import { Spring, clamp01, lerp, smoothstep } from "../lib/spring";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { useLanguage, useT } from "../i18n";


/**
 * 灵动岛窗口（ADR-0047）：**从屏幕顶边长出来的**常驻面板，悬停驻留展开、离开收起。
 * 轮廓不是圆角矩形：顶边与工作区顶边齐平，两侧在顶边向外翻出肩部、再收敛到竖直侧边
 * （几何见 components/island/shape.ts）——视觉上它是显示屏的一部分，而不是浮在桌面上的
 * 一颗胶囊。描边沿同一条轮廓绘制、顶部敞开；投影用 drop-shadow 跟随轮廓 alpha。
 * 展开判定在 Rust 控制器（src-tauri/src/island_window.rs）——本视图只听 island-expanded /
 * island-collapsed 事件驱动形变弹簧；点击穿透也由 Rust 按「光标在命中区」整窗切换。
 * 窗口固定画布（CANVAS_W × CANVAS_H）永不 resize，展开/收起是画布内的 DOM 形变。
 *
 * P1：胶囊可沿顶边拖动换位（位移喂 Rust 换算偏移比例，松手回存设置 islandOffsetX，
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
  // 内容区（轮廓本体，左右让出肩部）与两条 SVG 路径：尺寸/曲线都逐帧同步写入
  const bodyRef = useRef<HTMLDivElement>(null);
  const surfacePathRef = useRef<SVGPathElement>(null);
  const rimPathRef = useRef<SVGPathElement>(null);
  const pillLayerRef = useRef<HTMLDivElement>(null);
  const panelLayerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(new Spring(0, CLOSE_TUNING));
  const pillWidthRef = useRef(new Spring(PILL_W, BANNER_TUNING));
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
      const body = bodyRef.current;
      const pill = pillLayerRef.current;
      const panel = panelLayerRef.current;
      if (!morph) return;
      const progress = clamp01(p);
      // 形变：胶囊（160×32，横幅期间更宽）→ 面板（含肩部 456×284）。
      // 宽度/高度/肩部/圆角一起插值——轮廓始终是一条连续曲线，不做形态交叉淡入
      const width = lerp(pillW, PANEL_OUTER_W, progress);
      const height = lerp(PILL_H, PANEL_H, progress);
      const flare = lerp(PILL_FLARE, PANEL_FLARE, progress);
      const flareHeight = lerp(PILL_FLARE_H, PANEL_FLARE_H, progress);
      const radius = lerp(PILL_RADIUS, PANEL_RADIUS, progress);
      // 用 width/height 而非 transform:scale——scale 会连内容一起压扁。
      morph.style.width = `${width.toFixed(2)}px`;
      morph.style.height = `${height.toFixed(2)}px`;
      // 位置：水平居中（拖动时偏移由窗口自身移动实现，画布内始终居中）；
      // 顶边贴住画布顶（= 工作区顶）。全部写内联样式（元素不受 React 控制）
      morph.style.left = "0";
      morph.style.right = "0";
      morph.style.marginInline = "auto";
      morph.style.top = `${PILL_TOP}px`;

      // 表面轮廓：顶部外翻肩部 + 竖直侧边 + 底部圆角。
      // 描边用内收 0.5px 的同一曲线（1px stroke 因此完整落在表面内侧），
      // 且不闭合——顶边贴着屏幕边缘，不画线
      surfacePathRef.current?.setAttribute(
        "d",
        islandOutlinePath(width, height, flare, flareHeight, radius),
      );
      rimPathRef.current?.setAttribute(
        "d",
        islandOutlinePath(width, height, flare, flareHeight, radius, {
          inset: 0.5,
          close: false,
        }),
      );

      // 内容区 = 轮廓本体（左右各让出肩部宽度）；底部圆角与轮廓同心，
      // 顶部直角藏在屏幕边缘。肩部区域只露表面，不被内容覆盖
      if (body) {
        body.style.left = `${flare.toFixed(2)}px`;
        body.style.right = `${flare.toFixed(2)}px`;
        body.style.borderBottomLeftRadius = `${radius.toFixed(2)}px`;
        body.style.borderBottomRightRadius = `${radius.toFixed(2)}px`;
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
    const unlisteners = [
      listen("island-expanded", () => setTarget(true)),
      listen("island-collapsed", () => setTarget(false)),
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
      const current = useAppStore.getState().settings;
      if (current.islandOffsetX !== offset) {
        await useAppStore.getState().saveSettings({ ...current, islandOffsetX: offset });
      }
    } catch {
      // 回存失败不影响本次拖动效果，下次拖动会重新落
    }
  }

  return (
    <div className="relative h-screen w-screen select-none overflow-hidden bg-transparent">
      {/* morph 容器：胶囊/面板共用的外形层。位置与尺寸由帧循环的 apply() 逐帧写入；
          这里刻意不带 React style——首帧几何由挂载效应（useLayoutEffect 里的 apply()）
          在绘制前写入，React 重渲染也不会覆盖帧循环。
          顶边贴着画布顶（= 工作区顶），轮廓顶部有外翻肩部：岛从屏幕边缘长出来，
          所以投影只向下投，画布上方的部分本来就落在屏幕外，不会被裁出残影。 */}
      <div ref={morphRef} className="absolute">
        {/* 表面层：肩部轮廓 + 竖直侧边 + 底部圆角（路径逐帧由 apply() 写入）。
            投影用 filter 的 drop-shadow 跟随轮廓 alpha——box-shadow 只能画矩形/
            圆角矩形，画不出肩部。本层不参与命中，点击交给上面的内容层 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ filter: "var(--island-filter-shadow)" }}
        >
          <svg className="absolute inset-0 h-full w-full">
            <defs>
              <linearGradient id="island-surface-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" style={{ stopColor: "var(--island-fill-top)" }} />
                <stop offset="1" style={{ stopColor: "var(--island-fill-bottom)" }} />
              </linearGradient>
            </defs>
            <path ref={surfacePathRef} fill="url(#island-surface-fill)" />
          </svg>
        </div>

        {/* 内容区 = 轮廓本体（左右各让出肩部宽度）。底部圆角靠同心的 inner radius
            裁切；肩部区域只露表面，不被内容覆盖。
            收起态内容：横幅优先于常规胶囊；点击打开主窗口（收起态不提供拖动，
            与岛仔一致——先悬停展开，再拖顶部的把手） */}
        <div ref={bodyRef} className="absolute inset-y-0 overflow-hidden">
          {/* 胶囊层：固定 32px 行高并锚在顶部，展开时内容不会随容器变高而下坠。
              宽度铺满本体——横幅加宽时内容随之铺开 */}
          <div
            ref={pillLayerRef}
            className="absolute inset-x-0 top-0 flex h-8 items-center justify-center"
          >
            <div className="h-full w-full shrink-0">
              {banner != null ? (
                <button
                  type="button"
                  onClick={() => void openMain()}
                  className="h-full w-full cursor-pointer bg-transparent"
                  title={t("打开主窗口")}
                >
                  <div className="flex h-full w-full items-center justify-center gap-2 px-3">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
                    <span
                      className="min-w-0 truncate text-[12px] font-medium text-fg"
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
                  <IslandPillContent
                    time={clock}
                    tightest={overallTightest}
                    alertActive={anyAlert}
                    translate={t}
                  />
                </button>
              )}
            </div>
          </div>
          {/* 展开态内容：铺满本体、绝对定位在左上，随容器尺寸裁剪。
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

        {/* 描边层：必须画在内容之上——面板内容会铺满本体（bg-canvas 不透明），
            画在内容下面的描边会被整条盖住。路径顶部敞开：顶边贴着屏幕边缘，
            画一条线会在屏幕顶上留一道缝；描边路径内收 0.5px，1px 线完整落在表面内 */}
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
        >
          <path ref={rimPathRef} fill="none" className="stroke-island-edge" strokeWidth={1} />
        </svg>
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
