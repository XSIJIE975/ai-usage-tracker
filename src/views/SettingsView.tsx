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
import type { ProviderKind } from "../types/ipc";

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
  const { vaultStatus, refreshAll, reloadInstances } = useAppStore();
  const instances = useAppStore((state) => state.instances);
  const [tab, setTab] = useState<SettingsTab>("general");
  const unlocked = Boolean(vaultStatus?.unlocked);

  // 过渡适配：设置页签仍按种类组织，凭据读写定向到该种类的第一个实例
  const firstInstanceOf = (kind: ProviderKind) =>
    instances.find((instance) => instance.providerId === kind) ?? null;
  const activeKind: ProviderKind | null =
    tab === "deepseek" ? "deepseek" : tab === "opencode" ? "opencode-go" : tab === "glm" ? "glm" : null;
  const activeInstance = activeKind ? firstInstanceOf(activeKind) : null;
  const { credentials, credentialStatus, reload } = useVaultCredentials(
    unlocked,
    activeInstance?.id ?? null,
  );

  const configuredOf = (kind: ProviderKind): boolean => {
    const instance = firstInstanceOf(kind);
    if (!instance) return false;
    if (kind !== activeKind) {
      // 非当前页签的实例没有加载状态：有实例行即视为可配置，状态点下次切页签时校准
      return true;
    }
    if (kind === "deepseek") return Boolean(credentialStatus?.apiKey || credentialStatus?.userToken);
    if (kind === "opencode-go")
      return Boolean(credentialStatus?.workspaceId && credentialStatus?.cookie);
    return Boolean(credentialStatus?.planKey);
  };

  const pendingMigration = Boolean(vaultStatus?.needsMigration);
  const providerProps: ProviderSettingsProps = {
    instance: activeInstance,
    saveDisabled: pendingMigration,
    notice:
      vaultStatus && !vaultStatus.unlocked && !vaultStatus.keychainLost
        ? t("凭据库待迁移，请先完成上方的一次性迁移，再保存凭据。")
        : undefined,
    credentials,
    credentialStatus,
    onChanged: async () => {
      await refreshAll(false);
      await reloadInstances();
    },
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
              <ProviderTabLabel name={t("DeepSeek 官方")} showDot={unlocked} configured={configuredOf("deepseek")} />
            ),
            icon: <DeepSeekLogo className="h-3.5 w-3.5" />,
          },
          {
            value: "opencode",
            label: (
              <ProviderTabLabel name={t("OpenCode Go")} showDot={unlocked} configured={configuredOf("opencode-go")} />
            ),
            icon: <OpenCodeLogo className="h-3.5 w-3.5" />,
          },
          {
            value: "glm",
            label: (
              <ProviderTabLabel name={t("智谱 GLM")} showDot={unlocked} configured={configuredOf("glm")} />
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
