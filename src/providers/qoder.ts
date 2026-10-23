import { invoke } from "@tauri-apps/api/core";
import type {
  HttpResult,
  InstanceCredentialStatus,
  InstanceCredentials,
  MetricLine,
  ProviderInstance,
  ProviderSite,
  ProviderSnapshot,
} from "../types/ipc";
import type { ProviderModule } from "./types";
import { formatInt } from "../lib/utils";

// 端点与请求形态依据社区先例 CodexBar（steipete/CodexBar：docs/qoder.md 与实现
// Sources/CodexBarCore/Resources/Plugins/qoder.js，2026-09-24 逐行核对；非公开 web 接口、
// 随官方改版需跟随维护，接入边界见 ADR-0030）：
// - 唯一数据源：GET /api/v2/me/usages/big_model_credits（账号控制台大模型积分汇总）。
//   一个端点里读四个配额容器（三个分容器出行 + total_quota 汇总位当实例级余量），明细行
//   读 resource_package_quota.quota_detail 的到期时刻。本期仍只读它，故无统计页——但
//   「没有历史端点」这个说法已被证伪：官网用量页自己就有每日消耗热力图、按天/周/月趋势与
//   「Credits 记录」列表，只是端点没去侦察（ADR-0030）
// - 双登录域：国际站 qoder.com 与中国站 qoder.com.cn，Cookie 不互通；站点是实例的
//   显式属性（不从粘贴内容判站）
// - 凭据是单个网页 Cookie 的值：真机验证只需 qoder_session_cookie 这一对（2026-09-23），
//   所以凭据槽存的是它的**值**原文，键名与 Cookie 头由 Rust 端 qoder_cookie 通道拼；
//   前端不加工输入，合法性只在前端保存/探测前用字符集白名单把关（RFC 6265 cookie-value，
//   顺带挡住「贴整段 Cookie 头」和连键名一起贴）。UA 缺省按本机平台生成 Chrome 常量
//   ——Qoder 网关不绑定登录时 UA，与 WorkBuddy 的三元组同源校验截然不同；
//   Origin/Referer/Bx-V 是静态协议头，随端点定义在这里
// - 响应支持 camelCase 与 snake_case 两套键名（CodexBar 解码器同款双兼容）

const PROVIDER_NAME = "Qoder";

/** 凭据槽（qoder 实例存的会话 Cookie 值，见 SESSION_COOKIE_NAME） */
export const CREDENTIAL_SLOT = "cookie";

/** 扫码通道写入的槽位全集（ADR-0041）：退出扫码登录、或净切回 Cookie 登录时一并清除。
 *  与 Rust 侧 qoder_qr_claim 清 `cookie` 槽是对称的两半——互斥不变量（ADR-0035） */
export const QODER_TOKEN_SLOTS = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "uid",
  "nickname",
] as const;

/** 登录态所在的 Cookie 名：界面上告诉用户取哪个键，取数时由 Rust 端拼成
 *  `Cookie: qoder_session_cookie=<值>`（凭据头只由鉴权分支注入，ADR-0030 §2） */
export const SESSION_COOKIE_NAME = "qoder_session_cookie";

/** 单个 Cookie 值的字符集（RFC 6265 cookie-value：可见 ASCII，排除空白、`"`、`,`、`;`）。
 *  与 Rust 端 `instances::validate_cookie_value`、WorkBuddy 的同名校验逐字符一致——三处
 *  任一处收紧都会误伤真机凭据 */
const COOKIE_VALUE_CHARS = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x7e]+$/;

/**
 * Qoder 凭据输入合法性：只接受会话 Cookie 的**值**（键名与 Cookie 头由 Rust 拼）。
 * 拒三类误输入——`Cookie:` 前缀（那是请求头名）、连 `qoder_session_cookie=` 键名一起贴、
 * 以及超出 cookie-value 字符集的内容（整段 Cookie 头必带 `;` 与空格，落在这里）。
 * 只判定不加工：存进去的就是用户贴的那段值（ADR-0030 §2）
 */
export function isValidSessionCookieValue(value: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  if (lower.startsWith("cookie:")) return false;
  if (lower.startsWith(`${SESSION_COOKIE_NAME}=`)) return false;
  return COOKIE_VALUE_CHARS.test(value);
}

/** 站点档案：端点与 Origin/Referer 都按站取（ADR-0031）。
 *  统计页用的三个端点与汇总端点同域同鉴权，一并记在这里（契约见 ADR-0030 的侦察记录） */
interface SiteConfig {
  origin: string;
  usageUrl: string;
  /** 身份端点：只为拿 `id`（热力图要 userId 入参），响应里的 name/email/avatar 一律不取 */
  meUrl: string;
  /** 逐条消耗明细（统计页数据源） */
  historiesUrl: string;
  /** 近一年每日 Credits 消耗分布（官方给好分档阈值） */
  heatmapUrl: string;
  /** 扫码 token 通道的用量端点（ADR-0041）：与 web 域不同源，走各站的 openapi */
  deviceUsageUrl: string;
}

