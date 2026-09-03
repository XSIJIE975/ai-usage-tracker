import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { providerName } from "../../providers";
import { displayName } from "../../lib/instance";
import { useT } from "../../i18n";
import type { ProviderInstance } from "../../types/ipc";

/** 删除实例的二次确认：明说凭据、快照历史与通知一并删除 */
export function DeleteInstanceDialog({
  instance,
  open,
  onOpenChange,
  onConfirm,
}: {
  instance: ProviderInstance | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useT();
  if (!instance) return null;
  const name = displayName(instance, providerName(instance.providerId));
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent aria-describedby={undefined}>
        <AlertDialogTitle>{t("删除「{name}」？").replace("{name}", name)}</AlertDialogTitle>
        <AlertDialogDescription>
          {t("将同时删除该 {provider} 实例的凭据、快照历史与通知，不可恢复。").replace(
            "{provider}",
            providerName(instance.providerId),
          )}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("取消")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("删除")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
