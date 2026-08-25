import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CheckCircle2, Save } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
import { SecretField, StatusBadge } from "./CredentialInput";
import type { CredentialStatus, CredentialsInput, VaultCredentials } from "../../types/ipc";
import { normalizeOpenCodeAuthCookie } from "../../lib/utils";

interface CredentialsCardProps {
  unlocked: boolean;
  onChanged: () => Promise<void>;
}

export function CredentialsCard({ unlocked, onChanged }: CredentialsCardProps) {
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null);
  const [deepseekKey, setDeepseekKey] = useState("");
  const [deepseekUserToken, setDeepseekUserToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [authCookie, setAuthCookie] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");

  const loadCredentials = useCallback(async () => {
    if (!unlocked) return;
    try {
      const stored = await invoke<VaultCredentials>("vault_credentials");
      setDeepseekKey(stored.deepseekApiKey ?? "");
      setDeepseekUserToken(stored.deepseekUserToken ?? "");
      setWorkspaceId(stored.opencodeGoWorkspaceId ?? "");
      setAuthCookie(stored.opencodeGoAuthCookie ?? "");
      setApiKey(stored.opencodeGoApiKey ?? "");
      setCredentialStatus(await invoke<CredentialStatus>("vault_credential_status"));
    } catch {
      setCredentialStatus(null);
    }
  }, [unlocked]);

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

  async function saveCredentials() {
    const input: CredentialsInput = {};
    if (deepseekKey.trim()) input.deepseekApiKey = deepseekKey.trim();
    if (deepseekUserToken.trim()) input.deepseekUserToken = deepseekUserToken.trim();
    if (workspaceId.trim()) input.opencodeGoWorkspaceId = workspaceId.trim();
    if (authCookie.trim()) input.opencodeGoAuthCookie = normalizeOpenCodeAuthCookie(authCookie);
    if (apiKey.trim()) input.opencodeGoApiKey = apiKey.trim();
    try {
      await invoke("vault_save_credentials", { credentials: input });
      await onChanged();
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
      await onChanged();
      await loadCredentials();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
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
              <StatusBadge configured={Boolean(credentialStatus?.deepseekApiKey)} />
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
              <Label htmlFor="deepseekUserToken">DeepSeek UserToken</Label>
              <StatusBadge configured={Boolean(credentialStatus?.deepseekUserToken)} />
            </div>
            <SecretField
              id="deepseekUserToken"
              value={deepseekUserToken}
              placeholder="platform.deepseek.com 登录令牌"
              onChange={setDeepseekUserToken}
              onClear={() => void clearCredential("deepseekUserToken")}
              clearDisabled={!deepseekUserToken}
            />
            <p className="text-xs leading-relaxed text-fg-muted">
              获取方式：打开 platform.deepseek.com 并登录 → F12 打开开发者工具 → Application(应用)
              → Local Storage → https://platform.deepseek.com → 找到键 userToken，其值为 JSON
              对象，复制其中 token 字段的字符串值。
            </p>
            <p className="text-xs leading-relaxed text-fg-muted">
              注意：UserToken 与 API Key 是两种不同凭据，互不通用。
            </p>
          </div>

          <Separator />

          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="workspaceId">OpenCode Go Workspace ID</Label>
              <StatusBadge configured={Boolean(credentialStatus?.opencodeGoWorkspaceId)} />
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
              <StatusBadge configured={Boolean(credentialStatus?.opencodeGoAuthCookie)} />
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
              <StatusBadge configured={Boolean(credentialStatus?.opencodeGoApiKey)} />
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
    </>
  );
}
