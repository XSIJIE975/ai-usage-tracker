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
import { testGlmCodingPlanKey, testGlmWebToken } from "../../diagnostics";
import { SaveMessageBanner, type ProviderSettingsProps, type SaveMessage } from "./provider-settings";
import { useT } from "../../i18n";
import type { CredentialsInput } from "../../types/ipc";

export function GlmSettings({
  saveDisabled,
  notice,
  credentials,
  credentialStatus,
  onChanged,
  onReload,
  onOpenGeneral,
}: ProviderSettingsProps) {
  const [planKey, setPlanKey] = useState("");
  const [webToken, setWebToken] = useState("");
  const [message, setMessage] = useState<SaveMessage>(null);
  const [saving, setSaving] = useState(false);
  const t = useT();

  useEffect(() => {
    setPlanKey(credentials?.glmCodingPlanKey ?? "");
    setWebToken(credentials?.glmWebToken ?? "");
  }, [credentials]);

  async function saveCredentials() {
    const input: CredentialsInput = {};
    if (planKey.trim()) input.glmCodingPlanKey = planKey.trim();
    if (webToken.trim()) input.glmWebToken = webToken.trim();
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
        <CardTitle>{t("智谱 GLM 凭据")}</CardTitle>
        <CardDescription>
          {t("Coding Plan Key 用于订阅配额查询，控制台登录 JWT 用于按量付费余额查询；两者互不通用。")}
        </CardDescription>
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
            <Label htmlFor="glmPlanKey">{t("智谱 Coding Plan Key")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.glmCodingPlanKey)} />
          </div>
          <SecretField
            id="glmPlanKey"
            value={planKey}
            placeholder="eyJ..."
            disabled={saveDisabled}
            onChange={setPlanKey}
            onClear={() => void clearCredential("glmCodingPlanKey")}
            clearDisabled={!planKey}
          />
          <DiagnosisButton
            test={() => testGlmCodingPlanKey(planKey)}
            disabled={saveDisabled || saving || !planKey.trim()}
          />
          <p className="text-xs leading-relaxed text-fg-muted">
            {t(
              "获取方式：打开 bigmodel.cn 控制台 → Coding Plan 页 → 「生成 API Key」，复制生成的 JWT 形态密钥。",
            )}
          </p>
        </div>

        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="glmWebToken">{t("控制台登录 JWT（会过期）")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.glmWebToken)} />
          </div>
          <SecretField
            id="glmWebToken"
            value={webToken}
            placeholder={t("bigmodel.cn 控制台登录令牌")}
            disabled={saveDisabled}
            onChange={setWebToken}
            onClear={() => void clearCredential("glmWebToken")}
            clearDisabled={!webToken}
          />
          <DiagnosisButton
            test={() => testGlmWebToken(webToken)}
            disabled={saveDisabled || saving || !webToken.trim()}
          />
          <p className="text-xs leading-relaxed text-fg-muted">
            {t(
              "获取方式：浏览器登录 bigmodel.cn → F12 打开开发者工具 → Application(应用) → Cookies → https://www.bigmodel.cn → 复制键 bigmodel_token_production 的值。该登录态会过期，余额查询失败时请重新粘贴。",
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

        <ProviderAutoRefresh providerId="glm" onOpenGeneral={onOpenGeneral} />

        <Separator />

        <AlertThresholdSetting providerId="glm" />
      </CardContent>
    </Card>
  );
}