const SITES: Record<ProviderSite, SiteConfig> = {
  china: {
    origin: "https://qoder.com.cn",
    usageUrl: "https://qoder.com.cn/api/v2/me/usages/big_model_credits",
    meUrl: "https://qoder.com.cn/api/v1/me",
    historiesUrl: "https://qoder.com.cn/api/v1/me/usages/big_model_credits/histories",
    heatmapUrl: "https://qoder.com.cn/api/v1/me/ai-conversations/credits-heatmap",
    deviceUsageUrl: "https://openapi.qoder.com.cn/sash/api/v2/me/usage",
  },
  international: {
    origin: "https://qoder.com",
    usageUrl: "https://qoder.com/api/v2/me/usages/big_model_credits",
    meUrl: "https://qoder.com/api/v1/me",
    historiesUrl: "https://qoder.com/api/v1/me/usages/big_model_credits/histories",
    heatmapUrl: "https://qoder.com/api/v1/me/ai-conversations/credits-heatmap",
    deviceUsageUrl: "https://openapi.qoder.sh/sash/api/v2/me/usage",
  },
};

/** 站点档案（统计页取端点用；凭据通道与请求头与卡片完全相同） */
export function qoderSiteConfig(site: ProviderSite): SiteConfig {
  return SITES[site];
}

/** 凭据缺失与失效的两句话在卡片与统计页共用，避免两处口径漂移 */
export const CREDENTIAL_MISSING_MESSAGE =
  "请在设置中粘贴 Qoder 会话 Cookie（qoder_session_cookie）的值";
export const CREDENTIAL_EXPIRED_MESSAGE =
  "Qoder 登录凭据无效或已过期，请在设置中重新粘贴 qoder_session_cookie 的值";

/** 实例的取数站点：site 缺失/未知值回退中国站（中文环境默认） */
export function qoderSiteOf(instance: Pick<ProviderInstance, "site">): ProviderSite {
  return instance.site === "international" ? "international" : "china";
}

export function qoderUsageUrl(site: ProviderSite): string {
  return SITES[site].usageUrl;
}

/** 用量接口的静态协议头：Origin/Referer 随站点切换，Bx-V 是 Qoder 网关
 *  （Baxia 风控）的版本头，写死 CodexBar 实证可用的 2.5.35，风控升级时跟随更新 */
export function qoderUsageHeaders(site: ProviderSite): Record<string, string> {
  const origin = SITES[site].origin;
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: origin,
    Referer: `${origin}/account/usage`,
    "X-Requested-With": "XMLHttpRequest",
    "Bx-V": "2.5.35",
  };
}

interface QuotaSummaryRaw {
  usedValue?: unknown;
  used_value?: unknown;
  limitValue?: unknown;
  limit_value?: unknown;
  remainingValue?: unknown;
  remaining_value?: unknown;
}

/** `quota_detail` 里我方读的键：这一笔还剩多少、什么时候到期。
 *  真机没有明细时这个键是 **null**（不是空数组，体验版即如此） */
interface QuotaDetailRaw {
  remainingValue?: unknown;
  remaining_value?: unknown;
  expiresAt?: unknown;
  expires_at?: unknown;
}

interface QuotaContainerRaw {
  quotaSummary?: QuotaSummaryRaw;
  quota_summary?: QuotaSummaryRaw;
  quotaDetail?: QuotaDetailRaw[] | null;
  quota_detail?: QuotaDetailRaw[] | null;
}

/** 配额容器一共四个：三个分容器 + 一个汇总位。真机样本的键名混用两套——容器是 snake_case
 *  （`total_quota`）、两个重置时刻是 camelCase（`nextResetAt`），故两套都留。
 *  **没有 shared_quota**：CodexBar 插件读的那个键在真机两个站点都不存在，而两份样本对账
 *  证明 total_quota 就是 plan + 资源包 + 专属资源包的汇总位（2000+1200=3200、2000+534=2534、
 *  0+666=666），再叠一次是重复计数，故不实现（ADR-0030 §4）。
 *  分容器现在要读：合并成单一百分比窗口会吞掉「订阅见底、靠赠送包撑」这个信号（ADR-0030） */
export interface QoderUsageData {
  planQuota?: QuotaContainerRaw;
  plan_quota?: QuotaContainerRaw;
  resourcePackageQuota?: QuotaContainerRaw;
  resource_package_quota?: QuotaContainerRaw;
  dedicatedResourcePackageQuota?: QuotaContainerRaw;
  dedicated_resource_package_quota?: QuotaContainerRaw;
  totalQuota?: QuotaContainerRaw;
  total_quota?: QuotaContainerRaw;
  nextResetAt?: unknown;
  next_reset_at?: unknown;
}

export interface QoderQuotaSummary {
  usedValue: number;
  limitValue: number;
  /** 接口可能不下发余量（用 limit−used 推） */
  remainingValue: number | null;
}

