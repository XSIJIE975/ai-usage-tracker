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
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../i18n";
import { normalizeOpenCodeAuthCookie } from "../../lib/utils";

type OpenCodeSlot = "workspaceId" | "cookie" | "apiKey";

export function OpenCodeGoSettings({
  instance,
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
  const t = useT();

  useEffect(() => {
    setWorkspaceId(credentials?.workspaceId ?? "");
    setAuthCookie(credentials?.cookie ?? "");
    setApiKey(credentials?.apiKey ?? "");
  }, [credentials]);

  async function saveCredentials() {
    const input: Record<string, string> = {};
    if (workspaceId.trim()) input.workspaceId = workspaceId.trim();
    if (authCookie.trim()) input.cookie = normalizeOpenCodeAuthCookie(authCookie);
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    setSaving(true);
    try {
      if (instance) {
        await invoke("vault_save_credentials", { instanceId: instance.id, credentials: input });
      } else {
        await useAppStore.getState().addInstance("opencode-go", "", input);
      }
      await onChanged();
      await onReload();
      setMessage({ kind: "success", text: t("凭据已保存，已刷新用量") });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function clearCredential(slot: OpenCodeSlot) {
    if (!instance) return;
    setSaving(true);
    try {
      await invoke("vault_save_credentials", {
        instanceId: instance.id,
        credentials: { [slot]: null },
      });
      await onChanged();
      await onReload();
      setMessage({ kind: "success", text: t("凭据已清除") });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("OpenCode Go 凭据")}</CardTitle>
        <CardDescription>{t("Workspace ID 与 Auth Cookie 为必填，API Key 可选。")}</CardDescription>
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
            <Label htmlFor="workspaceId">{t("OpenCode Go Workspace ID")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.workspaceId)} />
          </div>
          <SecretField
            id="workspaceId"
            value={workspaceId}
            placeholder="wrk_..."
            disabled={saveDisabled}
            onChange={setWorkspaceId}
            onClear={() => void clearCredential("workspaceId")}
            clearDisabled={!workspaceId || !instance}
          />
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="authCookie">{t("OpenCode Auth Cookie")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.cookie)} />
          </div>
          <SecretField
            id="authCookie"
            value={authCookie}
            placeholder={t("只粘贴 auth Cookie 的 Value")}
            disabled={saveDisabled}
            onChange={setAuthCookie}
            onClear={() => void clearCredential("cookie")}
            clearDisabled={!authCookie || !instance}
          />
          <p className="text-xs leading-relaxed text-fg-muted">
            {t(
              "获取方式：打开 opencode.ai 后台，按 F12 → Application → Cookies → opencode.ai，复制名为 auth 的 Value；不要带 Cookie: 或 auth= 前缀。",
            )}
          </p>
          <DiagnosisButton
            test={() => testOpenCodeConnection(workspaceId, authCookie)}
            disabled={saveDisabled || saving || !workspaceId.trim() || !authCookie.trim()}
          />
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="apiKey">{t("OpenCode Go API Key（可选）")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.apiKey)} />
          </div>
          <SecretField
            id="apiKey"
            value={apiKey}
            placeholder={t("官方 /usage 接口上线后使用")}
            disabled={saveDisabled}
            onChange={setApiKey}
            onClear={() => void clearCredential("apiKey")}
            clearDisabled={!apiKey || !instance}
          />
          <DiagnosisButton
            test={() => testOpenCodeApiKey(apiKey)}
            disabled={saveDisabled || saving || !apiKey.trim()}
          />
        </div>

        <Button disabled={saveDisabled || saving} onClick={() => void saveCredentials()}>
          {saving ? (
            <>
              <LoaderCircle className="h-4 w-4 animate-spin" /> {t("保存中…")}
            </>
          ) : (
            <>
              <Save className="h-4 w-4" /> {t("保存凭据")}
            </>
          )}
        </Button>

        {instance ? (
          <>
            <Separator />

            <ProviderAutoRefresh providerId="opencode-go" onOpenGeneral={onOpenGeneral} />

            <Separator />

            <AlertThresholdSetting providerId="opencode-go" />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
