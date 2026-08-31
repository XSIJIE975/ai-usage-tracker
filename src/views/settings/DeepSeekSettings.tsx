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
import { testDeepSeekApiKey, testDeepSeekUserToken } from "../../diagnostics";
import { SaveMessageBanner, type ProviderSettingsProps, type SaveMessage } from "./provider-settings";
import { useT } from "../../i18n";
import type { CredentialsInput } from "../../types/ipc";

export function DeepSeekSettings({
  saveDisabled,
  notice,
  credentials,
  credentialStatus,
  onChanged,
  onReload,
  onOpenGeneral,
}: ProviderSettingsProps) {
  const [apiKey, setApiKey] = useState("");
  const [userToken, setUserToken] = useState("");
  const [message, setMessage] = useState<SaveMessage>(null);
  const [saving, setSaving] = useState(false);
  const t = useT();

  useEffect(() => {
    setApiKey(credentials?.deepseekApiKey ?? "");
    setUserToken(credentials?.deepseekUserToken ?? "");
  }, [credentials]);

  async function saveCredentials() {
    const input: CredentialsInput = {};
    if (apiKey.trim()) input.deepseekApiKey = apiKey.trim();
    if (userToken.trim()) input.deepseekUserToken = userToken.trim();
    setSaving(true);
    try {
      await invoke("vault_save_credentials", { credentials: input });
      await onChanged();
      await onReload();
      setMessage({ kind: "success", text: t("凭据已保存，已刷新用量") });
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
        <CardTitle>{t("DeepSeek 凭据")}</CardTitle>
        <CardDescription>{t("API Key 用于余额查询，UserToken 用于用量统计；两者互不通用。")}</CardDescription>
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
            <Label htmlFor="deepseekKey">{t("DeepSeek API Key")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.deepseekApiKey)} />
          </div>
          <SecretField
            id="deepseekKey"
            value={apiKey}
            placeholder="sk-..."
            disabled={saveDisabled}
            onChange={setApiKey}
            onClear={() => void clearCredential("deepseekApiKey")}
            clearDisabled={!apiKey}
          />
          <DiagnosisButton
            test={() => testDeepSeekApiKey(apiKey)}
            disabled={saveDisabled || saving || !apiKey.trim()}
          />
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="deepseekUserToken">{t("DeepSeek UserToken")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.deepseekUserToken)} />
          </div>
          <SecretField
            id="deepseekUserToken"
            value={userToken}
            placeholder={t("platform.deepseek.com 登录令牌")}
            disabled={saveDisabled}
            onChange={setUserToken}
            onClear={() => void clearCredential("deepseekUserToken")}
            clearDisabled={!userToken}
          />
          <DiagnosisButton
            test={() => testDeepSeekUserToken(userToken)}
            disabled={saveDisabled || saving || !userToken.trim()}
          />
          <p className="text-xs leading-relaxed text-fg-muted">
            {t(
              "获取方式：打开 platform.deepseek.com 并登录 → F12 打开开发者工具 → Application(应用) → Local Storage → https://platform.deepseek.com → 找到键 userToken，其值为 JSON 对象，复制其中 token 字段的字符串值。",
            )}
          </p>
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

        <Separator />

        <ProviderAutoRefresh providerId="deepseek" onOpenGeneral={onOpenGeneral} />

        <Separator />

        <AlertThresholdSetting providerId="deepseek" />
      </CardContent>
    </Card>
  );
}
