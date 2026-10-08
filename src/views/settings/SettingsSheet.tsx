import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { useT } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import { GeneralSettings } from "./GeneralSettings";
import { MigrationCard } from "./MigrationCard";

/** 抽屉打开时滚动区落在哪里：顶栏齿轮是「top」，「新版本」徽标是「update」 */
export type SettingsFocus = "top" | "update";

export function SettingsSheet({
  open,
  focus,
  onOpenChange,
}: {
  open: boolean;
  focus: SettingsFocus;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const vaultStatus = useAppStore((state) => state.vaultStatus);

  useEffect(() => {
    if (!open || focus !== "update") return;
    document.getElementById(UPDATE_CARD_ANCHOR)?.scrollIntoView({ block: "start" });
  }, [open, focus]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="w-[min(40rem,100vw)]">
        <SheetHeader>
          <SheetTitle>{t("设置")}</SheetTitle>
        </SheetHeader>
        <SheetBody className="space-y-4">
          {vaultStatus?.needsMigration && <MigrationCard />}

          {vaultStatus?.keychainLost && (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-[13px] leading-relaxed text-warning-soft-fg">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              {t(
                "本机设备密钥已丢失（常见于换机、重装系统或重置账户密码），原凭据无法恢复。请删除对应供应商后重新添加，保存时将重建凭据库。",
              )}
            </p>
          )}

          <GeneralSettings />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** 顶栏「新版本」徽标要求定位到的卡片锚点，见 views/settings/UpdateCard.tsx */
const UPDATE_CARD_ANCHOR = "settings-update-card";
