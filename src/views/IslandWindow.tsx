import { useEffect, useMemo, useRef, useState } from "react";
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
  PANEL_H,
  PANEL_W,
  PILL_FADE,
  PILL_H,
  PILL_TOP,
  PILL_W,
} from "../components/island/constants";
import { Spring, clamp01, lerp, smoothstep } from "../lib/spring";
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
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number>(0);
  // 帧循环点火口：tick 住在挂载效应的闭包里，外部（横幅/拖动后的宽度变化）经此点火
  const kickRef = useRef<() => void>(() => undefined);
  // 横幅显示中的收回定时器
  const bannerTimerRef = useRef<number | null>(null);

  // ---- 告警横幅：激活边沿触发，自动收回；展开面板时取消（面板内已有告警呈现） ----
  const [banner, setBanner] = useState<string | null>(null);

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

  useEffect(() => {
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
      // 容器尺寸：收起态=胶囊宽高，展开态=面板宽高，中间按弹簧进度插值。
      // 用 width/height 而非 transform:scale——scale 会连内容一起压扁。
      const progress = clamp01(p);
      const width = lerp(pillW, PANEL_W, progress);
      const height = lerp(PILL_H, PANEL_H, progress);
      morph.style.width = `${width.toFixed(2)}px`;
      morph.style.height = `${height.toFixed(2)}px`;
      // 圆角在胶囊半高与面板 16px 之间插值；按 0.5px 量化避免逐帧重绘
      const radius = lerp(PILL_H / 2, 16, progress);
      if (Math.abs(radius - lastRadius) > 0.5) {
        morph.style.borderRadius = `${radius.toFixed(1)}px`;
        lastRadius = radius;
      }
      if (pill) {
        pill.style.opacity = String(1 - smoothstep(PILL_FADE[0], PILL_FADE[1], progress));
        pill.style.pointerEvents = progress < 0.5 ? "auto" : "none";
        // 胶囊内容以容器为参照，容器宽度变化时内容随之压缩，不需要额外定位
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
    // 拿起即收起：拖动时以收起态胶囊移动，与岛仔一致（drag_lift 视觉放大由 CSS 提供）
    void invoke("begin_island_drag").catch(() => {
      dragActiveRef.current = false;
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
      {/* morph 容器：胶囊/面板共用的外形层（尺寸、圆角、边框、底色、阴影）。
          用 margin auto 水平居中（不用 left-1/2 + translate，避免与动画变换叠乘）；
          尺寸按进度逐帧改写，contain 把重排/重绘范围锁死在岛内部。
          阴影收紧（0 6px 18px）：面板距画布边缘仅 10–50px，大扩散阴影会被窗口裁成方形残影。 */}
      <div
        ref={morphRef}
        className="absolute left-0 right-0 mx-auto overflow-hidden bg-surface/90 ring-1 ring-line ring-inset shadow-[0_6px_18px_rgba(0,0,0,0.40)]"
        style={{
          top: PILL_TOP,
          width: PILL_W,
          height: PILL_H,
          borderRadius: PILL_H / 2,
        }}
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
                <div className="flex h-full w-full items-center justify-center gap-2 px-3">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-warning" />
                  <span className="min-w-0 truncate text-[12px] font-medium text-fg" title={banner}>
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
