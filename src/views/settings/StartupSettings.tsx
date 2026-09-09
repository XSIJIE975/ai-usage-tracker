import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
import { Switch } from "../../components/ui/switch";
import { useAppStore } from "../../store/useAppStore";
import { SavedHint, useSaveFlash } from "./save-flash";
import { useT } from "../../i18n";

/**
 * 启动行为：开机自启与静默启动。静默启动仅作用于自启路径（ADR-0015），
 * 关闭自启时静默启动一并复位为关；系统注册成功后才持久化设置，失败红字提示并回退 UI。
 * 开发实例不注册开机自启（ADR-0018）：开关置灰并提示，Rust 侧 apply() 亦已短路兜底。
 */
export function StartupSettings() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const { visible: savedVisible, flash } = useSaveFlash();
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const isDev = import.meta.env.DEV;

  /** 先注册系统自启项再落库：注册失败时不改 UI 状态 */
  async function applyAutostart(enabled: boolean, silent: boolean) {
    const current = useAppStore.getState().settings;
    try {
      // 未启用 Tauri 运行时（纯浏览器 dev）时跳过真实注册
      const { isTauri } = await import("@tauri-apps/api/core");
      if (isTauri()) {
        await invoke("set_autostart", { enabled, silent });
      }
      await saveSettings({ ...current, autoStart: enabled, silentStart: silent });
      setError(null);
      flash();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Label>{t("开机自启")}</Label>
            <SavedHint visible={savedVisible} />
          </div>
          <p className="mt-1 text-[13px] text-fg-muted">{t("登录系统后自动运行程序，驻留系统托盘。")}</p>
          {isDev && <p className="mt-1 text-xs text-fg-muted">{t("开发实例不注册开机自启，安装版的自启设置不受影响。")}</p>}
        </div>
        <Switch
          checked={settings.autoStart}
          disabled={isDev}
          onCheckedChange={(value) => void applyAutostart(value, value && settings.silentStart)}
        />
      </div>

      {settings.autoStart && (
        <>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>{t("静默启动")}</Label>
              <p className="mt-1 text-[13px] text-fg-muted">{t("开机自启启动时不显示主窗口，仅在系统托盘运行。")}</p>
            </div>
            <Switch
              checked={settings.silentStart}
              disabled={isDev}
              onCheckedChange={(value) => void applyAutostart(true, value)}
            />
          </div>
        </>
      )}

      {error && <p className="text-xs leading-relaxed text-danger">{error}</p>}
    </div>
  );
}
