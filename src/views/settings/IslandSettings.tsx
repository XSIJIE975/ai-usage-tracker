import { useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LayoutGrid, List } from "lucide-react";
import { useAppStore } from "../../store/useAppStore";
import { useAlertStore } from "../../store/useAlertStore";
import { buildGlanceInstances } from "../../components/glance/data";
import { IslandPillContent, useIslandClock } from "../../components/island/IslandPill";
import { PILL_H, PILL_W } from "../../components/island/constants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { HintTooltip } from "../../components/ui/tooltip";
import { Label } from "../../components/ui/label";
import { Segmented } from "../../components/ui/segmented";
import { Switch } from "../../components/ui/switch";
import { useLanguage, useT } from "../../i18n";
import { SavedHint, useSaveFlash } from "./save-flash";

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

        {/* 实时预览：与岛上胶囊同一组件渲染，数据即时反映 */}
        <div className="flex items-center justify-center rounded-lg border border-dashed border-line-strong bg-canvas px-4 py-5">
          <div
            className="flex items-center overflow-hidden rounded-full border border-line bg-surface shadow-pop"
            style={{ width: PILL_W, height: PILL_H }}
          >
            <IslandPillContent time={clock} tightest={tightest} alertActive={anyAlert} translate={t} />
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
            <Label>{t("停靠位置")}</Label>
            <HintTooltip
              tip={t(
                "拖动岛的顶部把手靠近屏幕任意一边即可吸附过去：贴顶为横向胶囊，贴左右两侧为竖向胶囊，展开面板朝屏幕内侧伸出。",
              )}
            />
          </div>
          <span className="shrink-0 text-[13px] text-fg-muted">
            {settings.islandDock === "top"
              ? t("屏幕顶部")
              : settings.islandDock === "left"
                ? t("贴左侧")
                : t("贴右侧")}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
