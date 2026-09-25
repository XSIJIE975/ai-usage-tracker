import { Donut } from "../../../components/charts/Donut";
import { useT } from "../../../i18n";
import type { QoderUsageAggregates } from "../../../providers/qoder-stats";

/** 用途分布环形图（积分消耗口径）。operation 是官网 UI 上的功能名，原样显示不翻译 */
export function QoderOperationDonut({ aggregates }: { aggregates: QoderUsageAggregates }) {
  const t = useT();

  return (
    <Donut
      className="w-full"
      size={220}
      centerLabel={t("积分消耗")}
      format={(value) => value.toFixed(2)}
      segments={aggregates.perOperation.map((group) => ({
        name: group.name,
        value: group.credits,
      }))}
    />
  );
}
