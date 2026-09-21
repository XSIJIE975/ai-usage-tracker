import { Donut } from "../../../components/charts/Donut";
import { useT } from "../../../i18n";
import type { WorkbuddyUsageAggregates } from "../../../providers/workbuddy-stats";
import { purposeLabel } from "./purpose";

/** 用途分布环形图（积分消耗口径）：悬停查看精确积分与占比；图例为用途可读名 */
export function WorkbuddyPurposeDonut({ aggregates }: { aggregates: WorkbuddyUsageAggregates }) {
  const { perPurpose } = aggregates;
  const t = useT();

  return (
    <Donut
      className="w-full"
      size={220}
      centerLabel={t("积分消耗")}
      format={(value) => value.toFixed(2)}
      segments={perPurpose.map((item) => ({
        name: purposeLabel(item.purpose, t),
        value: item.credits,
      }))}
    />
  );
}
