import { Coins, Gauge, MessagesSquare, TrendingDown } from "lucide-react";
import { StatCard } from "../../../components/ui/stat-card";
import { formatInt } from "../../../lib/utils";
import type { QoderUsageAggregates } from "../../../providers/qoder-stats";
import { useT } from "../../../i18n";

/** 指标总览四卡：消耗 / 条数 / 日均 / 未扣积分（全部积分口径，不涉及金额量纲）。
 *  「未扣积分」= 折前合计 − 实扣，同时容纳官网折扣与未计费调用两种来源，不断言怎么省的 */
export function QoderOverviewCards({ aggregates }: { aggregates: QoderUsageAggregates }) {
  const { totalCredits, totalRequests, days, dailyAvgCredits, savedCredits } = aggregates;
  const t = useT();
  const credits = (value: number) => value.toFixed(2);

  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
      <StatCard
        label={t("总积分消耗")}
        value={credits(totalCredits)}
        icon={<Coins className="h-4 w-4" />}
        hint={`${days} ${t("天合计")}`}
      />
      <StatCard
        label={t("记录条数")}
        value={formatInt(totalRequests)}
        icon={<MessagesSquare className="h-4 w-4" />}
        hint={`${t("日均")} ${formatInt(days > 0 ? Math.round(totalRequests / days) : 0)} ${t("条")}`}
      />
      <StatCard
        label={t("日均积分消耗")}
        value={credits(dailyAvgCredits)}
        icon={<Gauge className="h-4 w-4" />}
        hint={t("按区间自然日摊平")}
      />
      <StatCard
        label={t("未扣积分")}
        value={credits(savedCredits)}
        icon={<TrendingDown className="h-4 w-4" />}
        hint={t("折前合计减去实扣")}
      />
    </div>
  );
}