/** 解析单份配额摘要：used/limit 必填（数值），缺失即整体无效（null）。
 *  接口同款的 usagePercentage/unit 字段刻意不入模型——百分比一律由 used/total 算 */
export function parseQuotaSummary(raw: QuotaSummaryRaw | undefined): QoderQuotaSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const used = toCount(raw.usedValue ?? raw.used_value);
  const limit = toCount(raw.limitValue ?? raw.limit_value);
  if (used == null || limit == null) return null;
  return {
    usedValue: used,
    limitValue: limit,
    remainingValue: toCount(raw.remainingValue ?? raw.remaining_value),
  };
}

/** 数值字段统一转数值；负数与 NaN 视为缺失（脏数据按 CodexBar 口径整体拒收，
 *  由调用方回落解析失败） */
function toCount(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

/** 配额容器键，同时决定卡片上的行名与顺序 */
export type QoderQuotaKey = "plan" | "package" | "dedicated";

/** 一个配额窗口（= 响应里的一个分容器） */
export interface QoderQuotaWindow {
  key: QoderQuotaKey;
  used: number;
  total: number;
  remaining: number;
  /** 已用百分比（0~100），一律本地按 used/total 算 */
  percent: number;
  /** 订阅周期的刷新时刻（只有 plan 会有） */
  resetsAt: Date | null;
  /** 池子里还有余量的那些包中最早到期的时刻（只有资源包类容器会有） */
  earliestExpiry: Date | null;
}

export interface QoderUsageView {
  /** 有分配的容器（恒零的剔掉了），顺序固定 plan → package → dedicated */
  windows: QoderQuotaWindow[];
  /** `total_quota` 汇总位：速览余额位与「响应没给分容器」时的退路都取它 */
  aggregate: { used: number; total: number; remaining: number; percent: number };
  resetsAt: Date | null;
}
/** 重置时刻：ISO 串或 epoch（秒/毫秒自适应，CodexBar 解码器同款）；解析不出返回 null */
export function parseNextReset(raw: unknown): Date | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const date = new Date(raw > 10_000_000_000 ? raw : raw * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === "string" && raw.trim()) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms) : null;
  }
  return null;
}

/** 摘要 → 用量三元组：余量缺失按 max(0, limit−used) 推 */
function readQuota(quota: QoderQuotaSummary): { used: number; total: number; remaining: number } {
  return {
    used: quota.usedValue,
    total: quota.limitValue,
    remaining: quota.remainingValue ?? Math.max(0, quota.limitValue - quota.usedValue),
  };
}

/** 分容器的读取顺序（卡片行序按这个走，与用量大小无关，避免行位每天换人） */
function quotaContainers(data: QoderUsageData): Array<{ key: QoderQuotaKey; container: QuotaContainerRaw }> {
  const pairs: Array<[QoderQuotaKey, QuotaContainerRaw | undefined]> = [
    ["plan", data.planQuota ?? data.plan_quota],
    ["package", data.resourcePackageQuota ?? data.resource_package_quota],
    ["dedicated", data.dedicatedResourcePackageQuota ?? data.dedicated_resource_package_quota],
  ];
  return pairs
    .filter((pair): pair is [QoderQuotaKey, QuotaContainerRaw] => !!pair[1])
    .map(([key, container]) => ({ key, container }));
}

/** 池子里还活着的那些包中最早到期的时刻。**只看还有余量的包**：已耗尽那笔的到期日
 *  不代表剩下的点数什么时候没（真机样本里 9-30 到期的那包已经用光，余量全在 10-18 那包里，
 *  不过滤就显示成「最早 9/30 到期」，等于谎报） */
function earliestActiveExpiry(container: QuotaContainerRaw): Date | null {
  const detail = container.quotaDetail ?? container.quota_detail;
  if (!Array.isArray(detail)) return null; // 真机没明细时这个键是 null
  let earliest: Date | null = null;
  for (const entry of detail) {
    const remaining = toCount(entry?.remainingValue ?? entry?.remaining_value);
    if (!remaining) continue;
    const expiry = parseNextReset(entry?.expiresAt ?? entry?.expires_at);
    if (expiry && (!earliest || expiry < earliest)) earliest = expiry;
  }
  return earliest;
}

