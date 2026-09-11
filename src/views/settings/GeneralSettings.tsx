import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { HintTooltip } from "../../components/ui/tooltip";
import { Label } from "../../components/ui/label";
import { Select } from "../../components/ui/select";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { useAppStore } from "../../store/useAppStore";
import { formatRefreshLabel } from "../../lib/utils";
import type { AppSettings } from "../../types/ipc";
import { AppearanceCard } from "./AppearanceCard";
import { AboutCard } from "./AboutCard";
import { UpdateCard } from "./UpdateCard";
import { QuickPanelShortcutSetting } from "./QuickPanelShortcutSetting";
import { StartupSettings } from "./StartupSettings";
import { TraySettings } from "./TraySettings";
import { useT } from "../../i18n";
import { SavedHint, useSaveFlash } from "./save-flash";

const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120];
/** 告警冷却预设（小时，ADR-0025）；0 = 关闭冷却 */
const COOLDOWN_PRESETS = [1, 3, 6, 12, 24];

export function GeneralSettings() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const { visible: savedVisible, flash } = useSaveFlash();
  const t = useT();

  async function save(patch: Partial<AppSettings>) {
    const current = useAppStore.getState().settings;
    await saveSettings({ ...current, ...patch });
    flash();
  }

  const interval = settings.refreshIntervalMinutes;
  const presets = INTERVAL_PRESETS.includes(interval)
    ? INTERVAL_PRESETS
    : [...INTERVAL_PRESETS, interval].sort((a, b) => a - b);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{t("自动刷新")}</CardTitle>
            <CardDescription>
              {settings.refreshEnabled
                ? `${t("当前策略：每")} ${formatRefreshLabel(interval, t)} ${t("自动刷新。")}`
                : t("已关闭，仅手动刷新。")}
            </CardDescription>
          </div>
          <SavedHint visible={savedVisible} />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>{t("自动刷新总开关")}</Label>
              <p className="mt-1 text-[13px] text-fg-muted">{t("关闭后所有供应商与统计页均不再自动刷新。")}</p>
            </div>
            <Switch
              checked={settings.refreshEnabled}
              onCheckedChange={(value) => void save({ refreshEnabled: value })}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="refresh-interval">{t("刷新间隔")}</Label>
              <p className="mt-1 text-[13px] text-fg-muted">{t("所有供应商共用同一间隔。")}</p>
            </div>
            <Select
              id="refresh-interval"
              value={String(interval)}
              disabled={!settings.refreshEnabled}
              onChange={(value) => void save({ refreshIntervalMinutes: Number(value) })}
              options={presets.map((minutes) => ({
                value: String(minutes),
                label: formatRefreshLabel(minutes, t),
              }))}
              aria-label={t("刷新间隔")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div className="space-y-1.5">
            <CardTitle>{t("启动")}</CardTitle>
            <CardDescription>{t("登录时自动运行与启动窗口行为。")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <StartupSettings />
        </CardContent>
      </Card>

      <AppearanceCard />

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div className="space-y-1.5">
            <CardTitle>{t("用量告警")}</CardTitle>
            <CardDescription>
              {settings.alertsEnabled
                ? t("余额/额度越过阈值时发送系统通知，并计入通知中心。")
                : t("已关闭，不会发送任何告警通知。")}
            </CardDescription>
          </div>
          <Switch
            checked={settings.alertsEnabled}
            onCheckedChange={(value) => void save({ alertsEnabled: value })}
          />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="alert-cooldown">
                {t("重复通知冷却")}
                <HintTooltip
                  tip={t(
                    "同一状况告警一次后，在该时段内不再重复通知；跨界面刷新与应用重启持续有效。恢复到阈值以上会自动解除。",
                  )}
                />
              </Label>
              <p className="mt-1 text-[13px] text-fg-muted">{t("各实例的阈值在其配置弹窗中设置。")}</p>
            </div>
            <Select
              id="alert-cooldown"
              value={String(settings.alertCooldownHours)}
              disabled={!settings.alertsEnabled}
              onChange={(value) => void save({ alertCooldownHours: Number(value) })}
              options={[
                ...COOLDOWN_PRESETS.map((hours) => ({
                  value: String(hours),
                  label: `${hours} ${t("小时")}`,
                })),
                { value: "0", label: t("关闭") },
              ]}
              aria-label={t("重复通知冷却")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0 pb-3">
          <div className="space-y-1.5">
            <CardTitle>{t("快速面板")}</CardTitle>
            <CardDescription>{t("全局快捷键与窗口行为。")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <QuickPanelShortcutSetting />
        </CardContent>
      </Card>

      <TraySettings />

      <AboutCard />

      <UpdateCard />
    </div>
  );
}
