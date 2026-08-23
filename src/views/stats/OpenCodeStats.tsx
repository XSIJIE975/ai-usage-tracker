import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { IconButton } from "../../components/ui/icon-button";
import { Badge } from "../../components/ui/badge";
import { DataTable, THead, TBody, Th, Tr, Td } from "../../components/ui/data-table";
import { StackedBars } from "../../components/charts/StackedBars";
import { getOpenCodeCosts, getOpenCodeHistory, opencodeKeys, opencodeModels } from "../../data/mockStats";
import { formatInt } from "../../lib/utils";

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

const CURRENT = { year: 2026, month: 8 }; // 占位基准月

export function OpenCodeStats() {
  const [month, setMonth] = useState(CURRENT);
  const [model, setModel] = useState("all");
  const [keyId, setKeyId] = useState("all");

  const costs = useMemo(() => getOpenCodeCosts(month.year, month.month, keyId), [month, keyId]);
  const history = useMemo(() => getOpenCodeHistory(), []);

  const series = useMemo(() => {
    const selected = model === "all" ? opencodeModels : opencodeModels.filter((m) => m === model);
    return selected.map((name) => {
      const idx = opencodeModels.indexOf(name);
      return { name, values: costs.map((day) => day.costs[idx] ?? 0) };
    });
  }, [costs, model]);

  const monthTotal = useMemo(
    () => costs.reduce((sum, day) => sum + day.costs.reduce((a, b) => a + b, 0), 0),
    [costs],
  );

  function shiftMonth(delta: number) {
    setMonth((prev) => {
      const date = new Date(prev.year, prev.month - 1 + delta, 1);
      return { year: date.getFullYear(), month: date.getMonth() + 1 };
    });
  }

  const isCurrent = month.year === CURRENT.year && month.month === CURRENT.month;

  const modelOptions = [
    { value: "all", label: "所有模型" },
    ...opencodeModels.map((m) => ({ value: m as string, label: m })),
  ];

  return (
    <div className="space-y-4">
      {/* 成本图表 */}
      <Card>
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle>成本</CardTitle>
            <CardDescription>
              按模型细分的使用成本，本月合计 <span className="tnum font-medium text-fg">${monthTotal.toFixed(2)}</span>。
            </CardDescription>
          </div>
          <Badge variant="brand">占位数据</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* 月份翻页器 */}
            <div className="inline-flex items-center rounded-md border border-line bg-surface shadow-sm">
              <IconButton onClick={() => shiftMonth(-1)} aria-label="上一月" title="上一月" className="rounded-r-none">
                <ChevronLeft className="h-4 w-4" />
              </IconButton>
              <span className="tnum min-w-24 border-x border-line px-3 py-1.5 text-center text-[13px] font-medium text-fg">
                {month.year}年{month.month}月
              </span>
              <IconButton
                onClick={() => shiftMonth(1)}
                disabled={isCurrent}
                aria-label="下一月"
                title="下一月"
                className="rounded-l-none"
              >
                <ChevronRight className="h-4 w-4" />
              </IconButton>
            </div>
            <Select options={modelOptions} value={model} onChange={setModel} aria-label="模型筛选" />
            <Select options={opencodeKeys} value={keyId} onChange={setKeyId} aria-label="密钥筛选" />
          </div>

          <StackedBars
            labels={costs.map((d) => d.label)}
            series={series}
            yFormat={(v) => `$${formatInt(v)}`}
            tooltipFormat={(v) => `$${v.toFixed(2)}`}
            height={280}
          />
        </CardContent>
      </Card>

      {/* 使用历史 */}
      <Card>
        <CardHeader>
          <CardTitle>使用历史</CardTitle>
          <CardDescription>近期 API 使用情况和成本。</CardDescription>
        </CardHeader>
        <CardContent>
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
              {history.map((row, i) => (
                <Tr key={`${row.time}-${i}`}>
                  <Td className="whitespace-nowrap text-fg-secondary">{row.time}</Td>
                  <Td>
                    <span className="font-mono text-xs">{row.model}</span>
                  </Td>
                  <Td align="right">
                    <span className="inline-flex items-center gap-1.5">
                      <InlineBars />
                      {formatInt(row.inputTokens)}
                    </span>
                  </Td>
                  <Td align="right">
                    <span className="inline-flex items-center gap-1.5">
                      <InlineBars />
                      {formatInt(row.outputTokens)}
                    </span>
                  </Td>
                  <Td align="right" className="whitespace-nowrap text-fg-secondary">{row.costLabel}</Td>
                  <Td align="right">
                    <span className="font-mono text-xs text-fg-muted">{row.session}</span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </CardContent>
      </Card>
    </div>
  );
}
