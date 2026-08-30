import { Monitor, Moon, Sun } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Segmented } from "../../components/ui/segmented";
import { useThemeMode, setThemeMode, type ThemeMode } from "../../lib/theme";

export function AppearanceCard() {
  const mode = useThemeMode();
  return (
    <Card>
      <CardHeader>
        <CardTitle>外观</CardTitle>
        <CardDescription>主题偏好仅保存在本机浏览器存储中。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <Label>主题模式</Label>
          <Segmented<ThemeMode>
            value={mode}
            onChange={setThemeMode}
            options={[
              { value: "system", label: "跟随系统", icon: <Monitor className="h-3.5 w-3.5" /> },
              { value: "light", label: "浅色", icon: <Sun className="h-3.5 w-3.5" /> },
              { value: "dark", label: "深色", icon: <Moon className="h-3.5 w-3.5" /> },
            ]}
          />
        </div>
      </CardContent>
    </Card>
  );
}
