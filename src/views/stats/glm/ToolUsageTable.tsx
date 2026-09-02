import { Wrench } from "lucide-react";
import { DataTable, THead, TBody, Th, Tr, Td } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { EmptyState } from "../../../components/ui/empty-state";
import { formatInt } from "../../../lib/utils";
import { useT } from "../../../i18n";
import type { GlmToolUsage } from "../../../providers/glm-stats";

/**
 * 工具用量表：固定序列（联网搜索/网页阅读 MCP/Zread MCP，名称为中文词条，t() 翻译）
 * + 动态 toolDataList（服务端工具名原样展示；en 缺键时 t() 回退原名）。
 */
export function GlmToolUsageTable({ tools }: { tools: GlmToolUsage }) {
  const t = useT();
  const rows = [...tools.fixed, ...tools.tools];

  if (tools.totalCalls === 0) {
    return (
      <EmptyState
        icon={<Wrench className="h-5 w-5" />}
        title={t("所选时间范围内没有工具调用")}
        description={t("Coding Plan 的联网搜索、网页阅读与 MCP 工具调用会在此统计。")}
      />
    );
  }

  return (
    <DataTable className="table-fixed min-w-[520px]">
      <THead>
        <tr>
          <Th>{t("工具")}</Th>
          <Th align="right" className="w-[120px]">{t("调用次数")}</Th>
          <Th align="right" className="w-[168px]">{t("占比")}</Th>
        </tr>
      </THead>
      <TBody>
        {rows.map((tool) => {
          const share = tools.totalCalls > 0 ? (tool.total / tools.totalCalls) * 100 : 0;
          const color = modelColor(tool.name);
          return (
            <Tr key={tool.name}>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
                  <span className="min-w-0 flex-1 truncate text-xs">{t(tool.name)}</span>
                </div>
              </Td>
              <Td align="right" className="font-medium tnum">{formatInt(tool.total)}</Td>
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
