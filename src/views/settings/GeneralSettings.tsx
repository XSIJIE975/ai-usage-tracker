import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
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
import { SavedHint, useSaveFlash } from "./save-flash";

const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120];

export function GeneralSettings() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const { visible: savedVisible, flash } = useSaveFlash();

  async function save(patch: Partial<AppSettings>) {
    const current = useAppStore.getState().settings;
    await saveSettings({ ...current, providers: { ...current.providers }, ...patch });
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
            <CardTitle>自动刷新</CardTitle>
            <CardDescription>
              {settings.refreshEnabled
                ? `当前策略：每 ${formatRefreshLabel(interval)} 自动刷新。`
                : "已关闭，仅手动刷新。"}
            </CardDescription>
          </div>
          <SavedHint visible={savedVisible} />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>自动刷新总开关</Label>
              <p className="mt-1 text-[13px] text-fg-muted">关闭后所有供应商与统计页均不再自动刷新。</p>
            </div>
            <Switch
              checked={settings.refreshEnabled}
              onCheckedChange={(value) => void save({ refreshEnabled: value })}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-4">
            <div>
              <Label htmlFor="refresh-interval">刷新间隔</Label>
              <p className="mt-1 text-[13px] text-fg-muted">所有供应商共用同一间隔。</p>
            </div>
            <Select
              id="refresh-interval"
              value={String(interval)}
              disabled={!settings.refreshEnabled}
              onChange={(value) => void save({ refreshIntervalMinutes: Number(value) })}
              options={presets.map((minutes) => ({
                value: String(minutes),
                label: formatRefreshLabel(minutes),
              }))}
              aria-label="刷新间隔"
            />
          </div>
        </CardContent>
      </Card>

      <AppearanceCard />

      <AboutCard />

      <UpdateCard />
    </div>
  );
}
