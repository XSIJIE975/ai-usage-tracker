import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Check, CheckCircle2, Eye, EyeOff, Monitor, Moon, RefreshCw, Save, Sun, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Badge } from "../components/ui/badge";
import { Separator } from "../components/ui/separator";
import { Segmented } from "../components/ui/segmented";
import type { CredentialStatus, CredentialsInput, VaultCredentials } from "../types/ipc";
import { formatRefreshLabel, normalizeOpenCodeAuthCookie } from "../lib/utils";
import { useThemeMode, setThemeMode, type ThemeMode } from "../lib/theme";

interface SecretFieldProps {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onClear: () => void;
  clearDisabled?: boolean;
}

function SecretField({
  id,
  value,
  placeholder,
  onChange,
  onClear,
  clearDisabled = false,
}: SecretFieldProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        autoComplete="off"
        className="pr-16 font-mono text-[13px]"
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        className="absolute right-8 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        title={visible ? "隐藏" : "显示"}
        aria-label={visible ? "隐藏" : "显示"}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={clearDisabled}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-danger-soft hover:text-danger-soft-fg disabled:pointer-events-none disabled:opacity-40"
        title="清除"
        aria-label="清除"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function statusBadge(configured: boolean) {
  return configured ? (
    <Badge variant="success">
      <Check className="h-3 w-3" /> 已配置
    </Badge>
  ) : (
    <Badge variant="neutral">未配置</Badge>
  );
}

function AppearanceCard() {
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

export function SettingsView() {
  const { settings, vaultStatus, saveSettings, refreshAll } = useAppStore();
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [deepseekKey, setDeepseekKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [authCookie, setAuthCookie] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [refreshEnabled, setRefreshEnabled] = useState(settings.refreshEnabled);
  const [interval, setInterval] = useState(String(settings.refreshIntervalMinutes));
  const [providers, setProviders] = useState({ ...settings.providers });
  const [message, setMessage] = useState("");

  const loadCredentials = useCallback(async () => {
    if (!vaultStatus?.unlocked) return;
    try {
      const stored = await invoke<VaultCredentials>("vault_credentials");
      setDeepseekKey(stored.deepseekApiKey ?? "");
      setWorkspaceId(stored.opencodeGoWorkspaceId ?? "");
      setAuthCookie(stored.opencodeGoAuthCookie ?? "");
      setApiKey(stored.opencodeGoApiKey ?? "");
      setCredentialStatus(await invoke<CredentialStatus>("vault_credential_status"));
    } catch {
      setCredentialStatus(null);
    }
  }, [vaultStatus?.unlocked]);

  useEffect(() => {
    void loadCredentials();
  }, [loadCredentials]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    void (async () => {
      const unlistenCredentials = await listen("credentials-changed", () => {
        if (!disposed) void loadCredentials();
      });
      const unlistenVault = await listen("vault-status-changed", () => {
        if (!disposed) void loadCredentials();
      });
      if (disposed) {
        unlistenCredentials();
        unlistenVault();
        return;
      }
      unlisteners.push(unlistenCredentials, unlistenVault);
    })();

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [loadCredentials]);

  useEffect(() => {
    setRefreshEnabled(settings.refreshEnabled);
    setInterval(String(settings.refreshIntervalMinutes));
    setProviders({ ...settings.providers });
  }, [settings]);

  async function saveCredentials() {
    const input: CredentialsInput = {};
    if (deepseekKey.trim()) input.deepseekApiKey = deepseekKey.trim();
    if (workspaceId.trim()) input.opencodeGoWorkspaceId = workspaceId.trim();
    if (authCookie.trim()) input.opencodeGoAuthCookie = normalizeOpenCodeAuthCookie(authCookie);
    if (apiKey.trim()) input.opencodeGoApiKey = apiKey.trim();
    try {
      await invoke("vault_save_credentials", { credentials: input });
      await refreshAll(false);
      await loadCredentials();
      setMessage("凭据已保存，已刷新用量");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearCredential(field: keyof CredentialsInput) {
    const input: CredentialsInput = { [field]: null };
    try {
      await invoke("vault_save_credentials", { credentials: input });
      setMessage("凭据已清除");
      await refreshAll(false);
      await loadCredentials();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

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

      <Card>
        <CardHeader>
          <CardTitle>Provider 凭据</CardTitle>
          <CardDescription>
            已保存的凭据会回填到输入框；清空请使用输入框右侧的清除按钮。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="deepseekKey">DeepSeek API Key</Label>
              {statusBadge(Boolean(credentialStatus?.deepseekApiKey))}
            </div>
            <SecretField
              id="deepseekKey"
              value={deepseekKey}
              placeholder="sk-..."
              onChange={setDeepseekKey}
              onClear={() => void clearCredential("deepseekApiKey")}
              clearDisabled={!deepseekKey}
            />
          </div>

          <Separator />

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="workspaceId">OpenCode Go Workspace ID</Label>
              {statusBadge(Boolean(credentialStatus?.opencodeGoWorkspaceId))}
            </div>
            <SecretField
              id="workspaceId"
              value={workspaceId}
              placeholder="wrk_..."
              onChange={setWorkspaceId}
              onClear={() => void clearCredential("opencodeGoWorkspaceId")}
              clearDisabled={!workspaceId}
            />
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="authCookie">OpenCode Auth Cookie</Label>
              {statusBadge(Boolean(credentialStatus?.opencodeGoAuthCookie))}
            </div>
            <SecretField
              id="authCookie"
              value={authCookie}
              placeholder="只粘贴 auth Cookie 的 Value"
              onChange={setAuthCookie}
              onClear={() => void clearCredential("opencodeGoAuthCookie")}
              clearDisabled={!authCookie}
            />
            <p className="text-xs leading-relaxed text-fg-muted">
              获取方式：打开 opencode.ai 后台，按 F12 → Application → Cookies → opencode.ai，复制名为 auth 的 Value；不要带 Cookie: 或 auth= 前缀。
            </p>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="apiKey">OpenCode Go API Key（可选）</Label>
              {statusBadge(Boolean(credentialStatus?.opencodeGoApiKey))}
            </div>
            <SecretField
              id="apiKey"
              value={apiKey}
              placeholder="官方 /usage 接口上线后使用"
              onChange={setApiKey}
              onClear={() => void clearCredential("opencodeGoApiKey")}
              clearDisabled={!apiKey}
            />
          </div>

          <Button onClick={() => void saveCredentials()}>
            <Save className="h-4 w-4" /> 保存凭据
          </Button>
        </CardContent>
      </Card>

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
