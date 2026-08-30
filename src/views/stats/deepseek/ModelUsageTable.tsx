import { useState } from "react";
import { DataTable, THead, TBody, Th, Tr, Td } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { formatCompact, formatInt, cn } from "../../../lib/utils";
import type { ModelUsage } from "./usage-aggregation";

/** 缓存命中率 = 命中 / (命中 + 未命中)，两位小数百分数；分母为 0 显示 "-"。 */
const cacheHitRate = (model: ModelUsage): string => {
  if (model.inputTokens <= 0) return "-";
  return `${((model.cacheHitTokens / model.inputTokens) * 100).toFixed(2)}%`;
};

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

/** 模型明细表：输入/缓存命中/命中率/输出/合计/请求/费用/占比。table-fixed 固定列宽。 */
export function ModelUsageTable({ models, totalTokens }: { models: ModelUsage[]; totalTokens: number }) {
  return (
    <DataTable className="table-fixed">
      <THead>
        <tr>
          <Th>模型</Th>
          <Th align="right" className="w-[104px]">输入 Token</Th>
          <Th align="right" className="w-[96px]">缓存命中</Th>
          <Th align="right" className="w-[104px]">缓存命中率</Th>
          <Th align="right" className="w-[96px]">输出 Token</Th>
          <Th align="right" className="w-[88px]">合计</Th>
          <Th align="right" className="w-[84px]">请求次数</Th>
          <Th align="right" className="w-[92px]">费用（¥）</Th>
          <Th align="right" className="w-[136px]">占比</Th>
        </tr>
      </THead>
      <TBody>
        {models.map((model) => {
          const share = totalTokens > 0 ? (model.totalTokens / totalTokens) * 100 : 0;
          const color = modelColor(model.model);
          return (
            <Tr key={model.model}>
              <Td>
                <span className="inline-flex items-center gap-2 overflow-hidden">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
                  <span className="truncate font-mono text-xs">{model.model}</span>
                </span>
              </Td>
              <Td align="right"><ToggleNumber value={model.inputTokens} /></Td>
              <Td align="right"><ToggleNumber value={model.cacheHitTokens} /></Td>
              <Td align="right" className="tnum">{cacheHitRate(model)}</Td>
              <Td align="right"><ToggleNumber value={model.outputTokens} /></Td>
              <Td align="right" className="font-medium"><ToggleNumber value={model.totalTokens} /></Td>
              <Td align="right">{formatInt(model.requests)}</Td>
              <Td align="right" className="whitespace-nowrap">¥{model.costCny.toFixed(2)}</Td>
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
      </TBody>
    </DataTable>
  );
}
