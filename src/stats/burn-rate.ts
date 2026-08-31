import type { MetricPoint } from "./snapshot-history";

export type BurnRateResult =
  | { kind: "insufficient"; /** 距离可预测还差的估算小时数 */ hoursNeeded: number }
  | { kind: "stable" }
  | { kind: "at-target" }
  | { kind: "no-risk" }
  | {
      kind: "predict";
      /** 预计到达目标值的毫秒时间戳 */
      etaMs: number;
      hoursLeft: number;
      /** 每小时变化速率（deplete 为负、fill 为正） */
      ratePerHour: number;
    };

export interface BurnRateOptions {
  /** "deplete"：数值下降到 target 视为耗尽（余额）；"fill"：数值上升到 target 视为用满（额度） */
  mode: "deplete" | "fill";
  /** 目标值：deplete 默认 0，fill 默认 100 */
  target?: number;
  /** 额度重置时间（ISO）：fill 模式下预测超过该时间则本周期内不会用满 */
  resetsAt?: string;
  /** 拟合窗口（毫秒），默认 72 小时 */
  windowMs?: number;
  now?: number;
}

const MIN_POINTS = 6;
const MIN_SPAN_MS = 3_600_000;
/** R² 低于该值视为波动占主导，不做预测 */
const MIN_R2 = 0.5;
/**
 * 预测视野上限（小时）：超出即视为趋势无实际预测价值。
 * 同时保证 etaMs 落在 Date 可表示范围（±8.64e15 ms）内——
 * 72 小时窗口拟合出的微幅斜率外推可达 1e16 小时，new Date() 会得到 Invalid Date。
 */
const MAX_HORIZON_HOURS = 90 * 24;

/**
 * 耗尽预测：对最近窗口内的快照序列做最小二乘线性拟合，
 * 以消耗斜率外推到达目标值的时间。
 *
 * 边界守则（宁可不给预测也不瞎猜）：
 * - 样本 < 6 或时间跨度 < 1 小时 → insufficient
 * - R² 过低（波动占主导）或数值不在向目标移动 → stable
 * - 外推超出预测视野（含浮点噪声斜率算出的荒谬 ETA）→ stable
 * - 当前已越过目标 → at-target（卡片本身已展示现状，无需预测行）
 * - fill 模式下预计用满时间不早于重置时间 → no-risk
 */
export function analyzeBurnRate(
  points: MetricPoint[],
  options: BurnRateOptions,
): BurnRateResult {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 72 * 3_600_000;
  const windowStart = now - windowMs;
  const samples = points
    .filter((p) => Number.isFinite(p.v) && p.t >= windowStart && p.t <= now)
    .sort((a, b) => a.t - b.t);

  if (samples.length < MIN_POINTS) {
    return { kind: "insufficient", hoursNeeded: estimateHoursNeeded(samples, now) };
  }
  const span = samples[samples.length - 1].t - samples[0].t;
  if (span < MIN_SPAN_MS) {
    return {
      kind: "insufficient",
      hoursNeeded: Math.max(1, Math.ceil((MIN_SPAN_MS - span) / 3_600_000)),
    };
  }

  // 最小二乘：x = 距首点的小时数，y = 指标值
  const t0 = samples[0].t;
  const xs = samples.map((p) => (p.t - t0) / 3_600_000);
  const ys = samples.map((p) => p.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((acc, x, i) => acc + x * ys[i], 0);
  const sumXX = xs.reduce((acc, x) => acc + x * x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return { kind: "stable" };
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  // R²：1 - SSres / SStot
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i += 1) {
    const fitted = intercept + slope * xs[i];
    ssRes += (ys[i] - fitted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;

  const target = options.target ?? (options.mode === "fill" ? 100 : 0);
  const last = ys[n - 1];

  // 已越线：只显示现状，不展示预测行
  if (options.mode === "deplete" ? last <= target : last >= target) {
    return { kind: "at-target" };
  }

  const movingTowardTarget = options.mode === "deplete" ? slope < 0 : slope > 0;
  if (!movingTowardTarget || r2 < MIN_R2) {
    return { kind: "stable" };
  }

  const hoursLeft =
    options.mode === "deplete" ? (last - target) / -slope : (target - last) / slope;
  if (!Number.isFinite(hoursLeft) || hoursLeft <= 0 || hoursLeft > MAX_HORIZON_HOURS) {
    return { kind: "stable" };
  }

  const etaMs = now + hoursLeft * 3_600_000;
  if (options.mode === "fill" && options.resetsAt) {
    const resetMs = Date.parse(options.resetsAt);
    if (Number.isFinite(resetMs) && etaMs >= resetMs) {
      return { kind: "no-risk" };
    }
  }

  return { kind: "predict", etaMs, hoursLeft, ratePerHour: slope };
}

/** 估算距满足"至少 6 个点且跨度 ≥ 1 小时"还需的小时数 */
function estimateHoursNeeded(samples: MetricPoint[], now: number): number {
  if (samples.length < 2) {
    // 没有跨度可参考时按默认刷新间隔 5 分钟估一个点
    const needed = Math.max(0, MIN_POINTS - samples.length) * 5 * 60_000;
    return Math.max(1, Math.ceil(Math.max(needed, MIN_SPAN_MS) / 3_600_000));
  }
  const span = now - samples[0].t;
  const avgGap = span / (samples.length - 1);
  const pointsDeficitMs = Math.max(0, MIN_POINTS - samples.length) * avgGap;
  const spanDeficitMs = Math.max(0, MIN_SPAN_MS - span);
  return Math.max(1, Math.ceil(Math.max(pointsDeficitMs, spanDeficitMs) / 3_600_000));
}
