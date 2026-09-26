import { normalizeOpenCodeAuthCookie } from "../lib/utils";
import type { ProviderKind, ProviderSite } from "../types/ipc";
import type { FormErrorCode } from "./error-codes";
import { isValidSessionCookieValue } from "../providers/qoder";
import { isValidCookiePartValue, isValidUserAgentValue } from "../providers/workbuddy";

/**
 * 供应商实例表单的字段规格表：渲染元数据 + 必填矩阵 + 格式校验，一张表管到底。
 *
 * 这里是「表单层」的单一事实源，不是「校验规则仓库」——格式判定一律引用各供应商模块
 * 已有的谓词（isValidSessionCookieValue / isValidCookiePartValue / isValidUserAgentValue），
 * 那些谓词与 Rust 发请求时的校验同口径，也被 diagnostics 的连通性探测复用。在表里重抄
 * 一遍正则就会分裂成两份事实：前端放行、Rust 拒绝，退化成存进去等 401。
 *
 * 必填性对齐各 provider fetch 的 needs_config 判据（各条注明出处）。改判据时同一次改动
 * 里更新这张表，并由 instance-schema.test.ts 的必填矩阵用例钉住两边一致。
 *
 * 本文件刻意留在 forms 层而不是 providers/：它带着各站点的域名指引文案，而
 * allowed-hosts.test.ts 按目录扫「前端会打出去的地址」，这里的 URL 只是给人看的取数指引，
 * 不是请求目标，混进供应商模块目录会让那份白名单守卫失去「文件即会发请求」的语义。
 */

export interface CredentialFieldSpec {
  slot: string;
  label: string;
  placeholder?: string;
  help?: string;
  /** 该槽位是否为该供应商正常出数所必需 */
  required: boolean;
  /** 展示前归一化（auth cookie 兼容多种粘贴格式） */
  normalize?: (value: string) => string;
  /** 格式校验：返回错误码，通过返回 null。只允许引用供应商模块已有的谓词 */
  validate?: (value: string) => FormErrorCode | null;
  /** 选填字段的后果说明：留空能做什么、做不到什么 */
  optionalHint?: string;
}

export interface ThresholdSpec {
  label: string;
  hint: string;
  min: number;
  max: number;
}

export interface ProviderFormSpec {
  fields: CredentialFieldSpec[];
  threshold: ThresholdSpec;
  /** 第二阈值（可选）：glm 的余额告警阈值（元），与配额百分比阈值并存 */
  balanceThreshold?: ThresholdSpec;
}

