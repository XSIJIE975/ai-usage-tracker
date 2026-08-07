import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Check, Eye, EyeOff, RefreshCw, Save, X } from "lucide-react";
import { useAppStore } from "../store/useAppStore";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import type { CredentialStatus, CredentialsInput, VaultCredentials } from "../types/ipc";
import { formatRefreshLabel, normalizeOpenCodeAuthCookie } from "../lib/utils";

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
        className="pr-16 font-mono"
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        className="absolute right-8 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title={visible ? "隐藏" : "显示"}
        aria-label={visible ? "隐藏" : "显示"}
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={clearDisabled}
        className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-40"
        title="清除"
        aria-label="清除"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
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

  function statusBadge(configured: boolean) {
    return configured ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
        <Check className="h-3 w-3" /> 已配置
      </span>
    ) : (
      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">未配置</span>
    );
  }

  return (
    <div className="space-y-6">
      {message && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Provider 凭据</CardTitle>
          <CardDescription>
            已保存的凭据会回填到输入框；清空请使用输入框右侧的清除按钮。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
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

          <div className="h-px bg-slate-100" />

          <div className="space-y-3">
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

          <div className="space-y-3">
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
            <p className="text-xs text-slate-400">
              获取方式：打开 opencode.ai 后台，按 F12 → Application → Cookies → opencode.ai，复制名为 auth 的 Value；不要带 Cookie: 或 auth= 前缀。
            </p>
          </div>

          <div className="space-y-3">
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
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <Label>自动刷新</Label>
              <p className="mt-1 text-sm text-slate-500">关闭后仅手动刷新。</p>
            </div>
            <Switch checked={refreshEnabled} onCheckedChange={setRefreshEnabled} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
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
              <p className="text-xs text-slate-400">最大 120 分钟，超过 60 分钟自动按小时显示。</p>
            </div>
            <div className="space-y-3">
              {Object.entries(providers).map(([id, enabled]) => (
                <div key={id} className="flex items-center justify-between">
                  <span className="text-sm text-slate-700">{id === "opencode-go" ? "OpenCode Go" : "DeepSeek"}</span>
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
    </div>
  );
}
