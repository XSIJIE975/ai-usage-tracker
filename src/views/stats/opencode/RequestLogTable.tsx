import { DataTable, TBody, Td, Th, THead, Tr } from "../../../components/ui/data-table";
import { modelColor } from "../../../components/charts/palette";
import { formatCompact } from "../../../lib/utils";
import { useLanguage, useT } from "../../../i18n";
import type { OpenCodeRequestLog } from "../../../providers/opencode-stats";

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** 请求日志时间：zh "10-16 17:40:30"、en "Oct 16, 17:40:30" */
function formatLogTime(ms: number, language: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "-";
  if (language === "en") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  }
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1_000;
  // 59.96s 四舍五入后是 60s，先按分钟进位，避免出现 "60.0 s"
  if (seconds < 59.95) return `${seconds.toFixed(1)} s`;
  const rounded = Math.round(seconds);
  if (rounded >= 3_600) {
    return `${Math.floor(rounded / 3_600)}h ${Math.floor((rounded % 3_600) / 60)}m`;
  }
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

function formatCost(costUsd: number | null): string {
  return costUsd === null ? "—" : `$${costUsd.toFixed(4)}`;
}

/** 状态色走主题变量，跟随明暗主题与对比度设置 */
function statusColor(code: number | null): string {
  if (code === null) return "var(--fg-muted)";
  if (code >= 200 && code < 300) return "var(--success)";
  if (code >= 400) return "var(--danger)";
  return "var(--warning)";
}

/** 请求日志表：时间 / 状态 / 模型 / 耗时 / Token / 成本。 */
export function RequestLogTable({ logs }: { logs: OpenCodeRequestLog[] }) {
  const t = useT();
  const language = useLanguage();
  return (
    <DataTable className="table-fixed min-w-[688px]" maxHeight={420}>
      <THead>
        <tr>
          <Th className="w-[132px]">{t("时间")}</Th>
          <Th className="w-[104px]">{t("状态")}</Th>
          <Th>{t("模型")}</Th>
          <Th align="right" className="w-[82px]">
            {t("耗时")}
          </Th>
          <Th align="right" className="w-[80px]">
            {t("Tokens")}
          </Th>
          <Th align="right" className="w-[82px]">
            {t("成本")}
          </Th>
        </tr>
      </THead>
      <TBody>
        {logs.map((log, index) => (
          // 追加列表只增不改，索引后缀保证空 id/异常重复 id 也不会撞 key
          <Tr key={`${log.id || "log"}:${index}`}>
            <Td className="whitespace-nowrap text-fg-secondary">
              {formatLogTime(log.startedAt, language)}
            </Td>
            <Td>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor:
                      log.outcome && log.outcome !== "succeeded"
                        ? "var(--danger)"
                        : statusColor(log.statusCode),
                  }}
                />
                <span className="tnum text-xs">
                  {log.statusCode ?? "-"}
                  {log.outcome && log.outcome !== "succeeded"
                    ? ` ${log.outcome.charAt(0).toUpperCase()}${log.outcome.slice(1)}`
                    : ""}
                </span>
              </span>
            </Td>
            <Td>
              <div className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: modelColor(log.model) }}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono text-xs"
                  title={log.model || undefined}
                >
                  {log.model || "-"}
                </span>
              </div>
            </Td>
            <Td align="right" className="whitespace-nowrap text-fg-secondary">
              {formatDuration(log.durationMs)}
            </Td>
            <Td align="right">
              {/* outputTokens 已含 reasoning，再加会重复计数 */}
              {formatCompact(log.inputTokens + log.outputTokens)}
            </Td>
            <Td align="right" className="whitespace-nowrap text-fg-secondary">
              {formatCost(log.costUsd)}
            </Td>
          </Tr>
        ))}
      </TBody>
    </DataTable>
  );
}
