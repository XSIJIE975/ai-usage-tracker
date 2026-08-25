import { DataTable, THead, TBody, Th, Tr, Td } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { formatInt } from "../../../lib/utils";
import type { OpenCodeUsageRecord } from "../../../providers/opencode-stats";

/** 表格内 token 数前的迷你柱状 glyph（参照产品截图形态） */
function InlineBars() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="inline-block shrink-0 text-fg-muted" aria-hidden>
      <rect x="0.5" y="7" width="2" height="4" rx="0.5" fill="currentColor" />
      <rect x="3.8" y="4.5" width="2" height="6.5" rx="0.5" fill="currentColor" />
      <rect x="7.1" y="2" width="2" height="9" rx="0.5" fill="currentColor" />
      <rect x="10.4" y="5.5" width="1.6" height="5.5" rx="0.5" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/** ISO 时间 → 本地 "M月D日 HH:mm" */
const formatRecordTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/** 使用历史表：日期/模型/输入/输出/成本/会话（记录按返回顺序直接渲染）。 */
export function UsageHistoryTable({ records }: { records: OpenCodeUsageRecord[] }) {
  return (
    <DataTable>
      <THead>
        <tr>
          <Th>日期</Th>
          <Th>模型</Th>
          <Th align="right">输入</Th>
          <Th align="right">输出</Th>
          <Th align="right">成本</Th>
          <Th align="right">会话</Th>
        </tr>
      </THead>
      <TBody>
        {records.map((record) => (
          <Tr key={record.id || `${record.timeCreated}-${record.model}`}>
            <Td className="whitespace-nowrap text-fg-secondary">{formatRecordTime(record.timeCreated)}</Td>
            <Td>
              <span className="inline-flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: modelColor(record.model) }}
                />
                <span className="font-mono text-xs">{record.model}</span>
              </span>
            </Td>
            <Td align="right">
              <span className="inline-flex items-center gap-1.5">
                <InlineBars />
                {formatInt(record.inputTokens)}
              </span>
            </Td>
            <Td align="right">
              <span className="inline-flex items-center gap-1.5">
                <InlineBars />
                {formatInt(record.outputTokens)}
              </span>
            </Td>
            <Td align="right" className="whitespace-nowrap text-fg-secondary">${record.costUsd.toFixed(4)}</Td>
            <Td align="right">
              <span className="font-mono text-xs text-fg-muted">{record.sessionId || "-"}</span>
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