export const providerFormSpecs: Record<ProviderKind, ProviderFormSpec> = {
  deepseek: {
    fields: [
      {
        slot: "apiKey",
        label: "DeepSeek API Key",
        placeholder: "sk-...",
        required: true, // deepseek.ts:33 缺即 needs_config
      },
      {
        slot: "userToken",
        label: "DeepSeek UserToken",
        placeholder: "platform.deepseek.com 登录令牌",
        help: "获取方式：打开 platform.deepseek.com 并登录 → F12 打开开发者工具 → Application(应用) → Local Storage → https://platform.deepseek.com → 找到键 userToken，其值为 JSON 对象，复制其中 token 字段的字符串值。",
        // 只影响统计页（deepseek-stats.ts:38），余额卡片不依赖它，所以不硬要
        required: false,
        optionalHint: "留空不影响余额卡片，但用量统计页需要该令牌。",
      },
    ],
    threshold: { label: "余额告警阈值（元）", hint: "余额低于该值时发送系统通知；留空不告警。", min: 0, max: 1_000_000 },
  },
  "opencode-go": {
    fields: [
      {
        slot: "workspaceId",
        label: "OpenCode Go Workspace ID",
        placeholder: "wrk_...",
        required: true, // opencode-go.ts:123 与 cookie 缺一即 needs_config
      },
      {
        slot: "cookie",
        label: "OpenCode Auth Cookie",
        placeholder: "只粘贴 auth Cookie 的 Value",
        help: "获取方式：打开 opencode.ai 后台，按 F12 → Application → Cookies → opencode.ai，复制名为 auth 的 Value；不要带 Cookie: 或 auth= 前缀。",
        required: true,
        normalize: normalizeOpenCodeAuthCookie,
      },
      {
        slot: "apiKey",
        label: "OpenCode Go API Key（可选）",
        placeholder: "官方 /usage 接口上线后使用",
        // opencode-go.ts:134 填了才走官方 /usage，否则回落 HTML 抓取
        required: false,
        optionalHint: "留空则按页面抓取用量；填了才走官方 /usage 接口。",
      },
    ],
    threshold: { label: "本月额度告警阈值（%）", hint: "本月额度已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
  },
  glm: {
    fields: [
      {
        slot: "planKey",
        label: "智谱 Coding Plan API Key",
        placeholder: "粘贴 API Key",
        help: "获取方式：打开 bigmodel.cn 控制台 → Coding Plan 页 → 「生成 API Key」，复制生成的 API Key 粘贴到上方。",
        required: true, // glm.ts:387 缺即 needs_config
      },
    ],
    threshold: { label: "Coding Plan 配额告警阈值（%）", hint: "Coding Plan 配额已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
    balanceThreshold: { label: "余额告警阈值（元）", hint: "账户余额低于该值时发送系统通知；留空不告警。", min: 0, max: 1_000_000 },
  },
  workbuddy: {
    fields: [
      {
        slot: "session",
        label: "WorkBuddy session",
        placeholder: "只粘贴值，不带键名",
        help: "Cookie 行里 session= 后面的那段值",
        required: true, // workbuddy.ts:593 三格缺一即 needs_config（ADR-0029 网关要求成对）
        validate: (value) => (isValidCookiePartValue(value) ? null : "workbuddy_cookie_value"),
      },
      {
        slot: "session2",
        label: "WorkBuddy session_2",
        placeholder: "只粘贴值，不带键名",
        help: "Cookie 行里 session_2= 后面的那段值",
        required: true,
        validate: (value) => (isValidCookiePartValue(value) ? null : "workbuddy_cookie_value"),
      },
      {
        slot: "userAgent",
        label: "浏览器 User-Agent",
        placeholder: "只粘贴整行值，不带「User-Agent:」前缀",
        help: "User-Agent 行的整行值，须与登录时逐字节相同",
        required: true,
        validate: (value) => (isValidUserAgentValue(value) ? null : "workbuddy_ua_value"),
      },
    ],
    threshold: { label: "积分已用告警阈值（%）", hint: "积分已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
  },
  qoder: {
    fields: [
      {
        slot: "cookie",
        label: "Qoder 会话 Cookie",
        placeholder: "只粘贴 qoder_session_cookie 的值",
        required: true, // qoder.ts:283 缺即 needs_config
        validate: (value) => (isValidSessionCookieValue(value) ? null : "qoder_cookie_value"),
        // help 按选中站点动态生成，见 siteProfiles
      },
    ],
    threshold: { label: "积分已用告警阈值（%）", hint: "积分已用达到该百分比时发送系统通知；留空不告警。", min: 1, max: 100 },
  },
};

/**
 * 多站供应商的站点档案（ADR-0031）：域名是判站与重贴凭据的唯一线索，所以下拉标签与
 * 凭据获取文案都按 (种类, 站点) 给——并列两个域名会让显式判站失去意义。
 * 可选站点集本身在 lib/instance.ts 的 providerSites，弹窗与卡片徽标共用那一个判据。
 * `help` 是站点级长指引：多格种类折进「如何获取？」，单格种类贴在唯一的框下面。
 */
export const siteProfiles: Partial<
  Record<ProviderKind, Record<ProviderSite, { domain: string; help: string }>>
> = {
  qoder: {
    china: {
      domain: "qoder.com.cn",
      help: "获取方式：登录 qoder.com.cn → F12 → Application(应用) → Cookies → https://qoder.com.cn → 找到名为 qoder_session_cookie 的 Cookie，只复制它的 Value 粘贴（不要带键名或「Cookie:」前缀）。",
    },
    international: {
      domain: "qoder.com",
      help: "获取方式：登录 qoder.com → F12 → Application(应用) → Cookies → https://qoder.com → 找到名为 qoder_session_cookie 的 Cookie，只复制它的 Value 粘贴（不要带键名或「Cookie:」前缀）。",
    },
  },
  workbuddy: {
    china: {
      domain: "workbuddy.cn",
      // 逐格「贴哪一段」由各格的短提示说明，这里只留取值的导航路径
      help: "获取方式：登录 www.workbuddy.cn → F12 打开开发者工具 → Network(网络) → 刷新页面 → 任选一条 www.workbuddy.cn 的请求 → Request Headers(请求标头)，按每格下面的提示取三个值。三项必须来自同一条请求（网关要求两个 Cookie 成对、UA 与登录时逐字节相同），都只贴值本身、不带键名。",
    },
    international: {
      domain: "workbuddy.ai",
      help: "获取方式：登录 www.workbuddy.ai → F12 打开开发者工具 → Network(网络) → 刷新页面 → 任选一条 www.workbuddy.ai 的请求 → Request Headers(请求标头)，按每格下面的提示取三个值。三项必须来自同一条请求（网关要求两个 Cookie 成对、UA 与登录时逐字节相同），都只贴值本身、不带键名。",
    },
  },
};
