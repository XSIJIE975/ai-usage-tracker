import { DataTable, TBody, Td, Th, THead, Tr } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { formatCompact, formatInt } from "../../../lib/utils";
import { useT } from "../../../i18n";
import type { OpenCodeModelUsage } from "../../../providers/opencode-stats";

/** 按模型用量表：模型 / 请求 / 输入 / 缓存读取 / 缓存写入 / 输出 / 成本。 */
export function ModelUsageTable({ models }: { models: OpenCodeModelUsage[] }) {
  const t = useT();
  return (
    <DataTable className="table-fixed min-w-[760px]" maxHeight={360}>
      <THead>
        <tr>
          <Th>{t("模型")}</Th>
          <Th align="right" className="w-[76px]">
            {t("请求")}
          </Th>
          <Th align="right" className="w-[88px]">
            {t("输入")}
          </Th>
          <Th align="right" className="w-[96px]">
            {t("缓存读取")}
          </Th>
          <Th align="right" className="w-[96px]">
            {t("缓存写入")}
          </Th>
          <Th align="right" className="w-[88px]">
            {t("输出")}
          </Th>
          <Th align="right" className="w-[84px]">
            {t("成本")}
          </Th>
        </tr>
      </THead>
      <TBody>
        {models.map((model, index) => (
          <Tr key={`${model.provider}:${model.model}:${index}`}>
            <Td>
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: modelColor(model.model) }}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={model.model || undefined}
                >
                  {model.model || "-"}
                </span>
              </div>
            </Td>
            <Td align="right">{formatInt(model.requests)}</Td>
            <Td align="right">{formatCompact(model.inputTokens)}</Td>
            <Td align="right">{formatCompact(model.cacheReadTokens)}</Td>
            <Td align="right">{formatCompact(model.cacheWriteTokens)}</Td>
            <Td align="right">{formatCompact(model.outputTokens)}</Td>
            <Td align="right" className="whitespace-nowrap text-fg-secondary">
              ${model.costUsd.toFixed(4)}
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
