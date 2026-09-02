// 过渡适配：读写「该种类的第一个实例」的自动刷新开关；阶段 ③ 配置弹窗上线后本组件被实例版取代
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { useAppStore } from "../../store/useAppStore";
import { formatRefreshLabel } from "../../lib/utils";
import { SavedHint, useSaveFlash } from "./save-flash";
import { useT } from "../../i18n";
import type { ProviderKind } from "../../types/ipc";

interface ProviderAutoRefreshProps {
  providerId: ProviderKind;
  onOpenGeneral: () => void;
}

/**
 * 供应商自动刷新区块：受「自动刷新总开关」门控。
 * 总开关关闭时开关禁用置灰（保留原值），并给出可跳转「通用」页签的提示。
 */
export function ProviderAutoRefresh({ providerId, onOpenGeneral }: ProviderAutoRefreshProps) {
  const instance = useAppStore((state) =>
    state.instances.find((item) => item.providerId === providerId),
  );
  const settings = useAppStore((state) => state.settings);
  const updateInstance = useAppStore((state) => state.updateInstance);
  const { visible, flash } = useSaveFlash();
  const t = useT();
  const masterOn = settings.refreshEnabled;
  if (!instance) return null;
  const enabled = instance.autoRefresh;

  const toggle = async (value: boolean) => {
    await updateInstance(instance.id, { autoRefresh: value });
    flash();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Label>{t("供应商自动刷新")}</Label>
            <SavedHint visible={visible} />
          </div>
          <p className="mt-1 text-[13px] text-fg-muted">
            {t("跟随全局刷新间隔（当前")} {formatRefreshLabel(settings.refreshIntervalMinutes, t)}{t("），手动刷新不受此开关影响。")}
          </p>
        </div>
        <Switch checked={enabled} disabled={!masterOn} onCheckedChange={(value) => void toggle(value)} />
      </div>
      {!masterOn && (
        <p className="text-xs text-fg-muted">
          {t("需先在")}{" "}
          <button
            type="button"
            onClick={onOpenGeneral}
            className="rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {t("「通用」页签")}
          </button>{" "}
          {t("开启自动刷新总开关。")}
        </p>
      )}
    </div>
  );
}
