import { Activity, Boxes, Coins, MessagesSquare } from "lucide-react";
import { StatCard } from "../../../components/ui/stat-card";
import { formatCompact, formatInt } from "../../../lib/utils";
import type { GlmUsageAggregates } from "./usage-aggregation";
import { useT } from "../../../i18n";

/** 指标总览四卡：Token / 请求 / 活跃模型 / 日均 Token（智谱接口无费用字段，无花费卡）。 */
export function GlmOverviewCards({ aggregates }: { aggregates: GlmUsageAggregates }) {
  const { perModel, totalTokens, totalCalls, days } = aggregates;
  const dailyTokens = days > 0 ? Math.round(totalTokens / days) : 0;
  const t = useT();

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatCard
        label={t("总 Token 消耗")}
        value={formatCompact(totalTokens)}
        icon={<Coins className="h-4 w-4" />}
        hint={`${days} ${t("天合计")}`}
      />
      <StatCard
        label={t("总请求次数")}
        value={formatInt(totalCalls)}
        icon={<MessagesSquare className="h-4 w-4" />}
        hint={t("全模型合计")}
      />
      <StatCard
        label={t("活跃模型数")}
        value={String(perModel.length)}
        icon={<Boxes className="h-4 w-4" />}
        hint={perModel[0]?.name ?? "-"}
      />
      <StatCard
        label={t("日均 Token")}
        value={formatCompact(dailyTokens)}
        icon={<Activity className="h-4 w-4" />}
        hint={t("按自然日平均")}
      />
    </div>
  );
}
