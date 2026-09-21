import { CalendarRange, Coins, Gauge, MessagesSquare } from "lucide-react";
import { StatCard } from "../../../components/ui/stat-card";
import { formatInt } from "../../../lib/utils";
import type { WorkbuddyUsageAggregates } from "../../../providers/workbuddy-stats";
import { useT } from "../../../i18n";

/** 指标总览四卡：请求 / 消耗 / 日均消耗 / 单次均耗 */
export function WorkbuddyOverviewCards({ aggregates }: { aggregates: WorkbuddyUsageAggregates }) {
  const { totalRequests, totalCredits, days, dailyAvgCredits, avgPerRequest, perModel } = aggregates;
  const t = useT();
  const credits = (value: number) => value.toFixed(2);

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatCard
        label={t("总请求次数")}
        value={formatInt(totalRequests)}
        icon={<MessagesSquare className="h-4 w-4" />}
        hint={`${t("日均")} ${formatInt(Math.round(totalRequests / days))} ${t("次")}`}
      />
      <StatCard
        label={t("总积分消耗")}
        value={credits(totalCredits)}
        icon={<Coins className="h-4 w-4" />}
        hint={`${days} ${t("天合计")}`}
      />
      <StatCard
        label={t("日均积分消耗")}
        value={credits(dailyAvgCredits)}
        icon={<CalendarRange className="h-4 w-4" />}
        hint={t("含 0 积分内部调用")}
      />
      <StatCard
        label={t("单次平均消耗")}
        value={credits(avgPerRequest)}
        icon={<Gauge className="h-4 w-4" />}
        hint={`${t("最常用模型")} ${perModel[0]?.model ?? "-"}`}
      />
    </div>
  );
}
