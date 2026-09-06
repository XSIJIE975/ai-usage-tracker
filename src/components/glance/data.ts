import type { MetricLine, ProviderInstance, ProviderSnapshot } from "../../types/ipc";
import { displayName, selectOrderedInstances } from "../../lib/instance";
import { firstBalanceLine, primaryProgressLine } from "../../alerts/metric";
import { applyParams } from "../../i18n";

type Translate = (text: string) => string;

export type { Translate };

/** 单个配额窗口在速览面板中的形态 */
export interface GlanceWindowItem {
  label: string;
  percent: number;
  resetsAt?: string;
  primary: boolean;
}

/** 速览面板单实例的展示数据（新布局，与快速面板的卡片无共享） */
export interface GlanceInstance {
  id: string;
  label: string;
  status: ProviderSnapshot["status"] | "no_data";
  refreshing: boolean;
  alertActive: boolean;
  /** 主指标已用百分比；null = 金额量纲实例（如 DeepSeek 余额）或尚无数据 */
  primaryPercent: number | null;
  primaryLabel: string | null;
  primaryResetsAt?: string;
  /** 全部配额窗口（主指标在前置字段，其余按快照顺序） */
  windows: GlanceWindowItem[];
  /** 账户余额原文（如 ¥86.40） */
  balanceText: string | null;
}

export function buildGlanceInstances(
  instances: ProviderInstance[],
  snapshots: ProviderSnapshot[],
  options: {
    alertActive: Record<string, boolean>;
    refreshing: Record<string, boolean>;
    loading: boolean;
    translate: Translate;
  },
): GlanceInstance[] {
  const { alertActive, refreshing, loading, translate } = options;
  const lineLabel = (line: MetricLine) => applyParams(translate(line.label), line.params);
  return selectOrderedInstances(instances).map((instance) => {
    const snapshot = snapshots.find((item) => item.instanceId === instance.id) ?? null;
    const primary = snapshot ? primaryProgressLine(snapshot.lines) : null;
    const progressLines = (snapshot?.lines ?? []).filter(
      (line): line is MetricLine & { percentUsed: number } =>
        line.type === "progress" && typeof line.percentUsed === "number",
    );
    const balance = snapshot ? firstBalanceLine(snapshot.lines) : null;
    return {
      id: instance.id,
      label: displayName(instance, snapshot?.providerName ?? ""),
      status: snapshot ? snapshot.status : "no_data",
      refreshing: loading || refreshing[instance.id] === true,
      alertActive: alertActive[instance.id] ?? false,
      primaryPercent: primary?.percentUsed ?? null,
      primaryLabel: primary ? lineLabel(primary) : null,
      primaryResetsAt: primary?.resetsAt,
      windows: progressLines.map((line) => ({
        label: lineLabel(line),
        percent: line.percentUsed,
        resetsAt: line.resetsAt,
        primary: line === primary,
      })),
      balanceText: balance?.value ?? null,
    };
  });
}

/**
 * 主指标配色：任一活跃告警强制红；其余按固定档位（与托盘用量环一致）——
 * <70 品牌色、70–90 黄、≥90 红（ADR-0016）
 */
export function metricColor(percent: number | null, alertActive: boolean): string {
  if (alertActive) return "var(--danger)";
  if (percent === null) return "var(--fg-muted)";
  if (percent >= 90) return "var(--danger)";
  if (percent >= 70) return "var(--warning)";
  return "var(--brand)";
}

/** 实例状态点：ok 品牌色 / error 红 / needs_config 与无数据 灰 */
export function statusDotColor(status: GlanceInstance["status"]): string {
  if (status === "ok") return "var(--success)";
  if (status === "error") return "var(--danger)";
  return "var(--fg-muted)";
}
