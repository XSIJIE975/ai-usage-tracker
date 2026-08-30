import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, LoaderCircle, Save } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Label } from "../../components/ui/label";
import { Separator } from "../../components/ui/separator";
import { SecretField, StatusBadge } from "./CredentialInput";
import { ProviderAutoRefresh } from "./ProviderAutoRefresh";
import { AlertThresholdSetting } from "./AlertThresholdSetting";
import { DiagnosisButton } from "./DiagnosisButton";
import { testOpenCodeApiKey, testOpenCodeConnection } from "../../diagnostics";
import { SaveMessageBanner, type ProviderSettingsProps, type SaveMessage } from "./provider-settings";
import { normalizeOpenCodeAuthCookie } from "../../lib/utils";
import type { CredentialsInput } from "../../types/ipc";

export function OpenCodeGoSettings({
  saveDisabled,
  notice,
  credentials,
  credentialStatus,
  onChanged,
  onReload,
  onOpenGeneral,
}: ProviderSettingsProps) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [authCookie, setAuthCookie] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<SaveMessage>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setWorkspaceId(credentials?.opencodeGoWorkspaceId ?? "");
    setAuthCookie(credentials?.opencodeGoAuthCookie ?? "");
    setApiKey(credentials?.opencodeGoApiKey ?? "");
  }, [credentials]);

  async function saveCredentials() {
    const input: CredentialsInput = {};
    if (workspaceId.trim()) input.opencodeGoWorkspaceId = workspaceId.trim();
    if (authCookie.trim()) input.opencodeGoAuthCookie = normalizeOpenCodeAuthCookie(authCookie);
    if (apiKey.trim()) input.opencodeGoApiKey = apiKey.trim();
    setSaving(true);
    try {
      await invoke("vault_save_credentials", { credentials: input });
      await onChanged();
      await onReload();
      setMessage({ kind: "success", text: "凭据已保存，已刷新用量" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function clearCredential(field: keyof CredentialsInput) {
    setSaving(true);
    try {
      await invoke("vault_save_credentials", { credentials: { [field]: null } });
      await onChanged();
      await onReload();
      setMessage({ kind: "success", text: "凭据已清除" });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>OpenCode Go 凭据</CardTitle>
        <CardDescription>Workspace ID 与 Auth Cookie 为必填，API Key 可选。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {notice && (
          <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-soft-fg">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {notice}
          </p>
        )}
        <SaveMessageBanner message={message} />

        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="workspaceId">OpenCode Go Workspace ID</Label>
            <StatusBadge configured={Boolean(credentialStatus?.opencodeGoWorkspaceId)} />
          </div>
          <SecretField
            id="workspaceId"
            value={workspaceId}
            placeholder="wrk_..."
            disabled={saveDisabled}
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
            disabled={saveDisabled}
            onChange={setAuthCookie}
            onClear={() => void clearCredential("opencodeGoAuthCookie")}
            clearDisabled={!authCookie}
          />
          <p className="text-xs leading-relaxed text-fg-muted">
            获取方式：打开 opencode.ai 后台，按 F12 → Application → Cookies → opencode.ai，复制名为 auth 的 Value；不要带 Cookie: 或 auth= 前缀。
          </p>
          <DiagnosisButton
            test={() => testOpenCodeConnection(workspaceId, authCookie)}
            disabled={saveDisabled || saving || !workspaceId.trim() || !authCookie.trim()}
          />
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
            disabled={saveDisabled}
            onChange={setApiKey}
            onClear={() => void clearCredential("opencodeGoApiKey")}
            clearDisabled={!apiKey}
          />
          <DiagnosisButton
            test={() => testOpenCodeApiKey(apiKey)}
            disabled={saveDisabled || saving || !apiKey.trim()}
          />
        </div>

        <Button disabled={saveDisabled || saving} onClick={() => void saveCredentials()}>
          {saving ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" /> 保存中…
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> 保存凭据
            </>
          )}
        </Button>

        <Separator />

        <ProviderAutoRefresh providerId="opencode-go" onOpenGeneral={onOpenGeneral} />

        <Separator />

        <AlertThresholdSetting providerId="opencode-go" />
      </CardContent>
    </Card>
  );
}
