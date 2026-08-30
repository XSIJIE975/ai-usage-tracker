import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SquarePen } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { Switch } from "../../components/ui/switch";
import { useAppStore } from "../../store/useAppStore";
import { canonicalFromEvent, displayShortcut } from "../../lib/shortcut";
import { SavedHint, useSaveFlash } from "./save-flash";

/**
 * 快速面板全局快捷键：录制式捕获（按下组合键即录入），保存时真实注册，
 * 注册失败（组合被其他程序占用）会红字提示并回退。
 */
export function QuickPanelShortcutSetting() {
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);
  const { visible, flash } = useSaveFlash();
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function applyShortcut(canonical: string): Promise<boolean> {
    const previous = useAppStore.getState().settings.quickPanelShortcut;
    try {
      // 未启用 Tauri 运行时（纯浏览器 dev）时跳过真实注册
      if (canonical) {
        const { isTauri } = await import("@tauri-apps/api/core");
        if (isTauri()) {
          await invoke("register_quick_shortcut", { shortcut: canonical });
        }
      }
      const current = useAppStore.getState().settings;
      await saveSettings({ ...current, quickPanelShortcut: canonical });
      setError(null);
      flash();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      // 注册失败时回退：重新注册旧组合
      if (previous) {
        try {
          const { isTauri } = await import("@tauri-apps/api/core");
          if (isTauri()) await invoke("register_quick_shortcut", { shortcut: previous });
        } catch {
          // 回退失败也仅保留提示
        }
      }
      return false;
    }
  }

  // 录制模式：捕获窗口 keydown 组合键
  useEffect(() => {
    if (!recording) return;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(false);
        return;
      }
      const canonical = canonicalFromEvent(event);
      if (!canonical) return;
      setRecording(false);
      void applyShortcut(canonical);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Label>快速面板快捷键</Label>
            <SavedHint visible={visible} />
          </div>
          <p className="mt-1 text-[13px] text-fg-muted">
            全局呼出/收起快速面板。录制时按下组合键即可，Esc 取消。
          </p>
        </div>
        {recording ? (
          <span className="flex h-9 items-center rounded-md border border-brand bg-brand-soft px-3 text-[13px] text-brand">
            按下组合键…（Esc 取消）
          </span>
        ) : (
          <Button variant="outline" onClick={() => setRecording(true)}>
            <SquarePen className="h-3.5 w-3.5" />
            {displayShortcut(settings.quickPanelShortcut)}
          </Button>
        )}
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label>失焦自动隐藏</Label>
          <p className="mt-1 text-[13px] text-fg-muted">点击面板外部时自动收起快速面板。</p>
        </div>
        <Switch
          checked={settings.quickAutoHide}
          onCheckedChange={(value) => {
            const current = useAppStore.getState().settings;
            void saveSettings({ ...current, quickAutoHide: value });
          }}
        />
      </div>
      {error && <p className="text-xs leading-relaxed text-danger">{error}</p>}
    </div>
  );
}
