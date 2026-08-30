import { Activity, Boxes, Coins, MessagesSquare, Wallet } from "lucide-react";
import { StatCard } from "../../../components/ui/stat-card";
import { formatCompact, formatInt } from "../../../lib/utils";
import type { UsageAggregates } from "./usage-aggregation";

/** 币种代码 → 展示前缀；CNY 显示 ¥，其余原样展示。 */
const currencyPrefix = (currency: string): string => (currency === "CNY" ? "¥" : currency);

/** 指标总览五卡：Token / 请求 / 花费 / 活跃模型 / 日均 Token。 */
export function OverviewCards({ aggregates, currency }: { aggregates: UsageAggregates; currency: string }) {
  const { perModel, totalTokens, totalRequests, totalCostCny, days } = aggregates;
  const dailyTokens = days > 0 ? Math.round(totalTokens / days) : 0;
  const dailyRequests = days > 0 ? Math.round(totalRequests / days) : 0;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      <StatCard
        label="总 Token 消耗"
        value={formatCompact(totalTokens)}
        icon={<Coins className="h-4 w-4" />}
        hint={`${days} 天合计`}
      />
      <StatCard
        label="总请求次数"
        value={formatInt(totalRequests)}
        icon={<MessagesSquare className="h-4 w-4" />}
        hint={`日均 ${formatInt(dailyRequests)} 次`}
      />
      <StatCard
        label="总花费"
        value={`${currencyPrefix(currency)}${totalCostCny.toFixed(2)}`}
        icon={<Wallet className="h-4 w-4" />}
        hint={`币种 ${currency}`}
      />
      <StatCard
        label="活跃模型数"
        value={String(perModel.length)}
        icon={<Boxes className="h-4 w-4" />}
        hint={perModel[0]?.model ?? "-"}
      />
      <StatCard
        label="日均 Token"
        value={formatCompact(dailyTokens)}
        icon={<Activity className="h-4 w-4" />}
        hint="输入 + 输出"
      />
    </div>
  );
}
