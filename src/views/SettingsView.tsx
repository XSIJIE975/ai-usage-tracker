import { AlertTriangle } from "lucide-react";
import { useT } from "../i18n";
import { MigrationCard } from "./settings/MigrationCard";
import { GeneralSettings } from "./settings/GeneralSettings";
import { useAppStore } from "../store/useAppStore";

/** 设置视图只保留通用设置；各实例的凭据与阈值在其配置弹窗中管理 */
export function SettingsView() {
  const t = useT();
  const vaultStatus = useAppStore((state) => state.vaultStatus);

  return (
    <div className="space-y-4">
      {vaultStatus?.needsMigration && <MigrationCard />}

      {vaultStatus?.keychainLost && (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-soft-fg">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {t("本机设备密钥已丢失（常见于换机、重装系统或重置账户密码），原凭据无法恢复。请删除对应供应商后重新添加，保存时将重建凭据库。")}
        </p>
      )}

      <GeneralSettings />
    </div>
  );
}
