import { useMemo } from "react";
import { Donut } from "../../../components/charts/Donut";
import { useT } from "../../../i18n";
import type { QoderUsageAggregates } from "../../../providers/qoder-stats";

/** 格式化器必须是稳定引用：内联箭头函数每次渲染都是新身份，会穿透 Donut 的 option useMemo
 *  导致每次渲染 setOption（违背「hover 不 setOption」铁律） */
const formatCredits = (value: number) => value.toFixed(2);

/** 用途分布环形图（积分消耗口径）。operation 是官网 UI 上的功能名，原样显示不翻译 */
export function QoderOperationDonut({ aggregates }: { aggregates: QoderUsageAggregates }) {
  const t = useT();
  const segments = useMemo(
    () => aggregates.perOperation.map((group) => ({ name: group.name, value: group.credits })),
    [aggregates],
  );

  return (
    <Donut
      className="w-full"
      size={220}
      centerLabel={t("积分消耗")}
      format={formatCredits}
      segments={segments}
    />
  );
}
