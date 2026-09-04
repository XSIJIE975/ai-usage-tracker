import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { DeepSeekStats } from "./DeepSeekStats";
import { OpenCodeStats } from "./OpenCodeStats";
import { GlmStats } from "./GlmStats";
import { displayName } from "../../lib/instance";
import { providerName } from "../../providers";
import { useT } from "../../i18n";
import type { ProviderInstance } from "../../types/ipc";

const STATS_COMPONENTS = {
  deepseek: DeepSeekStats,
  "opencode-go": OpenCodeStats,
  glm: GlmStats,
} as const;

/** 实例统计抽屉：按实例种类挂载对应统计模块（卡片「查看统计」入口） */
export function StatsSheet({
  instance,
  open,
  onOpenChange,
}: {
  instance: ProviderInstance | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  if (!instance) return null;
  const StatsComponent = STATS_COMPONENTS[instance.providerId];
  const kindName = providerName(instance.providerId);
  const title = displayName(instance, kindName);
  const hasNote = instance.note.trim().length > 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span>{title}</span>
            {hasNote && (
              <span className="text-[13px] font-normal text-fg-muted">{kindName}</span>
            )}
          </SheetTitle>
          <SheetDescription>{t("用量统计")}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {/* 必须传实例：同种类可建多个实例（如两个 GLM 账号），统计各自取数 */}
          <StatsComponent instance={instance} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
