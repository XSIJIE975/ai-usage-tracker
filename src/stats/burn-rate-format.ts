import type { BurnRateResult } from "./burn-rate";
import type { Language } from "../i18n";

export interface BurnRateTextOptions {
  /** 界面语言：zh 中文（源语言）、en 英文 */
  locale?: Language;
  /** 预测模式：deplete=余额耗尽、fill=额度用满 */
  mode: "deplete" | "fill";
}

/**
 * 预测结果 → 用户可读文案；无需展示（at-target）返回 null。
 * 中英文模板集中在此处，后续接入 i18n 字典时替换。
 */
export function describeBurnRate(
  result: BurnRateResult,
  options: BurnRateTextOptions,
): string | null {
  const en = options.locale === "en";
  const noun =
    options.mode === "fill" ? (en ? "monthly quota" : "本月额度") : en ? "balance" : "余额";
  const verb = options.mode === "fill" ? (en ? "be used up" : "用完") : en ? "run out" : "耗尽";

  switch (result.kind) {
    case "insufficient": {
      const hours = Math.max(1, Math.round(result.hoursNeeded));
      return en
        ? `Collecting data — prediction available in about ${hours}h`
        : `数据积累中，约 ${hours} 小时后可预测`;
    }
    case "stable":
      return en
        ? "Steady usage recently — no exhaustion risk for now"
        : "近期消耗平稳，暂无耗尽风险";
    case "at-target":
      return null;
    case "no-risk":
      return en
        ? "At the current rate, this period's quota is enough"
        : "按当前速率，本周期内额度足够";
    case "predict": {
      const duration =
        result.hoursLeft >= 48
          ? en
            ? `about ${Math.round(result.hoursLeft / 24)} days`
            : `约 ${Math.round(result.hoursLeft / 24)} 天`
          : en
            ? `about ${Math.max(1, Math.round(result.hoursLeft))} hours`
            : `约 ${Math.max(1, Math.round(result.hoursLeft))} 小时`;
      const eta = new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(result.etaMs));
      return en
        ? `At the current rate, ${noun} will ${verb} in ${duration} (ETA ${eta})`
        : `按当前速率，${noun}${duration}后${verb}（预计 ${eta}）`;
    }
  }
}
