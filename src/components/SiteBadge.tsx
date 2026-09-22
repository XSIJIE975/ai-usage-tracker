import { hasMultipleSites, SITE_LABELS } from "../lib/instance";
import { cn } from "../lib/utils";
import type { ProviderKind, ProviderSite } from "../types/ipc";

/**
 * 多站供应商的站点徽标（ADR-0031）：同一供应商的两张卡片在没写备注时完全同形，
 * 站点是区分它们的唯一现成信息。单站种类返回 null，调用方不必自己判断。
 * 速览面板只有 320px 宽，徽标固定不换行且用短标签。
 */
export function SiteBadge({
  providerId,
  site,
  translate,
  className,
}: {
  providerId: ProviderKind;
  site: ProviderSite;
  translate: (text: string) => string;
  className?: string;
}) {
  if (!hasMultipleSites(providerId)) return null;
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded border border-line bg-surface-2 px-1 text-[10px] leading-4 text-fg-muted",
        className,
      )}
    >
      {translate(SITE_LABELS[site])}
    </span>
  );
}
