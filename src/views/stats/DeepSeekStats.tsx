import { useMemo, useState } from "react";
import { CalendarRange, KeyRound, MessagesSquare, Coins, Activity, Boxes } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select } from "../../components/ui/select";
import { Segmented } from "../../components/ui/segmented";
import { Label } from "../../components/ui/label";
import { StatCard } from "../../components/ui/stat-card";
import { DataTable, THead, TBody, Th, Tr, Td } from "../../components/ui/data-table";
import { StackedBars } from "../../components/charts/StackedBars";
import { Donut } from "../../components/charts/Donut";
import { CHART_BGS, modelColorIndex } from "../../components/charts/palette";
import { deepseekApiKeys, getDeepSeekSeries } from "../../data/mockStats";
import { formatCompact, formatInt, cn } from "../../lib/utils";

type TimeRange = "today" | "yesterday" | "7d" | "30d" | "month" | "lastMonth" | "custom";

const timeRangeOptions: { value: TimeRange; label: string }[] = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "month", label: "本月" },
  { value: "lastMonth", label: "上月" },
  { value: "custom", label: "自定义范围" },
];

function daysOf(range: TimeRange, customDays: number): number {
  switch (range) {
    case "today":
    case "yesterday":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "month":
      return 23; // 占位：本月 1 日至今日
    case "lastMonth":
      return 31;
    case "custom":
      return Math.max(1, Math.min(60, customDays));
  }
}

export function DeepSeekStats() {
  const [range, setRange] = useState<TimeRange>("7d");
  const [apiKey, setApiKey] = useState("all");
  const [metric, setMetric] = useState<"tokens" | "requests">("tokens");
  const [customFrom, setCustomFrom] = useState("2026-08-10");
  const [customTo, setCustomTo] = useState("2026-08-23");

  const customDays = useMemo(() => {
    const from = new Date(customFrom).getTime();
    const to = new Date(customTo).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 14;
    return Math.round((to - from) / 86_400_000) + 1;
  }, [customFrom, customTo]);

  const { labels, series } = useMemo(
    () => getDeepSeekSeries(daysOf(range, customDays), apiKey),
    [range, apiKey, customDays],
  );

  const aggregates = useMemo(() => {
    let totalTokens = 0;
    let totalRequests = 0;
    const perModel = series.map((s) => {
      const tin = s.tokensIn.reduce((a, b) => a + b, 0);
      const tout = s.tokensOut.reduce((a, b) => a + b, 0);
      const req = s.requests.reduce((a, b) => a + b, 0);
      totalTokens += tin + tout;
      totalRequests += req;
      return { model: s.model, tokensIn: tin, tokensOut: tout, requests: req };
    });
    return { totalTokens, totalRequests, perModel };
  }, [series]);

  const days = labels.length;
  const chartSeries = series.map((s) => ({
    name: s.model,
    values: metric === "tokens" ? s.tokensIn.map((v, i) => v + s.tokensOut[i]) : s.requests,
  }));

  return (
    <div className="space-y-4">
      {/* 筛选工具条 */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" /> 时间范围
            </Label>
            <div className="flex items-center gap-2">
              <Select options={timeRangeOptions} value={range} onChange={setRange} aria-label="时间范围" />
              {range === "custom" && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.currentTarget.value)}
                    className="h-9 rounded-md border border-line bg-surface px-2 text-[13px] text-fg shadow-sm focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
                    aria-label="开始日期"
                  />
                  <span className="text-fg-muted">–</span>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.currentTarget.value)}
                    className="h-9 rounded-md border border-line bg-surface px-2 text-[13px] text-fg shadow-sm focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-focus-ring"
                    aria-label="结束日期"
                  />
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              <KeyRound className="h-3.5 w-3.5" /> API 密钥
            </Label>
            <Select options={deepseekApiKeys} value={apiKey} onChange={setApiKey} aria-label="API 密钥" />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">统计指标</Label>
            <Segmented
              value={metric}
              onChange={setMetric}
              options={[
                { value: "tokens", label: "Token 消耗" },
                { value: "requests", label: "请求次数" },
              ]}
            />
          </div>
        </div>
      </Card>

      {/* 指标总览 */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard label="总 Token 消耗" value={formatCompact(aggregates.totalTokens)} icon={<Coins className="h-4 w-4" />} hint={`${days} 天合计`} />
        <StatCard label="总请求次数" value={formatInt(aggregates.totalRequests)} icon={<MessagesSquare className="h-4 w-4" />} hint={`日均 ${formatInt(Math.round(aggregates.totalRequests / days))} 次`} />
        <StatCard label="活跃模型" value={String(aggregates.perModel.length)} icon={<Boxes className="h-4 w-4" />} hint={aggregates.perModel[0]?.model ?? "-"} />
        <StatCard label="日均 Token" value={formatCompact(Math.round(aggregates.totalTokens / days))} icon={<Activity className="h-4 w-4" />} hint="输入 + 输出" />
      </div>

      {/* 图表区 */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>{metric === "tokens" ? "Token 消耗趋势" : "请求次数趋势"}</CardTitle>
            <CardDescription>按模型堆叠，悬停查看每日明细。</CardDescription>
          </CardHeader>
          <CardContent>
            <StackedBars
              labels={labels}
              series={chartSeries}
              yFormat={formatCompact}
              tooltipFormat={formatInt}
            />
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>模型 Token 占比</CardTitle>
            <CardDescription>所选时间范围内的消耗构成。</CardDescription>
          </CardHeader>
          <CardContent className="flex min-h-[260px] items-center">
            <Donut
              className="w-full"
              centerLabel="总 Token"
              format={formatCompact}
              segments={aggregates.perModel.map((m) => ({ name: m.model, value: m.tokensIn + m.tokensOut }))}
            />
          </CardContent>
        </Card>
      </div>

      {/* 模型明细表 */}
      <Card>
        <CardHeader>
          <CardTitle>模型明细</CardTitle>
          <CardDescription>各模型的 token 消耗与请求次数。</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable>
            <THead>
              <tr>
                <Th>模型</Th>
                <Th align="right">输入 Token</Th>
                <Th align="right">输出 Token</Th>
                <Th align="right">合计 Token</Th>
                <Th align="right">请求次数</Th>
                <Th align="right">Token 占比</Th>
              </tr>
            </THead>
            <TBody>
              {aggregates.perModel.map((m) => {
                const total = m.tokensIn + m.tokensOut;
                const share = aggregates.totalTokens > 0 ? (total / aggregates.totalTokens) * 100 : 0;
                const colorIdx = modelColorIndex(m.model);
                return (
                  <Tr key={m.model}>
                    <Td>
                      <span className="inline-flex items-center gap-2">
                        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-[3px]", CHART_BGS[colorIdx])} />
                        <span className="font-mono text-xs">{m.model}</span>
                      </span>
                    </Td>
                    <Td align="right">{formatInt(m.tokensIn)}</Td>
                    <Td align="right">{formatInt(m.tokensOut)}</Td>
                    <Td align="right" className="font-medium">{formatInt(total)}</Td>
                    <Td align="right">{formatInt(m.requests)}</Td>
                    <Td align="right">
                      <span className="inline-flex items-center justify-end gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                          <span
                            className={cn("block h-full rounded-full", CHART_BGS[colorIdx])}
                            style={{ width: `${Math.max(share, 2)}%` }}
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
        </CardContent>
      </Card>
    </div>
  );
}
