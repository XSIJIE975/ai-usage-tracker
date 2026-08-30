import { useAppStore } from "../../store/useAppStore";
import { Label } from "../../components/ui/label";
import { SavedHint, useSaveFlash } from "./save-flash";
import { useT } from "../../i18n";

interface ThresholdConfig {
  label: string;
  hint: string;
  min: number;
  max: number;
}

const CONFIGS: Record<"deepseek" | "opencode-go", ThresholdConfig> = {
  deepseek: {
    label: "余额告警阈值（元）",
    hint: "余额低于该值时发送系统通知。",
    min: 0,
    max: 1_000_000,
  },
  "opencode-go": {
    label: "本月额度告警阈值（%）",
    hint: "本月额度已用达到该百分比时发送系统通知。",
    min: 1,
    max: 100,
  },
};

/** 供应商告警阈值输入：失焦保存并夹取到合理范围；受告警总开关门控 */
export function AlertThresholdSetting({ providerId }: { providerId: "deepseek" | "opencode-go" }) {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const { visible, flash } = useSaveFlash();
  const t = useT();
  const config = CONFIGS[providerId];

  const value =
    providerId === "deepseek"
      ? settings.alertThresholds.deepseekBalanceBelowCny
      : settings.alertThresholds.opencodeMonthlyUsedPercent;

  async function save(raw: string) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(config.max, Math.max(config.min, Math.round(parsed)));
    const current = useAppStore.getState().settings;
    const alertThresholds = { ...current.alertThresholds };
    if (providerId === "deepseek") {
      alertThresholds.deepseekBalanceBelowCny = clamped;
    } else {
      alertThresholds.opencodeMonthlyUsedPercent = clamped;
    }
    await saveSettings({ ...current, alertThresholds });
    flash();
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <Label htmlFor={`alert-threshold-${providerId}`}>{t(config.label)}</Label>
          <SavedHint visible={visible} />
        </div>
        <p className="mt-1 text-[13px] text-fg-muted">{t(config.hint)}</p>
      </div>
      <input
        id={`alert-threshold-${providerId}`}
        type="number"
        // key 绑定当前值：store 外部变更时重挂载同步显示
        key={`${providerId}-${value}`}
        defaultValue={value}
        min={config.min}
        max={config.max}
        step={1}
        disabled={!settings.alertsEnabled}
        onBlur={(event) => void save(event.currentTarget.value)}
        className="tnum h-9 w-28 rounded-md border border-line bg-surface px-2 text-right text-[13px] text-fg shadow-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
      />
    </div>
  );
}
