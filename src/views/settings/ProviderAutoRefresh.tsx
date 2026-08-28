import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { useAppStore } from "../../store/useAppStore";
import { formatRefreshLabel } from "../../lib/utils";
import { SavedHint, useSaveFlash } from "./save-flash";

interface ProviderAutoRefreshProps {
  providerId: string;
  onOpenGeneral: () => void;
}

/**
 * 供应商自动刷新区块：受「自动刷新总开关」门控。
 * 总开关关闭时开关禁用置灰（保留原值），并给出可跳转「通用」页签的提示。
 */
export function ProviderAutoRefresh({ providerId, onOpenGeneral }: ProviderAutoRefreshProps) {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const { visible, flash } = useSaveFlash();
  const masterOn = settings.refreshEnabled;
  const enabled = Boolean(settings.providers[providerId]);

  async function toggle(value: boolean) {
    const current = useAppStore.getState().settings;
    await saveSettings({ ...current, providers: { ...current.providers, [providerId]: value } });
    flash();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Label>供应商自动刷新</Label>
            <SavedHint visible={visible} />
          </div>
          <p className="mt-1 text-[13px] text-fg-muted">
            跟随全局刷新间隔（当前 {formatRefreshLabel(settings.refreshIntervalMinutes)}），手动刷新不受此开关影响。
          </p>
        </div>
        <Switch checked={enabled} disabled={!masterOn} onCheckedChange={(value) => void toggle(value)} />
      </div>
      {!masterOn && (
        <p className="text-xs text-fg-muted">
          需先在{" "}
          <button
            type="button"
            onClick={onOpenGeneral}
            className="rounded-sm font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            「通用」页签
          </button>{" "}
          开启自动刷新总开关。
        </p>
      )}
    </div>
  );
}
