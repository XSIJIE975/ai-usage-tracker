import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { DeepSeekStats } from "./DeepSeekStats";
import { OpenCodeStats } from "./OpenCodeStats";
import { GlmStats } from "./GlmStats";
import { WorkbuddyStats } from "./workbuddy/WorkbuddyStats";
import { SiteBadge } from "../../components/SiteBadge";
import { displayName } from "../../lib/instance";
import { providerName } from "../../providers";
import { workbuddyApi, workbuddySiteOf } from "../../providers/workbuddy";
import { useT } from "../../i18n";
import type { ProviderInstance } from "../../types/ipc";

const STATS_COMPONENTS = {
  deepseek: DeepSeekStats,
  "opencode-go": OpenCodeStats,
  glm: GlmStats,
  // WorkBuddy 统计基于官网消耗明细接口（get-user-request-usage，2026-09-21 实测接入），
  // 纯只读，白名单见 ADR-0029
  workbuddy: WorkbuddyStats,
} as const;

/** 该实例有没有统计面：种类没挂统计模块（qoder 无历史/明细数据源，ADR-0030），或本站
 *  没有那个数据源（workbuddy 国际站无消耗明细，ADR-0031 能力表）都不出「查看统计」入口 */
export function providerHasStats(
  instance: Pick<ProviderInstance, "providerId" | "site">,
): boolean {
  if (!(instance.providerId in STATS_COMPONENTS)) return false;
  if (instance.providerId === "workbuddy") {
    return workbuddyApi(workbuddySiteOf(instance)).capabilities.stats;
  }
  return true;
}

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
  // 无统计面的实例（qoder，或本站没有明细数据源的 workbuddy 国际站）入口已隐藏；
  // 此处兜底直接不渲染，防误开空抽屉
  const StatsComponent = STATS_COMPONENTS[instance.providerId as keyof typeof STATS_COMPONENTS];
  if (!StatsComponent || !providerHasStats(instance)) return null;
  const kindName = t(providerName(instance.providerId));
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
            <SiteBadge providerId={instance.providerId} site={instance.site} translate={t} />
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
