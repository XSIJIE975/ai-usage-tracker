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
import { testGlmCodingPlanKey } from "../../diagnostics";
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
  const [message, setMessage] = useState<SaveMessage>(null);
  const [saving, setSaving] = useState(false);
  const t = useT();

  useEffect(() => {
    setPlanKey(credentials?.glmCodingPlanKey ?? "");
  }, [credentials]);

  async function saveCredentials() {
    const input: CredentialsInput = {};
    if (planKey.trim()) input.glmCodingPlanKey = planKey.trim();
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
          {t("Coding Plan API Key 用于订阅配额与用量统计查询")}
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
            <Label htmlFor="glmPlanKey">{t("智谱 Coding Plan API Key")}</Label>
            <StatusBadge configured={Boolean(credentialStatus?.glmCodingPlanKey)} />
          </div>
          <SecretField
            id="glmPlanKey"
            value={planKey}
            placeholder={t("粘贴 API Key")}
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
              "获取方式：打开 bigmodel.cn 控制台 → Coding Plan 页 → 「生成 API Key」，复制生成的 API Key 粘贴到上方。",
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
