import { DataTable, TBody, Td, Th, THead, Tr } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { formatInt } from "../../../lib/utils";
import { useT } from "../../../i18n";
import type { QoderUsageAggregates } from "../../../providers/qoder-stats";

/** 模型维度表：model_category × 条数 × 积分 × 单次均耗 × 占比，末行合计。
 *  模型名原样显示（官方上新不停，翻译表必然过期） */
export function QoderModelTable({ aggregates }: { aggregates: QoderUsageAggregates }) {
  const { perModel, totalRequests, totalCredits } = aggregates;
  const t = useT();
  const credits = (value: number) => value.toFixed(2);

  return (
    <DataTable className="table-fixed min-w-[640px]">
      <THead>
        <tr>
          <Th>{t("模型")}</Th>
          <Th align="right" className="w-[96px]">{t("记录条数")}</Th>
          <Th align="right" className="w-[104px]">{t("积分消耗")}</Th>
          <Th align="right" className="w-[104px]">{t("单次平均消耗")}</Th>
          <Th align="right" className="w-[136px]">{t("占比")}</Th>
        </tr>
      </THead>
      <TBody>
        {perModel.map((model) => {
          const share = totalCredits > 0 ? (model.credits / totalCredits) * 100 : 0;
          const avg = model.requests > 0 ? model.credits / model.requests : 0;
          const color = modelColor(model.name);
          return (
            <Tr key={model.name}>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.name}</span>
                </div>
              </Td>
              <Td align="right">{formatInt(model.requests)}</Td>
              <Td align="right" className="font-medium">{credits(model.credits)}</Td>
              <Td align="right" className="tnum">{credits(avg)}</Td>
              <Td align="right">
                <span className="inline-flex items-center justify-end gap-2">
                  <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full"
                      style={{ backgroundColor: color, width: `${Math.max(share, 2)}%` }}
                    />
                  </span>
                  <span className="tnum w-12 text-fg-muted">{share.toFixed(1)}%</span>
                </span>
              </Td>
            </Tr>
          );
        })}
        <Tr>
          <Td className="font-medium">{t("合计")}</Td>
          <Td align="right" className="font-medium">{formatInt(totalRequests)}</Td>
          <Td align="right" className="font-medium">{credits(totalCredits)}</Td>
          <Td align="right" className="tnum">
            {totalRequests > 0 ? credits(totalCredits / totalRequests) : "-"}
          </Td>
          <Td align="right" className="tnum text-fg-muted">
            {totalCredits > 0 ? "100%" : "-"}
          </Td>
        </Tr>
      </TBody>
    </DataTable>
  );
}
