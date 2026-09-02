// 过渡适配：读写「该种类的第一个实例」的阈值；阶段 ③ 配置弹窗上线后本组件被实例版取代
import { useAppStore } from "../../store/useAppStore";
import { Label } from "../../components/ui/label";
import { SavedHint, useSaveFlash } from "./save-flash";
import { useT } from "../../i18n";
import type { ProviderKind } from "../../types/ipc";

interface ThresholdConfig {
  label: string;
  hint: string;
  min: number;
  max: number;
}

const CONFIGS: Record<ProviderKind, ThresholdConfig> = {
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
  glm: {
    label: "Coding Plan 配额告警阈值（%）",
    hint: "Coding Plan 配额已用达到该百分比时发送系统通知。",
    min: 1,
    max: 100,
  },
};

/** 供应商告警阈值输入：失焦保存并夹取到合理范围；受告警总开关门控 */
export function AlertThresholdSetting({
  providerId,
}: {
  providerId: ProviderKind;
}) {
  const instance = useAppStore((state) =>
    state.instances.find((item) => item.providerId === providerId),
  );
  const alertsEnabled = useAppStore((state) => state.settings.alertsEnabled);
  const updateInstance = useAppStore((state) => state.updateInstance);
  const { visible, flash } = useSaveFlash();
  const t = useT();
  const config = CONFIGS[providerId];

  if (!instance) return null;
  const value = instance.threshold;

  const save = async (raw: string) => {
    // 留空 = 清除阈值（不告警）
    if (raw.trim() === "") {
      await updateInstance(instance.id, { threshold: null });
      flash();
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(config.max, Math.max(config.min, Math.round(parsed)));
    await updateInstance(instance.id, { threshold: clamped });
    flash();
  };

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
        key={`${providerId}-${value ?? "off"}`}
        defaultValue={value ?? ""}
        placeholder={t("不告警")}
        min={config.min}
        max={config.max}
        step={1}
        disabled={!alertsEnabled}
        onBlur={(event) => void save(event.currentTarget.value)}        className="tnum h-9 w-28 rounded-md border border-line bg-surface px-2 text-right text-[13px] text-fg shadow-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-40"
      />
    </div>
  );
}