/**
 * 汇总与分容器解析（ADR-0030）。`total_quota` 是 plan + 资源包 + 专属资源包的汇总位，
 * 两份真机样本对账证实（2000+1200=3200、2000+534=2534、0+666=666）；它单独撑着速览的
 * 实例级余量，而三个分容器决定卡片出几行——合并成一行会把「订阅见底、靠赠送包撑」这个
 * 信号算没了（付费样本合并后 79.19%，耗尽与阈值双双不响）。
 *
 * 百分比一律本地按 used/total 计算（汇总位与各分容器同一条规则），不取下发的
 * usage_percentage：中国站付费样本（__fixtures__/qoder-usage-china.json）证实它是 0~100 的
 * **向上取整**整数——2534/3200=79.19 下发 80，明细里 34/100 下发 35。用它就是把精度丢掉。
 * CodexBar 插件相反：它优先信下发值，只在有 shared 容器时才本地算，所以体验版（无 shared、
 * 下发 0）它显示 0% 而非 100%——那个「零总量=100」只是它 shared 分支的兜底，我方首版把它
 * 当成了通用口径（见 ADR-0030 §3）。结构不完整返回 null（解析失败）。
 *
 * 零总量（total=0 且 used=0）是「这个套餐没分配积分」（样本即如此），不是「用满等重置」——
 * 真用满时接口回的是 used=limit>0（付费样本的 plan 就是 2000/2000），百分比自然算到 100，
 * 无需伪造。恒零的分容器同样不出行（没分配就没窗口可画），全零时展示口径由 parseUsageLines
 * 判为中性事实行。
 *
 * 重置时刻只认未来的：体验版样本里 nextResetAt=1767708936459（2026-01-06 22:15 CST）相对
 * 当天已是八个月前，和 lastResetAt 一起算出个 14 天周期停在原地——未分配积分的账号周期是
 * 冻结的。照挂就是卡片上永远显示「1/6 22:15 重置」、切到相对口径更是「即将重置」，两句都是
 * 假话。（付费样本这一项正常：1790382507566 = 2026-09-26 08:28:27 CST，与官网「将于 2026年
 * 9月26日 08:28:27 刷新配额」逐字对得上。）
 */
