import { Monitor, Moon, Sun } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Segmented } from "../../components/ui/segmented";
import { useThemeMode, setThemeMode, type ThemeMode } from "../../lib/theme";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../i18n";

/** 外观与语言：主题与本机设置双写（localStorage 只作首帧缓存），语言存本机设置 */
export function AppearanceCard() {
  const mode = useThemeMode();
  const t = useT();
  const settings = useAppStore((state) => state.settings);
  const saveSettings = useAppStore((state) => state.saveSettings);

  function changeThemeMode(value: ThemeMode) {
    // 先即时生效（data-theme + 跨窗口广播 + localStorage），再落库持久
    setThemeMode(value);
    const current = useAppStore.getState().settings;
    void saveSettings({ ...current, themeMode: value });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("外观")}</CardTitle>
        <CardDescription>{t("主题偏好保存在本机设置中。")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label>{t("主题模式")}</Label>
          <Segmented<ThemeMode>
            value={mode}
            onChange={changeThemeMode}
            options={[
              { value: "system", label: t("跟随系统"), icon: <Monitor className="h-3.5 w-3.5" /> },
              { value: "light", label: t("浅色"), icon: <Sun className="h-3.5 w-3.5" /> },
              { value: "dark", label: t("深色"), icon: <Moon className="h-3.5 w-3.5" /> },
            ]}
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label>{t("界面语言")}</Label>
            <p className="mt-1 text-[13px] text-fg-muted">{t("语言偏好保存在本机设置中。")}</p>
          </div>
          <Segmented<"auto" | "zh" | "en">
            value={settings.interfaceLanguage}
            onChange={(value) => {
              const current = useAppStore.getState().settings;
              void saveSettings({ ...current, interfaceLanguage: value });
            }}
            options={[
              { value: "auto", label: t("自动（默认）") },
              { value: "zh", label: t("中文") },
              { value: "en", label: t("English") },
            ]}
          />
        </div>
      </CardContent>
    </Card>
  );
}
