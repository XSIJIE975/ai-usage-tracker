import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DataTable, TBody, Td, Th, THead, Tr } from "../../../components/ui/data-table";
import { IconButton } from "../../../components/ui/icon-button";
import { useLanguage, useT } from "../../../i18n";
import type { QoderUsageRow } from "../../../providers/qoder-stats";

const PAGE_SIZE = 50;

/** 积分格角标：未计费优先。样本里 Not Charged 的 `discount_factor` 恒为 1（官网没打折，
 *  是免费调用），即使哪天不恒为 1，「这条没扣积分」也是比"几折"更该露的那件事 */
export function recordBadge(row: { kind: string; discountFactor: number }): string | null {
  if (row.kind === "Not Charged") return "未计费";
  return discountLabel(row.discountFactor);
}

/** 折扣角标：官网给的是乘数（0.5 = 打五折），1 或脏值不显示 */
export function discountLabel(factor: number): string | null {
  if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) return null;
  const tenths = factor * 10;
  const text = Number.isInteger(tenths) ? String(tenths) : tenths.toFixed(1);
  return `${text} 折`;
}

/** 记录时刻 → 界面语言的短日期时间（毫秒 epoch，服务端与官网同为 CST 口径） */
function formatRecordTime(ms: number, language: "zh" | "en"): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** 逐条消耗明细：时间 / 用途 / 模型 / 积分 / 金额。
 *  聚合取数已拉全量分页，这里本地切片翻页；积分格带折扣角标，
 *  金额是官网给的 USD（0 显示「—」，代表该条未计费，不做任何换算） */
export function QoderUsageTable({ rows }: { rows: QoderUsageRow[] }) {
  const [page, setPage] = useState(0);
  const t = useT();
  const language = useLanguage();

  useEffect(() => {
    setPage(0);
  }, [rows]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div>
      <DataTable className="table-fixed min-w-[720px]">
        <THead>
          <tr>
            <Th className="w-[120px]">{t("时间")}</Th>
            <Th>{t("用途")}</Th>
            <Th className="w-[150px]">{t("模型")}</Th>
            <Th align="right" className="w-[104px]">{t("积分消耗")}</Th>
            <Th align="right" className="w-[92px]">{t("金额")}</Th>
          </tr>
        </THead>
        <TBody>
          {pageRows.map((row, index) => {
            const badge = recordBadge(row);
            return (
              <Tr key={`${row.time}-${safePage * PAGE_SIZE + index}`}>
                <Td className="tnum whitespace-nowrap text-fg-muted">
                  {formatRecordTime(row.time, language)}
                </Td>
                <Td>
                  <span className="min-w-0 truncate text-[13px] text-fg-secondary">
                    {row.operation || "-"}
                    {row.source && row.source !== "IDE" ? `（${row.source}）` : ""}
                  </span>
                </Td>
                <Td>
                  <span className="block truncate font-mono text-xs text-fg-muted">
                    {row.modelCategory || "-"}
                  </span>
                </Td>
                <Td align="right" className="font-medium">
                  {row.credits.toFixed(2)}
                  {badge && (
                    <span className="tnum ml-1 text-[11px] font-normal text-fg-muted">{t(badge)}</span>
                  )}
                </Td>
                <Td align="right" className="tnum text-fg-secondary">
                  {row.cost > 0 ? `$${row.cost.toFixed(2)}` : "—"}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </DataTable>
      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-[13px] text-fg-muted">
          <IconButton
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={safePage === 0}
            aria-label={t("上一页")}
            title={t("上一页")}
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <span className="tnum">
            {safePage + 1} / {pageCount}
          </span>
          <IconButton
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            disabled={safePage >= pageCount - 1}
            aria-label={t("下一页")}
            title={t("下一页")}
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
