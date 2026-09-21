/** 替换模板文案中的 {name} 占位符（与诊断文案的 {detail} 约定一致，中文模板同样适用）。
 *  独立纯模块：i18n/index 会经 useAppStore 牵起整个 store 图，告警评估等非 React、
 *  且处于 store 导入链上的模块不能从那里取纯函数，否则循环导入（ADR-0021 修复）。 */
export function applyParams(
  text: string,
  params: Record<string, string | number> | undefined,
): string {
  if (!params) return text;
  return Object.entries(params).reduce(
    (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
    text,
  );
}

/** 渲染模板 + 参数：字符串参数先经 t 翻译再替换（参数值本身可能是字典键，
 *  如告警标题里的规则名「余额告警」；供应商名等专名无字典键、t 原样返回）。
 *  告警文案模板化（ADR-0022）的统一渲染出口：通知中心与系统通知共用。 */
export function renderTemplate(
  text: string,
  params: Record<string, string | number> | undefined | null,
  t: (s: string) => string,
): string {
  const localized = params
    ? Object.fromEntries(
        Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? t(value) : value]),
      )
    : undefined;
  return applyParams(t(text), localized);
}

/** 快照指标行 value 的渲染出口（ADR-0022 通道的行内版）：value 是中文模板、
 *  valueParams 是实参；ISO 时刻串参数按界面语言格式化为短日期（9月22日 / Sep 22）。
 *  纯结构入参（不 import MetricLine，避免 store 导入链回环，同本文件头部注释） */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T/;

/** 到期日展示：zh 手工格式化（Node 的 zh-CN Intl 输出不稳定，实测给 "9/30"），
 *  en 用 Intl month:short（"Sep 30"） */
function formatExpiryDate(date: Date, language: "zh" | "en"): string {
  if (language === "en") {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function renderLineValue(
  line: { value?: string; valueParams?: Record<string, string | number> },
  t: (s: string) => string,
  language: "zh" | "en",
): string | undefined {
  if (line.value === undefined) return undefined;
  const params = line.valueParams
    ? Object.fromEntries(
        Object.entries(line.valueParams).map(([key, value]) => [
          key,
          typeof value === "string" && ISO_MOMENT.test(value)
            ? formatExpiryDate(new Date(value), language)
            : value,
        ]),
      )
    : undefined;
  return renderTemplate(line.value, params, t);
}
