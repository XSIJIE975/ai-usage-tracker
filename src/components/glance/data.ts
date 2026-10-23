import type { MetricLine, ProviderInstance, ProviderKind, ProviderSite, ProviderSnapshot } from "../../types/ipc";
import { displayName, selectOrderedInstances } from "../../lib/instance";
import { applyParams, renderLineValue } from "../../i18n";
import type { Language } from "../../i18n/translate";

type Translate = (text: string) => string;

export type { Translate };

/** 速览的窗口行：百分比一律是已用口径；重置时刻只属于这一扇窗 */
export interface GlanceWindowLine {
  kind: "window";
  label: string;
  percent: number;
  resetsAt?: string;
  /** 最紧窗口（已用最高；平手取重置更近者）。行列表用它当大号读数，不再重复一行 */
  tightest: boolean;
}

/** 速览的说明行：余额 / 到期明细 / 非正常状态。三者都由快照行上的结构化标记选出，
 *  不按文案猜测；未标记的文本行（连登、旅行、充值明细、其余套餐）不进速览 */
export interface GlanceTextLine {
  kind: "balance" | "detail" | "status";
  label: string;
  value: string;
  color?: string;
}

export type GlanceLine = GlanceWindowLine | GlanceTextLine;

/** 速览面板单实例的展示数据（与快速面板的卡片无共享） */
export interface GlanceInstance {
  id: string;
  /** 供应商类型，用于取官方标识（ProviderKind 是封闭联合，六家都有现成 logo） */
  providerId: ProviderKind;
  /** 实例站点，多站供应商的徽标要用（ADR-0031） */
  site: ProviderSite;
  label: string;
  status: ProviderSnapshot["status"] | "no_data";
  refreshing: boolean;
  alertActive: boolean;
  /** 最紧窗口已用百分比；null = 没有进度行（余额型/状态型实例） */
  tightestPercent: number | null;
  /** 最紧窗口的标签，行列表的大号读数用；卡片环不显示标签，靠行里的读数对应 */
  tightestLabel: string | null;
  /** 最紧窗口的重置时刻 */
  tightestResetsAt?: string;
  /** 按快照顺序的展示行（窗口/余额/明细/状态）；两种形态共用同一份 */
  lines: GlanceLine[];
}

export function buildGlanceInstances(
  instances: ProviderInstance[],
  snapshots: ProviderSnapshot[],
  options: {
    alertActive: Record<string, boolean>;
    refreshing: Record<string, boolean>;
    loading: boolean;
    translate: Translate;
    /** 界面语言：余额/到期 value 里的 ISO 日期参数按语言格式化 */
    language: Language;
  },
): GlanceInstance[] {
  const { alertActive, refreshing, loading, translate, language } = options;
  return selectOrderedInstances(instances).map((instance) => {
    const snapshot = snapshots.find((item) => item.instanceId === instance.id) ?? null;
    const lines = snapshot ? buildLines(snapshot.lines, translate, language) : [];
    const tightest = pickTightest(lines.filter(isWindowLine));
    if (tightest) tightest.tightest = true;
    return {
      id: instance.id,
      providerId: instance.providerId,
      site: instance.site,
      label: displayName(instance, snapshot ? translate(snapshot.providerName) : ""),
      status: snapshot ? snapshot.status : "no_data",
      refreshing: loading || refreshing[instance.id] === true,
      alertActive: alertActive[instance.id] ?? false,
      tightestPercent: tightest?.percent ?? null,
      tightestLabel: tightest?.label ?? null,
      tightestResetsAt: tightest?.resetsAt,
      lines,
    };
  });
}

function isWindowLine(line: GlanceLine): line is GlanceWindowLine {
  return line.kind === "window";
}

/**
 * 把快照行翻译成速览行。只收四类：
 * - 进度行 → 窗口行（已用百分比）
 * - balance 标记 → 余额行（显示供应商自己的称呼：账户余额 / Zen 余额 / 剩余积分）
 * - status 标记 → 状态行（未订阅/已过期/未分配/暂无套餐/不可用）
 * - detail 标记 → 明细行（资源包/套餐的余量与到期）
 * 其余文本行不渲染——速览是额度摘要，不承载连登、旅行、充值拆分等分项。
 */
function buildLines(lines: MetricLine[], translate: Translate, language: Language): GlanceLine[] {
  const result: GlanceLine[] = [];
  for (const line of lines) {
    const label = applyParams(translate(line.label), line.params);
    const value = renderLineValue(line, translate, language);
    if (line.type === "progress" && typeof line.percentUsed === "number") {
      result.push({
        kind: "window",
        label,
        percent: line.percentUsed,
        ...(line.resetsAt ? { resetsAt: line.resetsAt } : {}),
        tightest: false,
      });
      // 兼容升级前的落库快照：那时 WorkBuddy/Qoder 把余额寄在进度行的 value 上。
      // 新快照余额是独立行；旧形态统一用「剩余积分」兜底（旧行的订阅/积分额度标签
      // 不是余额的名字），避免把跨池合计读成某一行自己的余量
      if (line.balance && value !== undefined) {
        result.push({ kind: "balance", label: translate("剩余积分"), value });
      }
      continue;
    }
    if (value === undefined) continue;
    if (line.balance) {
      result.push({ kind: "balance", label, value, ...(line.color ? { color: line.color } : {}) });
    } else if (line.status) {
      result.push({ kind: "status", label, value, ...(line.color ? { color: line.color } : {}) });
    } else if (line.detail) {
      result.push({ kind: "detail", label, value, ...(line.color ? { color: line.color } : {}) });
    }
  }
  return result;
}

/**
 * 最紧窗口：已用百分比最高的一扇；平手取重置更近者（与托盘 badge 的「离撞限额还有多远」
 * 同义，ADR-0020）。与告警用的主指标（重置周期最长窗）是两个口径——告警盯预算窗，
 * 速览环回答当下最危险的是哪一扇。
 */
function pickTightest(windows: GlanceWindowLine[]): GlanceWindowLine | null {
  let best: GlanceWindowLine | null = null;
  for (const window of windows) {
    if (!best) {
      best = window;
      continue;
    }
    if (window.percent > best.percent) {
      best = window;
      continue;
    }
    if (window.percent === best.percent && resetDistance(window.resetsAt) < resetDistance(best.resetsAt)) {
      best = window;
    }
  }
  return best;
}

function resetDistance(iso?: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
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
  if (status === "error") return "var(--danger)";
  if (status === "needs_config") return "var(--fg-muted)";
  return "var(--success)";
}
