import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePanelAutoRefresh, usePanelWindow } from "../hooks/use-panel-window";
import { useNow } from "../hooks/use-now";
import { buildGlanceInstances, type GlanceInstance } from "../components/glance/data";
import { IslandPillContent, useIslandClock } from "../components/island/IslandPill";
import { IslandPanelContent } from "../components/island/IslandPanel";
import {
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
import { Spring, lerp, smoothstep } from "../lib/spring";
import { useAppStore } from "../store/useAppStore";
import { useAlertStore } from "../store/useAlertStore";
import { useLanguage, useT } from "../i18n";

/**
 * 灵动岛窗口（ADR-0047）：常驻屏幕顶部工作区居中的透明胶囊，悬停驻留展开、离开收起。
 * 展开判定在 Rust 控制器（src-tauri/src/island_window.rs）——本视图只听 island-expanded /
 * island-collapsed 事件驱动形变弹簧；点击穿透也由 Rust 按「光标在命中区」整窗切换。
 * 窗口固定画布（CANVAS_W × CANVAS_H）永不 resize，展开/收起是画布内的 DOM 形变。
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

  // ---- 形变弹簧：进度 0=收起 1=展开，直接写 DOM 不走 React 渲染 ----
  const morphRef = useRef<HTMLDivElement>(null);
  const pillLayerRef = useRef<HTMLDivElement>(null);
  const panelLayerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(new Spring(0, CLOSE_TUNING));
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number>(0);

  useEffect(() => {
    function setTarget(expanded: boolean) {
      const spring = progressRef.current;
      spring.tune(expanded ? OPEN_TUNING : CLOSE_TUNING);
      spring.target = expanded ? 1 : 0;
      if (frameRef.current == null) {
        lastFrameAtRef.current = performance.now();
        frameRef.current = requestAnimationFrame(tick);
      }
    }
    function tick() {
      const spring = progressRef.current;
      const timestamp = performance.now();
      spring.step((timestamp - lastFrameAtRef.current) / 1000);
      lastFrameAtRef.current = timestamp;
      apply(spring.pos);
      if (spring.settled()) {
        apply(spring.target);
        frameRef.current = null;
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    }
    function apply(p: number) {
      const morph = morphRef.current;
      const pill = pillLayerRef.current;
      const panel = panelLayerRef.current;
      if (!morph) return;
      morph.style.width = `${lerp(PILL_W, PANEL_W, p)}px`;
      morph.style.height = `${lerp(PILL_H, PANEL_H, p)}px`;
      morph.style.borderRadius = `${lerp(PILL_H / 2, 16, p)}px`;
      if (pill) {
        pill.style.opacity = String(1 - smoothstep(PILL_FADE[0], PILL_FADE[1], p));
        pill.style.pointerEvents = p < 0.5 ? "auto" : "none";
      }
      if (panel) {
        panel.style.opacity = String(smoothstep(PANEL_FADE[0], PANEL_FADE[1], p));
        panel.style.pointerEvents = p >= 0.5 ? "auto" : "none";
      }
    }
    const unlisteners = [
      listen("island-expanded", () => setTarget(true)),
      listen("island-collapsed", () => setTarget(false)),
    ];
    return () => {
      for (const promise of unlisteners) void promise.then((unlisten) => unlisten());
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  return (
    <div className="h-screen w-screen select-none overflow-hidden bg-transparent">
      {/* morph 容器：胶囊/面板共用的外形层（尺寸、圆角、边框、底色、阴影）。
          阴影刻意收紧（0 6px 18px）而非 shadow-pop：展开态面板距画布边缘只有
          10–50px，大扩散阴影会被窗口边缘裁成方形残影。
          悬停轻微胀大（对应岛仔 SWELL 预览）：CSS transform 独立于 JS 驱动的宽高形变 */}
      <div
        ref={morphRef}
        className="absolute left-1/2 origin-top -translate-x-1/2 overflow-hidden border border-line bg-surface/90 shadow-[0_6px_18px_rgba(0,0,0,0.40)] transition-transform duration-100 hover:scale-[1.03]"
        style={{ top: PILL_TOP, width: PILL_W, height: PILL_H, borderRadius: PILL_H / 2 }}
      >
        {/* 收起态内容：点击打开主窗口 */}
        <div ref={pillLayerRef} className="absolute inset-0 cursor-pointer">
          <button
            type="button"
            onClick={() => void openMain()}
            aria-label={t("打开主窗口")}
            title={t("打开主窗口")}
            className="h-full w-full bg-transparent focus-visible:outline-none"
          >
            <IslandPillContent
              time={clock}
              tightest={overallTightest}
              alertActive={anyAlert}
              translate={t}
            />
          </button>
        </div>
        {/* 展开态内容：固定面板尺寸，画布居中，被容器按形变进度裁剪 */}
        <div
          ref={panelLayerRef}
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 opacity-0"
          style={{ width: PANEL_W, height: PANEL_H }}
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