export function parseUsageView(data: QoderUsageData | undefined, now = Date.now()): QoderUsageView | null {
  if (!data || typeof data !== "object") return null;
  const totalContainer = data.totalQuota ?? data.total_quota;
  const declared = totalContainer?.quotaSummary ?? totalContainer?.quota_summary;
  const quota = parseQuotaSummary(declared);
  if (!quota) return null;
  const aggregate = readQuota(quota);
  // 零总量却还有用量或余量：矛盾数据，整体拒收（CodexBar 插件同一条判定）
  if (aggregate.total <= 0 && (aggregate.used > 0 || aggregate.remaining > 0)) return null;
  const rawReset = parseNextReset(data.nextResetAt ?? data.next_reset_at);
  const resetsAt = aggregate.total > 0 && rawReset && rawReset.getTime() > now ? rawReset : null;

  const windows: QoderQuotaWindow[] = [];
  for (const container of quotaContainers(data)) {
    const summary = container.container.quotaSummary ?? container.container.quota_summary;
    // 容器在但没声明摘要：按"这份响应没给这个窗口"处理，比猜一个零更安全
    if (!summary || typeof summary !== "object") continue;
    const parsed = parseQuotaSummary(summary);
    // 声明了却读不出不能当"没分配"——那会把有额度的号读成零额度（ADR-0024 错误可见）
    if (!parsed) return null;
    const window = readQuota(parsed);
    if (window.total <= 0 && (window.used > 0 || window.remaining > 0)) return null;
    // 恒零容器不出行：没分配就没窗口可画（与体验版整号零分配走中性行是同一条口径）
    if (window.total <= 0 && window.used <= 0) continue;
    windows.push({
      key: container.key,
      ...window,
      percent: (window.used / window.total) * 100,
      // 全响应只有一个 nextResetAt，它是**订阅**周期的刷新时刻；资源包各按自己的 expires_at
      // 到期，挂到这里会被读成"这批点数在这个时刻重置"
      resetsAt: container.key === "plan" ? resetsAt : null,
      earliestExpiry: container.key === "plan" ? null : earliestActiveExpiry(container.container),
    });
  }
  return {
    windows,
    aggregate: {
      ...aggregate,
      percent: aggregate.total > 0 ? (aggregate.used / aggregate.total) * 100 : 0,
    },
    resetsAt,
  };
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** 行名（同时也是「额度耗尽」告警正文里的窗名，见 evaluate.ts 的 exhausted 规则） */
const WINDOW_LABELS: Record<QoderQuotaKey, string> = {
  plan: "订阅积分",
  package: "资源包积分",
  dedicated: "专属资源包",
};

/** 池子的明细行标签：这两类额度过期就作废，值得单独报「还剩多少、最早哪天没」 */
const POOL_LABELS: Partial<Record<QoderQuotaKey, string>> = {
  package: "资源包",
  dedicated: "专属资源包",
};

/**
 * 卡片指标行：一个有分配的容器一行进度（GLM / OpenCode Go 同款多窗口形态）。
 *
 * 三条刻意选择：
 * 1. **只有订阅行带 `resetsAt`** —— primaryProgressLine 取重置最远的一行当主指标，资源包行不带，
 *    阈值告警才盯在订阅配额上（而不是那批慢慢消耗的赠送包）。这条是隐式的，靠
 *    `qoder.test.ts` 的「keeps the reset moment on the subscription line only」守住。
 * 2. **`balance` 只挂第一条进度行，值是实例级总余量**（`total_quota` 汇总位）—— 速览的余额位
 *    取第一个 balance 标记行，逐行挂会变成「订阅剩 0」盖掉真余量。载体行与数值不同口径是
 *    事实，别改成 window.remaining。
 * 3. **到期走 text 明细行，不占用 `resetsAt`** —— 卡片进度分支那一格写死是「{time} 重置」，
 *    把到期时刻挂上去就是一句假话；text 行的 value 模板带 ISO 参数由渲染端按语言格式化
 *    （WorkBuddy 套餐明细同款，见 workbuddy.ts 的 parseResourceLines）。
 */
export function parseUsageLines(view: QoderUsageView): MetricLine[] {
  if (view.windows.length === 0) {
    if (view.aggregate.total <= 0) {
      // 未分配积分（体验版）走状态行，与 WorkBuddy 无套餐同法（workbuddy.ts:284）：
      // 不出进度行，红条、已用 100%、重置倒计时、耗尽告警与托盘满环就都无从产生
      return [{ type: "text", label: "积分额度", value: "未分配积分", status: true }];
    }
    // 响应没给分容器（只回 total_quota）：不拆窗也不编造窗口，退回收汇总单行
    const merged: MetricLine = {
      type: "progress",
      label: "积分额度",
      used: view.aggregate.used,
      limit: view.aggregate.total,
      percentUsed: clampPercent(view.aggregate.percent),
    };
    if (view.resetsAt) merged.resetsAt = view.resetsAt.toISOString();
    return [
      merged,
      {
        type: "text",
        label: "剩余积分",
        value: formatInt(view.aggregate.remaining),
        balance: true,
      },
    ];
  }

  const lines: MetricLine[] = [];
  for (const window of view.windows) {
    const line: MetricLine = {
      type: "progress",
      label: WINDOW_LABELS[window.key],
      used: window.used,
      limit: window.total,
      percentUsed: clampPercent(window.percent),
    };
    if (window.resetsAt) line.resetsAt = window.resetsAt.toISOString();
    lines.push(line);

    const pool = POOL_LABELS[window.key];
    if (!pool || window.remaining <= 0) continue;
    const remain = { remain: formatInt(window.remaining) };
    lines.push(
      window.earliestExpiry
        ? {
            type: "text",
            label: pool,
            value: "余 {remain} · {expiresAt}到期",
            valueParams: { ...remain, expiresAt: window.earliestExpiry.toISOString() },
            detail: true,
          }
        : { type: "text", label: pool, value: "余 {remain}", valueParams: remain, detail: true },
    );
  }
  // 余额独立成行（速览余额位按 balance 标记选行），不再挂在第一条进度行上：
  // - 多池：跨池合计，回答「总共还剩多少」；
  // - 单池是订阅积分（没有池明细行）：合计就是它自己的余量，照出；
  // - 单池是资源包/专属包且还有余量：上面的池明细已经报了同一个数，省掉合计避免重复
  const only = view.windows.length === 1 ? view.windows[0] : null;
  const singlePoolHasDetail =
    only !== null && POOL_LABELS[only.key] !== undefined && only.remaining > 0;
  if (!singlePoolHasDetail) {
    lines.push({
      type: "text",
      label: "剩余积分",
      value: formatInt(view.aggregate.remaining),
      balance: true,
    });
  }
  return lines;
}

/**
 * 扫码 token 通道的读数（ADR-0041）。数据源是桌面客户端自己用的 `GET
 * https://openapi.qoder.com.cn/sash/api/v2/me/usage`，外面套一层 `{displayMode, qoderUsage}`，
 * 里面是 `userQuota` / `addOnQuota` / `dedicatedResourcePackages[]` 三族（每项都是
 * `{total, used, remaining, percentage, unit}`）。与 Cookie 通道的对账口径：
 * `userQuota`≈plan_quota、`addOnQuota`≈resource_package_quota、
 * `dedicatedResourcePackages`≈dedicated_resource_package_quota 的逐包清单。
 *
 * 三条刻意选择：
 * 1. **汇总位本地相加**，因为这一族响应里没有 `total_quota`。ADR-0030 已对账证实
 *    `total_quota` 就是三个分容器的和（2000+1200=3200、0+666=666），所以相加不是新造口径。
 * 2. **百分比一律本地按 used/total 算**，不取上游的 `percentage`/`totalUsagePercentage`：
 *    真机 `0.29` 对应本地 `607/2100 = 28.9047%`，上游那个数是两位舍入的产物（同 ADR-0030 §4）。
 * 3. **`expiresAt` 只认未来且要挡 9999 哨兵**：真机订阅已失效的号回的是
 *    `253402214400000`（=9999-12-31），照挂就会在卡片上写一句「9999 年刷新」。
 *    Cookie 通道的 `nextResetAt` 从未观察到这个值，故哨兵判定只加在这条通道上。
 *
 * 逐包到期日：只有 `dedicatedResourcePackages` 的每一项带 `expiresAt`（普通资源包在这一族
 * 响应里被聚合成一个数，没有独立到期字段——第三方实现的解码器同口径），所以 package 行的
 * 「· 到期日」后缀在扫码通道下自然不出现，不需要为它写特例。
 */
interface QoderDeviceQuota {
  total?: unknown;
  used?: unknown;
  remaining?: unknown;
  expiresAt?: unknown;
  expires_at?: unknown;
}

interface QoderDevicePayload {
  displayMode?: unknown;
  qoderUsage?: {
    expiresAt?: unknown;
    userQuota?: QoderDeviceQuota | null;
    addOnQuota?: QoderDeviceQuota | null;
    dedicatedResourcePackages?: QoderDeviceQuota[] | null;
  } | null;
}

/** 9999-12-31 那类「无期限」哨兵的分界：晚于此值一律按没有时刻处理 */
const SENTINEL_AFTER_MS = Date.UTC(9998, 0, 1);

function deviceQuota(raw: QoderDeviceQuota | null | undefined): {
  used: number;
  total: number;
  remaining: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const used = toCount(raw.used);
  const total = toCount(raw.total);
  if (used == null || total == null) return null;
  return { used, total, remaining: toCount(raw.remaining) ?? Math.max(0, total - used) };
}

/** 到期时刻：只认未来，且 9999 哨兵按「没有时刻」处理 */
function deviceExpiry(raw: unknown, now: number): Date | null {
  const parsed = parseNextReset(raw);
  if (!parsed) return null;
  const ms = parsed.getTime();
  if (ms <= now || ms >= SENTINEL_AFTER_MS) return null;
  return parsed;
}

export function parseDeviceUsageView(
  payload: QoderDevicePayload | undefined,
  now = Date.now(),
): QoderUsageView | null {
  // displayMode 不是 "qoder"（企业版）时这一族到底给不给数字，我们没有真机样本，
  // 因此不猜形状：按解析失败报错并把 displayMode 带进文案，等真机出现再定口径
  if (!payload || typeof payload !== "object") return null;
  // displayMode 不是 "qoder"（企业版等）时这一族给不给数字，我们**没有真机样本**，
  // 因此不猜形状：整体按解析失败，由调用方把实际值带进错误详情，等真机出现再定口径
  if (payload.displayMode !== "qoder") return null;
  const usage = payload.qoderUsage;
  if (!usage || typeof usage !== "object") return null;

  const windows: QoderQuotaWindow[] = [];
  // 「上游声明了这个容器却读不出」与「这个号没分配这个容器」是两回事：前者整体判失败
  // （Cookie 通道同一条规则，ADR-0024 错误可见），否则脏数据会被画成「未分配积分」
  const plan = usage.userQuota ? deviceQuota(usage.userQuota) : null;
  if (usage.userQuota && !plan) return null;
  const pack = usage.addOnQuota ? deviceQuota(usage.addOnQuota) : null;
  if (usage.addOnQuota && !pack) return null;
  const packages = Array.isArray(usage.dedicatedResourcePackages)
    ? usage.dedicatedResourcePackages
    : [];
  const dedicated = packages.map((item) => deviceQuota(item));
  // 同上：专属包数组里有一项读不出就整体判失败，不能把脏数据当「没有专属包」
  if (dedicated.some((item) => !item)) return null;
  const dedicatedQuotas = dedicated.filter(
    (item): item is { used: number; total: number; remaining: number } => !!item,
  );

  const push = (
    key: QoderQuotaKey,
    quota: { used: number; total: number; remaining: number } | null,
    resetsAt: Date | null = null,
    earliestExpiry: Date | null = null,
  ) => {
    if (!quota) return;
    if (quota.total <= 0 && (quota.used > 0 || quota.remaining > 0)) return; // 矛盾数据：整窗丢弃
    if (quota.total <= 0 && quota.used <= 0) return; // 恒零＝没分配，没窗口可画
    windows.push({
      key,
      ...quota,
      percent: (quota.used / quota.total) * 100,
      resetsAt,
      earliestExpiry,
    });
  };

  const planReset = deviceExpiry(usage.expiresAt, now);
  push("plan", plan, planReset);
  push("package", pack);
  // 专属包是逐包下发的，聚合成一窗（与 Cookie 通道的 dedicated 容器同形态），
  // 到期日取「还有余量的那些包里最早的」（同 earliestActiveExpiry 的谎报防线）
  if (dedicatedQuotas.length > 0) {
    const sum = dedicatedQuotas.reduce(
      (acc, item) => ({ used: acc.used + item.used, total: acc.total + item.total, remaining: acc.remaining + item.remaining }),
      { used: 0, total: 0, remaining: 0 },
    );
    let earliest: Date | null = null;
    // packages 与 dedicatedQuotas 一一对应（上面已保证没有读不出的项）
    for (const [index, quota] of dedicatedQuotas.entries()) {
      if (quota.remaining <= 0) continue;
      const item = packages[index];
      const expiry = deviceExpiry(item.expiresAt ?? item.expires_at, now);
      if (expiry && (!earliest || expiry < earliest)) earliest = expiry;
    }
    push("dedicated", sum, null, earliest);
  }

  const aggregate = windows.reduce(
    (acc, window) => ({
      used: acc.used + window.used,
      total: acc.total + window.total,
      remaining: acc.remaining + window.remaining,
    }),
    { used: 0, total: 0, remaining: 0 },
  );
  return {
    windows,
    aggregate: {
      ...aggregate,
      percent: aggregate.total > 0 ? (aggregate.used / aggregate.total) * 100 : 0,
    },
    resetsAt: planReset,
  };
}

export interface UsageOutcome {
  ok: boolean;
  lines: MetricLine[];
  error?: string;
  errorParams?: Record<string, string | number>;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用量响应整体处理：401/403 或返回登录页 HTML 统一映射为「凭据无效或已过期，
 *  重贴会话 Cookie 值」——不区分成因（区分需要额外探测且给不出不同建议，ADR-0030） */
export function processUsageResult(result: HttpResult): UsageOutcome {
  const looksHtml = result.bodyText.trimStart().startsWith("<");
  if (result.status === 401 || result.status === 403 || (result.status === 200 && looksHtml)) {
    return {
      ok: false,
      lines: [],
      error: CREDENTIAL_EXPIRED_MESSAGE,
    };
  }
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() || "";
    return {
      ok: false,
      lines: [],
      error: "积分接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const view = parseUsageView(JSON.parse(result.bodyText) as QoderUsageData);
    if (!view) {
      return {
        ok: false,
        lines: [],
        error: "积分接口返回数据解析失败：{detail}",
        errorParams: { detail: "quota_summary 结构缺失" },
      };
    }
    return { ok: true, lines: parseUsageLines(view) };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "积分接口返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

/** 通道判定（ADR-0035 互斥模型在 Qoder 上的落地，ADR-0041）：accessToken 槽非空即扫码
 *  token 通道，否则有 cookie 就走 Cookie 通道，两者都缺返回 null */
export function resolveQoderChannel(
  status: InstanceCredentialStatus,
): "device" | "cookie" | null {
  if (status.accessToken) return "device";
  if (status.cookie) return "cookie";
  return null;
}

/** 扫码通道的数据源按站取（ADR-0041，两站各走自己的 openapi） */
export function qoderDeviceUsageUrl(site: ProviderSite): string {
  return SITES[site].deviceUsageUrl;
}

/** 扫码通道的失效文案：出路是重扫，不静默换通道（ADR-0024） */
export const QODER_DEVICE_EXPIRED_MESSAGE =
  "Qoder 扫码登录已失效，请在设置中重新扫码；或改用 Cookie 登录";

/** 提前续期的窗口：距 expiresAt 不足 7 天就在本轮刷新前先续一次。续成功后 expiresAt
 *  往后推 30 天，天然自带节流——不需要「今天已续过」这个判据，也就不必为它建状态表
 *  （WorkBuddy 的每日一刷用状态表，是因为它的 token 会被官方客户端互踢、必须按天重试） */
export const QODER_RENEW_AHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/** expiresAt 槽的读法：扫码时存的是上游 ISO 串，容毫秒数字串（与摘要行同一口径） */
export function parseQoderExpiry(raw: string | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const ms = Number(raw);
  const value = Number.isFinite(ms) && ms > 0 ? ms : Date.parse(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value - now;
}

/** 扫码通道的取数：Origin/Referer/Bx-V 都不需要——真机只发 Accept + Authorization: Bearer
 *  就 200（两站各自实证：CN 2026-10-09、国际站 2026-10-10） */
function requestQoderDeviceUsage(instanceId: string, site: ProviderSite): Promise<HttpResult> {
  return invoke<HttpResult>("provider_request", {
    instanceId,
    url: qoderDeviceUsageUrl(site),
    method: "GET",
    auth: "qoder_device",
    headers: { Accept: "application/json, text/plain, */*" },
  });
}

/** 续期：失败不抛（调用方按「没续上」继续走 401 那条救火路），但原因要能被看见——
 *  静默吞掉的话用户只会看到「请重新扫码」，而实际可能是网络或上游改了响应形状 */
async function renewQoderToken(instanceId: string): Promise<boolean> {
  try {
    await invoke("qoder_token_refresh", { instanceId });
    return true;
  } catch (error) {
    console.warn("Qoder token 续期失败，旧 token 保留待下轮重试", error);
    return false;
  }
}

/** 扫码通道的响应 → 卡片行。401/403 一律按凭据失效（与 Cookie 通道同判据） */
export function processDeviceResult(result: HttpResult): UsageOutcome {
  const looksHtml = result.bodyText?.trimStart().startsWith("<") === true;
  if (result.status === 401 || result.status === 403 || (result.status === 200 && looksHtml)) {
    return { ok: false, lines: [], error: QODER_DEVICE_EXPIRED_MESSAGE };
  }
  if (result.status !== 200) {
    const detail = result.bodyText?.trim() ?? "";
    return {
      ok: false,
      lines: [],
      error: "积分接口返回 HTTP {status}{detail}",
      errorParams: { status: result.status, detail: detail ? `：${truncate(detail)}` : "" },
    };
  }
  try {
    const payload = JSON.parse(result.bodyText ?? "") as QoderDevicePayload;
    const view = parseDeviceUsageView(payload);
    if (!view) {
      // 把实际的 displayMode 带进详情：企业号形态未证实，真机出现时这句就是取证线索
      const mode = typeof payload?.displayMode === "string" ? payload.displayMode : "(缺失)";
      return {
        ok: false,
        lines: [],
        error: "积分接口返回数据解析失败：{detail}",
        errorParams: { detail: `displayMode=${mode}、qoderUsage 结构缺失或含读不出的配额容器` },
      };
    }
    return { ok: true, lines: parseUsageLines(view) };
  } catch (error) {
    return {
      ok: false,
      lines: [],
      error: "积分接口返回数据解析失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }
}

/** 扫码通道的取数：先按 expiresAt 决定要不要提前续，再打端点，401 就续一次重试一次 */
async function fetchQoderDeviceOutcome(instance: ProviderInstance): Promise<UsageOutcome> {
  const site = qoderSiteOf(instance);
  const credentials = await invoke<InstanceCredentials>("vault_credentials", {
    instanceId: instance.id,
  });
  const ahead = parseQoderExpiry(credentials.expiresAt);
  if (ahead != null && ahead < QODER_RENEW_AHEAD_MS) await renewQoderToken(instance.id);
  let result = await requestQoderDeviceUsage(instance.id, site);
  if (result.status === 401 || result.status === 403) {
    const renewed = await renewQoderToken(instance.id);
    if (renewed) result = await requestQoderDeviceUsage(instance.id, site);
  }
  return processDeviceResult(result);
}

async function fetchQoderSnapshot(instance: ProviderInstance): Promise<ProviderSnapshot> {
  const status = await invoke<InstanceCredentialStatus>("vault_credential_status", {
    instanceId: instance.id,
  });
  const updatedAt = Date.now();
  const channel = resolveQoderChannel(status);
  if (!channel) {
    return {
      instanceId: instance.id,
      providerId: "qoder",
      providerName: PROVIDER_NAME,
      status: "needs_config",
      updatedAt,
      message: "请在设置中扫码登录 Qoder，或粘贴会话 Cookie（qoder_session_cookie）的值",
      lines: [],
    };
  }

  if (channel === "device") {
    let outcome: UsageOutcome;
    try {
      outcome = await fetchQoderDeviceOutcome(instance);
    } catch (error) {
      outcome = {
        ok: false,
        lines: [],
        error: "积分接口查询失败：{detail}",
        errorParams: { detail: toErrorText(error) },
      };
    }
    if (!outcome.ok) {
      return {
        instanceId: instance.id,
        providerId: "qoder",
        providerName: PROVIDER_NAME,
        status: "error",
        updatedAt,
        message: outcome.error,
        messageParams: outcome.errorParams,
        lines: [],
        // 扫码通道读不到消耗明细：入口不画（ADR-0041）。失败快照也要带上，
        // 否则上一轮 Cookie 实例的按钮会留在原地
        statsAvailable: false,
      };
    }
    return {
      instanceId: instance.id,
      providerId: "qoder",
      providerName: PROVIDER_NAME,
      status: "ok",
      updatedAt,
      lines: outcome.lines,
      statsAvailable: false,
    };
  }

  const site = qoderSiteOf(instance);
  let outcome: UsageOutcome;
  try {
    const result = await invoke<HttpResult>("provider_request", {
      instanceId: instance.id,
      url: qoderUsageUrl(site),
      method: "GET",
      auth: "qoder_cookie",
      credentialSlot: CREDENTIAL_SLOT,
      headers: qoderUsageHeaders(site),
    });
    outcome = processUsageResult(result);
  } catch (error) {
    outcome = {
      ok: false,
      lines: [],
      error: "积分接口查询失败：{detail}",
      errorParams: { detail: toErrorText(error) },
    };
  }

  if (!outcome.ok) {
    return {
      instanceId: instance.id,
      providerId: "qoder",
      providerName: PROVIDER_NAME,
      status: "error",
      updatedAt,
      message: outcome.error,
      messageParams: outcome.errorParams,
      lines: [],
    };
  }

  return {
    instanceId: instance.id,
    providerId: "qoder",
    providerName: PROVIDER_NAME,
    status: "ok",
    updatedAt,
    lines: outcome.lines,
  };
}

export const qoderProvider: ProviderModule = {
  id: "qoder",
  name: "Qoder",
  description: "查询 Qoder 大模型积分余量与重置时间",
  fetch: fetchQoderSnapshot,
};
