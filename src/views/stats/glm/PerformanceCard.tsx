import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { LineChartView } from "../../../components/charts/LineChart";
import { EmptyState } from "../../../components/ui/empty-state";
import { formatCompact, formatInt, cn } from "../../../lib/utils";
import { fetchGlmPerformance, type GlmPerformance } from "../../../providers/glm-stats";
import { useT } from "../../../i18n";

/** 系统健康度（官网同款）：Max&Pro 与 Lite 高峰期平均 Decode 速度（tokens/s），按日粒度 */
export function GlmPerformanceCard({
  instanceId,
  startMs,
  endMs,
  refreshTick,
}: {
  instanceId: string;
  startMs: number;
  endMs: number;
  refreshTick: number;
}) {
  const t = useT();
  const [state, setState] = useState<{
    kind: "loading" | "ready" | "hidden";
    data?: GlmPerformance;
  }>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchGlmPerformance(instanceId, startMs, endMs)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "ok" && result.data.buckets.length > 0) {
          setState({ kind: "ready", data: result.data });
        } else {
          // 无数据/接口失败：整块隐藏（健康度是平台侧指标，不缺这一块的错误提示）
          setState({ kind: "hidden" });
        }
      })
      .catch(() => !cancelled && setState({ kind: "hidden" }));
    return () => {
      cancelled = true;
    };
  }, [instanceId, startMs, endMs, refreshTick]);

  if (state.kind === "hidden") return null;

  const perf = state.data;
  const hasData = perf != null && perf.buckets.length > 0;

  return (
    <Card className="relative">
      {state.kind === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-canvas/40" />
      )}
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-brand" aria-hidden />
          {t("系统健康度")}
        </CardTitle>
        <CardDescription>{t("高峰期平均 Decode 速度（tokens/s），按日统计。")}</CardDescription>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {hasData ? (
          <LineChartView
            labels={perf!.buckets}
            series={[
              { name: t("Max&Pro 高峰期平均 Decode 速度"), values: perf!.proMaxDecodeSpeed },
              { name: t("Lite 高峰期平均 Decode 速度"), values: perf!.liteDecodeSpeed },
            ]}
            yFormat={formatCompact}
            tooltipFormat={(v) => `${formatInt(v)} tokens/s`}
            height={220}
            className={cn(state.kind === "loading" && "opacity-40")}
          />
        ) : (
          <EmptyState
            icon={<Activity className="h-5 w-5" />}
            title={t("所选时间范围内暂无健康度数据")}
          />
        )}
      </CardContent>
    </Card>
  );
}
