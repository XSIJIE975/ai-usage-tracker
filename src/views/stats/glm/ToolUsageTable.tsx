import { Wrench } from "lucide-react";
import { DataTable, THead, TBody, Th, Tr, Td } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { EmptyState } from "../../../components/ui/empty-state";
import { formatInt } from "../../../lib/utils";
import { useLanguage, useT } from "../../../i18n";
import type { GlmToolUsage } from "../../../providers/glm-stats";

/**
 * 工具用量表：只渲染解析后的展示序列（动态 toolDataList 为权威，固定序列兜底）。
 * 动态序列带服务端双语名：英文界面优先 i18nName，中文界面原样展示；
 * 固定序列名为中文词条 key，走 t() 翻译。
 */
export function GlmToolUsageTable({ tools }: { tools: GlmToolUsage }) {
  const t = useT();
  const language = useLanguage();
  const toolName = (tool: { name: string; i18nName?: string }): string =>
    language === "en" && tool.i18nName ? tool.i18nName : t(tool.name);

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
        {tools.tools.map((tool) => {
          const share = tools.totalCalls > 0 ? (tool.total / tools.totalCalls) * 100 : 0;
          const color = modelColor(tool.name);
          return (
            <Tr key={tool.name}>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
                  <span className="min-w-0 flex-1 truncate text-xs">{toolName(tool)}</span>
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
