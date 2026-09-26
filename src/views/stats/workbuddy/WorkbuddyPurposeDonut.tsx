import { useMemo } from "react";
import { Donut } from "../../../components/charts/Donut";
import { useT } from "../../../i18n";
import type { WorkbuddyUsageAggregates } from "../../../providers/workbuddy-stats";
import { purposeLabel } from "./purpose";

/** 格式化器必须是稳定引用：内联箭头函数每次渲染都是新身份，会穿透 Donut 的 option useMemo
 *  导致每次渲染 setOption（违背「hover 不 setOption」铁律） */
const formatCredits = (value: number) => value.toFixed(2);

/** 用途分布环形图（积分消耗口径）：悬停查看精确积分与占比；图例为用途可读名 */
export function WorkbuddyPurposeDonut({ aggregates }: { aggregates: WorkbuddyUsageAggregates }) {
  const t = useT();
  const segments = useMemo(
    () =>
      aggregates.perPurpose.map((item) => ({
        name: purposeLabel(item.purpose, t),
        value: item.credits,
      })),
    [aggregates, t],
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
