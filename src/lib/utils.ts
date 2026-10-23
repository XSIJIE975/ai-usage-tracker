import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { applyParams } from "../i18n/apply-params";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** OpenCode 认的 Cookie 键：auth 覆盖旧页面与 /_server，__Host-console_session 覆盖新版控制台。 */
const OPENCODE_COOKIE_NAMES = ["auth", "__Host-auth", "__Host-console_session"] as const;

/** 与 Rust 侧 MAX_OPENCODE_COOKIE_HEADER_LENGTH 同口径，超长在表单阶段就拦下 */
export const MAX_OPENCODE_COOKIE_HEADER_LENGTH = 8_192;

/** 与 Rust 侧 instances::is_cookie_value_chars 同口径（RFC 6265 cookie-value）。 */
function isCookieValueChars(value: string): boolean {
  return [...value].every((char) => {
    const code = char.charCodeAt(0);
    return (
      char === "!" ||
      (code >= 0x23 && code <= 0x2b) ||
      (code >= 0x2d && code <= 0x3a) ||
      (code >= 0x3c && code <= 0x7e)
    );
  });
}

/**
 * 把用户粘贴的 OpenCode Cookie 输入归一化成可发送的 Cookie 头。
 * - 裸值（没有 `=`）：Iron Session 的 auth 值以 `Fe26.2` 开头，按 `auth=` 处理；
 *   其余（控制台会话 `st_…`）按 `__Host-console_session=` 处理；
 * - 整段 Cookie 头只保留 OpenCode 认的三个键，其余（分析/语言等）丢弃；
 * - 含换行、非法值字符、空值、超长或没有可识别键时返回空串，由表单校验拦下。
 */
export function normalizeOpenCodeAuthCookie(value: string): string {
  let cookie = value.trim();
  if (cookie.toLowerCase().startsWith("cookie:")) {
    cookie = cookie.slice("cookie:".length).trim();
  }
  if (!cookie || cookie.length > MAX_OPENCODE_COOKIE_HEADER_LENGTH || /[\r\n]/.test(cookie)) {
    return "";
  }
  // 裸值判定：没有 `=`，或 st_/Fe26.2 前缀且 `=` 只作为 base64 padding 出现在末尾。
  // 不能只按「有没有 =」判断——真实裸值可能带 `==` 填充。
  const firstEq = cookie.indexOf("=");
  const bareWithPadding =
    firstEq >= 0 &&
    !cookie.includes(";") &&
    (cookie.startsWith("Fe26.2") || cookie.startsWith("st_")) &&
    /^=+$/.test(cookie.slice(firstEq));
  if (firstEq < 0 || bareWithPadding) {
    if (!isCookieValueChars(cookie)) return "";
    const name = cookie.startsWith("Fe26.2") ? "auth" : "__Host-console_session";
    return `${name}=${cookie}`;
  }

  const parts: string[] = [];
  for (const part of cookie.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    const name = rawName?.trim();
    if (!name || rest.length === 0) continue;
    const canonical = OPENCODE_COOKIE_NAMES.find(
      (allowed) => allowed.toLowerCase() === name.toLowerCase(),
    );
    if (!canonical) continue;
    const cookieValue = rest.join("=").trim();
    // Rust 侧对空值直接报错；这里同样视为非法，避免「保存成功、请求必败」
    if (cookieValue === "" || !isCookieValueChars(cookieValue)) return "";
    if (!parts.some((item) => item.startsWith(`${canonical}=`))) {
      parts.push(`${canonical}=${cookieValue}`);
    }
  }
  return parts.join("; ");
}

/** 控制台接口（余额/请求日志）只认 __Host-console_session；旧版 auth 值可保存但不满足这条 */
export function hasOpenCodeConsoleSession(value: string): boolean {
  if (!value || /[\r\n]/.test(value)) return false;
  return value.split(";").some((part) => {
    const [rawName, ...rest] = part.trim().split("=");
    const name = rawName?.trim().toLowerCase();
    const cookieValue = rest.join("=").trim();
    return (
      name === "__host-console_session" &&
      cookieValue !== "" &&
      isCookieValueChars(cookieValue)
    );
  });
}

/**
 * 表单校验：至少包含一个 OpenCode 认的 Cookie 键。
 * 不强制 __Host-console_session——旧实例的 auth Cookie 仍要能保存（补 API Key），
 * 余额/日志需要控制台会话时由 hasOpenCodeConsoleSession 单独给出提示。
 */
export function isValidOpenCodeCookieHeader(value: string): boolean {
  if (
    !value ||
    value.length > MAX_OPENCODE_COOKIE_HEADER_LENGTH ||
    /[\r\n]/.test(value)
  ) {
    return false;
  }
  let found = false;
  for (const part of value.split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    const name = rawName?.trim().toLowerCase();
    const recognized = OPENCODE_COOKIE_NAMES.some(
      (allowed) => allowed.toLowerCase() === name,
    );
    if (!recognized) continue;
    const cookieValue = rest.join("=").trim();
    // 与 Rust 一致：任一可识别键为空/非法即整条非法，而不是「有一个好的就放行」
    if (cookieValue === "" || !isCookieValueChars(cookieValue)) return false;
    found = true;
  }
  return found;
}

/** 小时数标签（刷新间隔与告警冷却预设共用）：整串模板，英文用缩写单位 */
export function formatHoursLabel(hours: number | string, translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  return applyParams(t("{hours} 小时"), { hours });
}

