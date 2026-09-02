import { useState } from "react";
import { DataTable, THead, TBody, Th, Tr, Td } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { formatCompact, formatInt, cn } from "../../../lib/utils";
import { useT } from "../../../i18n";
import type { GlmModelAggregate } from "./usage-aggregation";

/** 大数点击切换紧凑展示（≥1 万生效）：83,442 ⇄ 83K，紧凑态悬停查看完整数值 */
function ToggleNumber({ value, className }: { value: number; className?: string }) {
  const [compact, setCompact] = useState(false);
  if (Math.abs(value) < 10_000) {
    return <span className={className}>{formatInt(value)}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => setCompact((prev) => !prev)}
      title={compact ? formatInt(value) : `${formatInt(value)}（点击切换紧凑显示）`}
      className={cn("cursor-pointer rounded-sm hover:text-brand", className)}
    >
      {compact ? formatCompact(value) : formatInt(value)}
    </button>
  );
}

/** 模型明细表：模型 / Token / 占比（接口不提供按模型的请求数与费用）。 */
export function GlmModelUsageTable({ models }: { models: GlmModelAggregate[] }) {
  const t = useT();
  return (
    <DataTable className="table-fixed min-w-[560px]">
      <THead>
        <tr>
          <Th>{t("模型")}</Th>
          <Th align="right" className="w-[128px]">{t("Token 合计")}</Th>
          <Th align="right" className="w-[168px]">{t("占比")}</Th>
        </tr>
      </THead>
      <TBody>
        {models.map((model) => {
          const color = modelColor(model.name);
          return (
            <Tr key={model.name}>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.name}</span>
                </div>
              </Td>
              <Td align="right" className="font-medium">
                <ToggleNumber value={model.tokens} />
              </Td>
              <Td align="right">
                <span className="inline-flex items-center justify-end gap-2">
                  <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-surface-2">
                    <span
                      className="block h-full rounded-full"
                      style={{ backgroundColor: color, width: `${Math.max(model.share, 2)}%` }}
                    />
                  </span>
                  <span className="tnum w-12 text-fg-muted">{model.share.toFixed(1)}%</span>
                </span>
              </Td>
            </Tr>
          );
        })}
      </TBody>
    </DataTable>
  );
}
