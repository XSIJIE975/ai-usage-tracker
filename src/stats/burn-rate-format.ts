import type { BurnRateResult } from "./burn-rate";

export interface BurnRateTextOptions {
  /** 指标名词：deplete 模式如「余额」、fill 模式如「本月额度」 */
  noun: string;
  /** 到达目标的动词：deplete 为「耗尽」、fill 为「用完」 */
  verb: string;
}

/**
 * 预测结果 → 用户可读文案；无需展示（at-target）返回 null。
 * 文案集中在此处，i18n 接入时只需替换本模块。
 */
export function describeBurnRate(
  result: BurnRateResult,
  options: BurnRateTextOptions,
): string | null {
  switch (result.kind) {
    case "insufficient":
      return `数据积累中，约 ${result.hoursNeeded} 小时后可预测`;
    case "stable":
      return "近期消耗平稳，暂无耗尽风险";
    case "at-target":
      return null;
    case "no-risk":
      return `按当前速率，本周期内${options.noun}足够`;
    case "predict": {
      const duration =
        result.hoursLeft >= 48
          ? `约 ${Math.round(result.hoursLeft / 24)} 天`
          : `约 ${Math.max(1, Math.round(result.hoursLeft))} 小时`;
      const eta = new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(result.etaMs));
      return `按当前速率，${options.noun}${duration}后${options.verb}（预计 ${eta}）`;
    }
  }
}
