import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DataTable, TBody, Td, Th, THead, Tr } from "../../../components/ui/data-table";
import { IconButton } from "../../../components/ui/icon-button";
import { applyParams, useT } from "../../../i18n";
import type { WorkbuddyUsageRow } from "../../../providers/workbuddy-stats";
import { purposeLabel } from "./purpose";

const PAGE_SIZE = 50;

/** 消耗明细表：时间 / 请求摘要（inputTrunc，接口侧已截断）/ 积分 / 模型 / 用途。
 *  聚合取数本就拉了全量分页，这里直接本地切片分页，不再发独立请求；
 *  rows 变化（换范围/刷新）时回到第一页 */
export function WorkbuddyUsageTable({ rows }: { rows: WorkbuddyUsageRow[] }) {
  const [page, setPage] = useState(0);
  const t = useT();

  useEffect(() => {
    setPage(0);
  }, [rows]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const credits = (value: number) => value.toFixed(2);

  return (
    <div>
      <DataTable className="table-fixed min-w-[720px]">
        <THead>
          <tr>
            <Th className="w-[136px]">{t("时间")}</Th>
            <Th>{t("请求")}</Th>
            <Th align="right" className="w-[92px]">{t("积分消耗")}</Th>
            <Th className="w-[150px]">{t("模型")}</Th>
            <Th className="w-[104px]">{t("用途")}</Th>
          </tr>
        </THead>
        <TBody>
          {pageRows.map((row) => (
            <Tr key={row.requestId}>
              <Td className="whitespace-nowrap text-fg-muted">{row.time}</Td>
              <Td>
                <span
                  className="block truncate text-[13px] text-fg-secondary"
                  title={row.inputTrunc}
                >
                  {row.inputTrunc || "-"}
                </span>
              </Td>
              <Td align="right" className="whitespace-nowrap font-medium">{credits(row.credit)}</Td>
              <Td>
                <span className="block truncate font-mono text-xs" title={row.model}>
                  {row.model || "-"}
                </span>
              </Td>
              <Td className="text-fg-muted">{purposeLabel(row.purpose, t)}</Td>
            </Tr>
          ))}
        </TBody>
      </DataTable>

      <div className="flex items-center justify-between pt-3 text-[13px] text-fg-muted">
        <span>{applyParams(t("共 {count} 条"), { count: rows.length })}</span>
        <div className="flex items-center gap-2">
          <span className="tnum">
            {safePage + 1} / {pageCount}
          </span>
          <IconButton
            onClick={() => setPage(safePage - 1)}
            disabled={safePage === 0}
            aria-label={t("上一页")}
            title={t("上一页")}
          >
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <IconButton
            onClick={() => setPage(safePage + 1)}
            disabled={safePage >= pageCount - 1}
            aria-label={t("下一页")}
            title={t("下一页")}
          >
            <ChevronRight className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
