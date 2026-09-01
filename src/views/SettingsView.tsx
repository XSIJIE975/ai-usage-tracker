import { useState } from "react";
import { useT } from "../i18n";
import { AlertTriangle, Settings2 } from "lucide-react";
import { DeepSeekLogo, GlmLogo, OpenCodeLogo } from "../components/brand/provider-logo";
import { useAppStore } from "../store/useAppStore";
import { Tabs } from "../components/ui/tabs";
import { cn } from "../lib/utils";
import { MigrationCard } from "./settings/MigrationCard";
import { GeneralSettings } from "./settings/GeneralSettings";
import { DeepSeekSettings } from "./settings/DeepSeekSettings";
import { GlmSettings } from "./settings/GlmSettings";
import { OpenCodeGoSettings } from "./settings/OpenCodeGoSettings";
import { useVaultCredentials } from "./settings/use-vault-credentials";
import type { ProviderSettingsProps } from "./settings/provider-settings";

type SettingsTab = "general" | "deepseek" | "opencode" | "glm";

function ProviderTabLabel({
  name,
  showDot,
  configured,
}: {
  name: string;
  showDot: boolean;
  configured: boolean;
}) {
  const t = useT();
  return (
    <span className="inline-flex items-center gap-1.5">
      {name}
      {showDot && (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", configured ? "bg-success" : "bg-warning")}
          title={configured ? t("凭据已配置") : t("凭据未配置")}
          aria-label={configured ? t("凭据已配置") : t("凭据未配置")}
        />
      )}
    </span>
  );
}

export function SettingsView() {
  const t = useT();
  const { vaultStatus, refreshAll } = useAppStore();
  const [tab, setTab] = useState<SettingsTab>("general");
  const unlocked = Boolean(vaultStatus?.unlocked);
  const { credentials, credentialStatus, reload } = useVaultCredentials(unlocked);

  const deepseekConfigured = Boolean(
    credentialStatus?.deepseekApiKey || credentialStatus?.deepseekUserToken,
  );
  const opencodeConfigured = Boolean(
    credentialStatus?.opencodeGoWorkspaceId && credentialStatus?.opencodeGoAuthCookie,
  );
  const glmConfigured = Boolean(credentialStatus?.glmCodingPlanKey || credentialStatus?.glmWebToken);

  const pendingMigration = Boolean(vaultStatus?.needsMigration);
  const providerProps: ProviderSettingsProps = {
    saveDisabled: pendingMigration,
    notice:
      vaultStatus && !vaultStatus.unlocked && !vaultStatus.keychainLost
        ? t("凭据库待迁移，请先完成上方的一次性迁移，再保存凭据。")
        : undefined,
    credentials,
    credentialStatus,
    onChanged: () => refreshAll(false),
    onReload: reload,
    onOpenGeneral: () => setTab("general"),
  };

  return (
    <div className="space-y-4">
      {pendingMigration && <MigrationCard />}

      {vaultStatus?.keychainLost && (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-soft-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("本机设备密钥已丢失（常见于换机、重装系统或重置账户密码），原凭据无法恢复。请在供应商页签中重新录入凭据，保存时将重建凭据库。")}
        </p>
      )}

      <Tabs<SettingsTab>
        value={tab}
        onChange={setTab}
        items={[
          { value: "general", label: t("通用"), icon: <Settings2 className="h-3.5 w-3.5" /> },
          {
            value: "deepseek",
            label: (
              <ProviderTabLabel name={t("DeepSeek 官方")} showDot={unlocked} configured={deepseekConfigured} />
            ),
            icon: <DeepSeekLogo className="h-3.5 w-3.5" />,
          },
          {
            value: "opencode",
            label: (
              <ProviderTabLabel name={t("OpenCode Go")} showDot={unlocked} configured={opencodeConfigured} />
            ),
            icon: <OpenCodeLogo className="h-3.5 w-3.5" />,
          },
          {
            value: "glm",
            label: (
              <ProviderTabLabel name={t("智谱 GLM")} showDot={unlocked} configured={glmConfigured} />
            ),
            icon: <GlmLogo className="h-3.5 w-3.5" />,
          },
        ]}
      />

      {tab === "general" && <GeneralSettings />}
      {tab === "deepseek" && <DeepSeekSettings {...providerProps} />}
      {tab === "opencode" && <OpenCodeGoSettings {...providerProps} />}
      {tab === "glm" && <GlmSettings {...providerProps} />}
    </div>
  );
}