/** HTML 转义。ECharts 的 tooltip 在默认 html 渲染下走 `innerHTML`（不转义），
 *  而系列名/分类名可能直接来自供应商接口响应（如 Qoder 的 operation、model_category），
 *  拼 HTML 串之前必须过这一层。`p.marker` 是 ECharts 自己生成的小圆点 HTML，保持原样。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatRefreshLabel(minutes: number, translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  if (minutes < 1) return t("已禁用");
  if (minutes < 60) return applyParams(t("{minutes} 分钟"), { minutes });
  const hours = minutes / 60;
  return formatHoursLabel(hours % 1 === 0 ? hours : hours.toFixed(1), translate);
}

/**
 * 本地日历日偏移：入参可为任意时刻或毫秒，返回「它所在的那一天 + n 天」的本地零点毫秒。
 * 刻意用 `Date(y, m, d + n)` 而不是 `± n × 86400000` —— 定毫秒步长在跨夏令时的时区里
 * 每次漂一小时，攒够一天就会重复或漏掉某个日期标签（本机 CST 无夏令时，测不出来）。
 */
export function dayOffsetMs(base: Date | number, n: number): number {
  const date = typeof base === "number" ? new Date(base) : new Date(base.getTime());
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n).getTime();
}

/** 两个本地零点之间的整天数（四舍五入掉夏令时的 ±1 小时） */
export function daySpan(fromMs: number, toMs: number): number {
  return Math.round((toMs - fromMs) / 86_400_000);
}

export function formatClock(ts: number | string | null | undefined) {
  if (!ts) return "暂无数据";
  const date = typeof ts === "string" ? new Date(ts) : new Date(ts);
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

/** 紧凑数字格式：1234 → 1,234；1520704 → 1.5M（图表轴与统计卡使用） */
export function formatCompact(value: number) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(value));
}

/** 千分位整数：152704 → 152,704 */
export function formatInt(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

/**
 * 图表格式化器兜底（数字原样转字符串）。必须是模块级稳定引用：
 * 写成组件参数默认值 `format = (v) => String(v)` 时每次渲染都是新函数身份，
 * 会穿透图表 option 的 useMemo，让 echarts-for-react 每渲染 setOption(notMerge) 重建图形。
 */
export const formatPlain = (value: number) => String(value);

/** 字节数可读化：1536 → 1.5 KB；5242880 → 5 MB */
export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let scaled = value;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  const text = index === 0 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
  return `${text} ${units[index]}`;
}

/** 重置时刻的绝对时间显示（M/D HH:mm，en 为 12 小时制），无效输入返回占位符 */
export function formatResetAt(iso: string, language: "zh" | "en" = "zh"): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat(language === "en" ? "en-US" : "zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: language === "en",
  }).format(date);
}

/** 相对口径的重置倒计时。整串模板而不是「数字 + 单位 + 后缀」逐词拼接——英文有单复数
 *  （1 day / 2 days），拼出来的句子无法正确变形；英文侧用缩写单位（d/h/min），
 *  顺带适配速览面板 320px 的窄行 */
export function formatReset(iso?: string | null, now = Date.now(), translate?: (s: string) => string) {
  const t = translate ?? ((s: string) => s);
  if (!iso) return t("重置时间未知");
  const diff = new Date(iso).getTime() - now;
  if (!Number.isFinite(diff)) return t("重置时间未知");
  if (diff <= 0) return t("即将重置");
  const totalMinutes = Math.max(1, Math.floor(diff / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return hours > 0
      ? applyParams(t("{days} 天 {hours} 小时后重置"), { days, hours })
      : applyParams(t("{days} 天后重置"), { days });
  }
  if (hours > 0) {
    return minutes > 0
      ? applyParams(t("{hours} 小时 {minutes} 分钟后重置"), { hours, minutes })
      : applyParams(t("{hours} 小时后重置"), { hours });
  }
  return applyParams(t("{minutes} 分钟后重置"), { minutes });
}

/** 已用百分比的整数展示口径：100 只留给真实的 100%。
 *  四舍五入会把 99.5% 抬成 100%，在速览里看起来像已经耗尽（额度耗尽告警却还没触发）；
 *  进度弧/条与颜色档位仍按原始值绘制，只有文字读数被钳住 */
export function displayPercentInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value >= 100) return 100;
  return Math.min(99, Math.max(0, Math.round(value)));
}

/** 主卡片一位小数口径的同一条边界：未满 100 最多 99.9，只有真实 100% 显示 100.0 */
export function displayPercentDecimal(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  if (value >= 100) return "100.0";
  return Math.min(99.9, Math.max(0, value)).toFixed(1);
}

/** 重置时间的统一渲染出口：相对倒计时 / 绝对时刻按全局偏好二选一。
 *  主卡片的可点击重置格与速览的只读重置后缀共用，避免两处各写一套模板 */
export function formatResetDisplay(
  iso: string | null | undefined,
  options: {
    now?: number;
    language?: "zh" | "en";
    translate?: (s: string) => string;
    display?: "relative" | "absolute";
  } = {},
): string | null {
  if (!iso) return null;
  const t = options.translate ?? ((s: string) => s);
  if (options.display === "absolute") {
    return applyParams(t("{time} 重置"), {
      time: formatResetAt(iso, options.language ?? "zh"),
    });
  }
  return formatReset(iso, options.now, t);
}
