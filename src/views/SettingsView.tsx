import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Separator } from "../components/ui/separator";
import { CredentialsCard } from "./settings/CredentialsCard";
import { MigrationCard } from "./settings/MigrationCard";
import { AppearanceCard } from "./settings/AppearanceCard";
import { formatRefreshLabel } from "../lib/utils";

export function SettingsView() {
  const { settings, vaultStatus, saveSettings, refreshAll } = useAppStore();
  const [refreshEnabled, setRefreshEnabled] = useState(settings.refreshEnabled);
  const [interval, setInterval] = useState(String(settings.refreshIntervalMinutes));
  const [providers, setProviders] = useState({ ...settings.providers });
  const [message, setMessage] = useState("");

  useEffect(() => {
    setRefreshEnabled(settings.refreshEnabled);
    setInterval(String(settings.refreshIntervalMinutes));
    setProviders({ ...settings.providers });
  }, [settings]);

  async function saveRefreshSettings() {
    const parsed = Math.max(0, Math.min(120, Number(interval) || 0));
    setInterval(String(parsed));
    await saveSettings({ refreshEnabled, refreshIntervalMinutes: parsed, providers });
    setMessage("刷新设置已保存");
  }

  return (
    <div className="space-y-4">
      {message && (
        <p className="flex items-center gap-2 rounded-md border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success-soft-fg">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {message}
        </p>
      )}

      {vaultStatus?.needsMigration && <MigrationCard />}

      {vaultStatus?.keychainLost && (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-soft-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          本机设备密钥已丢失（常见于换机、重装系统或重置账户密码），原凭据无法恢复。请在下方重新录入凭据，保存时将重建凭据库。
        </p>
      )}

      <CredentialsCard
        unlocked={Boolean(vaultStatus?.unlocked)}
        notice={
          vaultStatus && !vaultStatus.unlocked && !vaultStatus.keychainLost
            ? "凭据库待迁移，请先完成上方的一次性迁移，再查看或保存凭据。"
            : undefined
        }
        onChanged={() => refreshAll(false)}
      />

      <Card>
        <CardHeader>
          <CardTitle>刷新与 Provider</CardTitle>
          <CardDescription>当前策略：{formatRefreshLabel(refreshEnabled ? Number(interval) || 0 : 0)}。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>自动刷新</Label>
              <p className="mt-1 text-[13px] text-fg-muted">关闭后仅手动刷新。</p>
            </div>
            <Switch checked={refreshEnabled} onCheckedChange={setRefreshEnabled} />
          </div>

          <Separator />

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="interval">刷新间隔（分钟）</Label>
              <Input
                id="interval"
                type="number"
                min={1}
                max={120}
                value={interval}
                disabled={!refreshEnabled}
                onChange={(event) => setInterval(event.currentTarget.value)}
              />
              <p className="text-xs text-fg-muted">最大 120 分钟，超过 60 分钟自动按小时显示。</p>
            </div>
            <div className="space-y-3">
              {Object.entries(providers).map(([id, enabled]) => (
                <div key={id} className="flex items-center justify-between">
                  <span className="text-[13px] text-fg">{id === "opencode-go" ? "OpenCode Go" : "DeepSeek"}</span>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(value) => setProviders((prev) => ({ ...prev, [id]: value }))}
                  />
                </div>
              ))}
            </div>
          </div>

          <Button variant="secondary" onClick={() => void saveRefreshSettings()}>
            <RefreshCw className="h-4 w-4" /> 保存刷新设置
          </Button>
        </CardContent>
      </Card>

      <AppearanceCard />
    </div>
  );
}
