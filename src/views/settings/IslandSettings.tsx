import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LayoutGrid, List } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useAlertStore } from "../../store/useAlertStore";
import { buildGlanceInstances } from "../../components/glance/data";
import { IslandPillContent, useIslandClock } from "../../components/island/IslandPill";
import {
  PILL_FLARE,
  PILL_FLARE_H,
  PILL_H,
  PILL_RADIUS,
  PILL_W,
} from "../../components/island/constants";
import { islandOutlinePath } from "../../components/island/shape";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { HintTooltip } from "../../components/ui/tooltip";
import { Label } from "../../components/ui/label";
import { Segmented } from "../../components/ui/segmented";
import { Switch } from "../../components/ui/switch";
import { useLanguage, useT } from "../../i18n";
import { SavedHint, useSaveFlash } from "./save-flash";

/** 预览的静态轮廓：与 IslandWindow 帧循环用同一个生成函数，所见即所得 */
const PILL_OUTLINE = islandOutlinePath(PILL_W, PILL_H, PILL_FLARE, PILL_FLARE_H, PILL_RADIUS);
const PILL_RIM = islandOutlinePath(PILL_W, PILL_H, PILL_FLARE, PILL_FLARE_H, PILL_RADIUS, {
  inset: 0.5,
  close: false,
});

/**
 * 灵动岛设置卡（ADR-0047）：开关 + 实时胶囊预览。
 * 开关走 invoke-then-save（同快速面板快捷键模式）：先让 Rust 起停窗口与控制线程，
 * 成功后才落设置——失败时设置不写库，UI 与实际窗口状态不脱节。
 */
export function IslandSettings() {
  const settings = useAppStore((state) => state.settings);
  const instances = useAppStore((state) => state.instances);
  const snapshots = useAppStore((state) => state.snapshots);
  const refreshingInstances = useAppStore((state) => state.refreshingInstances);
  const loading = useAppStore((state) => state.loading);
  const alertActiveMap = useAlertStore((state) => state.active);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const saveFlash = useSaveFlash();
  const t = useT();
  const language = useLanguage();

  async function toggle(value: boolean) {
    try {
      await invoke("set_island_enabled", { enabled: value });
    } catch (error) {
      // 起停失败不落设置：控制台留痕即可，开关状态原样弹回
      console.error("切换灵动岛失败：", error);
      return;
    }
    const current = useAppStore.getState().settings;
    await saveSettings({ ...current, islandEnabled: value });
    saveFlash.flash();
  }

  const anyAlert = Object.values(alertActiveMap).some(Boolean);
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
  const tightest = useMemo(
    () =>
      glanceItems.reduce<(typeof glanceItems)[number] | null>((best, item) => {
        if (item.tightestPercent == null) return best;
        if (!best || item.tightestPercent > (best.tightestPercent ?? -1)) return item;
        return best;
      }, null),
    [glanceItems],
  );
  const clock = useIslandClock(true);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{t("灵动岛")}</CardTitle>
          <CardDescription>{t("屏幕顶部的常驻胶囊：悬停展开查看各实例额度。")}</CardDescription>
        </div>
        <SavedHint visible={saveFlash.visible} />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-1.5">
              <Label>{t("显示灵动岛")}</Label>
              <HintTooltip
                tip={t(
                  "开启后屏幕顶部居中出现常驻胶囊：平时显示时间与最紧额度，鼠标悬停展开完整列表，点击胶囊打开主窗口。",
                )}
              />
            </div>
            <p className="mt-1 text-[13px] text-fg-muted">
              {t("与托盘速览互补：岛常驻可见，速览按需弹出。")}
            </p>
          </div>
          <Switch
            checked={settings.islandEnabled}
            onCheckedChange={(value) => void toggle(value)}
          />
        </div>

        {/* 实时预览：与岛上胶囊同一组件、同一条轮廓（肩部 + 底部圆角），数据即时反映。
            顶部不留内边距——胶囊顶边贴着预览框上缘，演示「从屏幕边缘长出来」的形态 */}
        <div className="flex items-start justify-center rounded-lg border border-dashed border-line-strong bg-canvas px-4 pb-5">
          <div className="relative" style={{ width: PILL_W, height: PILL_H }}>
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{ filter: "var(--island-filter-shadow)" }}
            >
              <svg className="absolute inset-0 h-full w-full">
                <defs>
                  <linearGradient id="island-preview-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" style={{ stopColor: "var(--island-fill-top)" }} />
                    <stop offset="1" style={{ stopColor: "var(--island-fill-bottom)" }} />
                  </linearGradient>
                </defs>
                <path d={PILL_OUTLINE} fill="url(#island-preview-fill)" />
              </svg>
            </div>
            <div
              className="absolute inset-y-0 overflow-hidden"
              style={{
                left: PILL_FLARE,
                right: PILL_FLARE,
                borderBottomLeftRadius: PILL_RADIUS,
                borderBottomRightRadius: PILL_RADIUS,
              }}
            >
              <IslandPillContent
                time={clock}
                tightest={tightest}
                alertActive={anyAlert}
                translate={t}
              />
            </div>
            <svg
              aria-hidden
              className="pointer-events-none absolute inset-0 h-full w-full"
            >
              <path d={PILL_RIM} fill="none" className="stroke-island-edge" strokeWidth={1} />
            </svg>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Label>{t("展开面板样式")}</Label>
            <HintTooltip tip={t("悬停展开后的实例列表展示方式，与速览面板的两种形态一致。")} />
          </div>
          <Segmented
            size="sm"
            value={settings.islandLayout}
            onChange={(value) =>
              void saveSettings({ ...useAppStore.getState().settings, islandLayout: value })
            }
            options={[
              { value: "list", label: t("列表"), icon: <List className="h-3.5 w-3.5" /> },
              { value: "cards", label: t("卡片"), icon: <LayoutGrid className="h-3.5 w-3.5" /> },
            ]}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <Label>{t("位置")}</Label>
            <HintTooltip
              tip={t(
                "岛贴在屏幕顶边，看起来像是从屏幕边缘垂下来的一个页签。悬停展开后按住标题栏中间的指示条可左右拖动换位，松手自动吸附在屏内。",
              )}
            />
          </div>
          <span className="shrink-0 text-[13px] text-fg-muted">{t("屏幕顶边（可左右拖动）")}</span>
        </div>
      </CardContent>
    </Card>
  );
}
