import { invoke } from "@tauri-apps/api/core";
import { buildUsageQuery } from "./providers/deepseek-stats";
import { isValidSessionCookieValue, qoderUsageHeaders, qoderUsageUrl } from "./providers/qoder";
import {
  isValidMimoCredentialValue,
  MIMO_BALANCE_URL,
  SERVICE_TOKEN_COOKIE_NAME,
  USER_ID_COOKIE_NAME,
  mimoRequestHeaders,
} from "./providers/mimo";
import { workbuddyApi, workbuddySiteOf, isValidCookiePartValue, isValidUserAgentValue } from "./providers/workbuddy";
import type { ProviderSite } from "./types/ipc";

/** 机器可读的诊断结果码，与 src-tauri/src/commands.rs 的 diagnose_request 保持一致 */
export type DiagnosisCode =
  | "ok"
  | "missing-api-key"
  | "missing-user-token"
  | "missing-workspace-cookie"
  | "missing-credential"
  | "missing-mimo-credential"
  /** 凭据原文没过保存侧同一份白名单（探测与保存同口径，ADR-0030 §2） */
  | "invalid-credential-format"
  /** OpenCode 的 Cookie 头不含可识别键、含非法字符或超长（与保存侧同口径） */
  | "opencode-cookie-format"
  /** 控制台不认识该工作区（HTTP 404），通常是 Workspace ID 填错 */
  | "opencode-workspace-not-found"
  | "network-error"
  | "invalid-credentials"
  /** OpenCode Go 的 API Key 有效，但该账号没有 Go 订阅（HTTP 403） */
  | "no-go-subscription"
  | "http-error"
  /** 调用本身抛错（前端构造，非后端返回码），原文放 detail 直接展示 */
  | "unknown";

export interface DiagnosisResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  code: DiagnosisCode;
  /** 附加细节（如网络错误的原始错误文本） */
  detail?: string | null;
}

type TFn = (text: string) => string;

/** 按结果码用界面语言组装展示文案；zh 下渲染结果与文案原文一致 */
export function describeDiagnosis(result: DiagnosisResult, t: TFn): string {
  switch (result.code) {
    case "missing-api-key":
      return t("请先填写 API Key");
    case "missing-user-token":
      return t("请先填写 UserToken");
    case "missing-workspace-cookie":
      return t("请先填写 Workspace ID 和 Cookie");
    case "missing-credential":
      return t("请先填写凭据值");
    case "missing-mimo-credential":
      return t("请先填写小米 MiMo 的 serviceToken 与 userId");
    case "invalid-credential-format":
      // 与保存时拦下的是同一条文案：探测不该比保存宽松。措辞按 Cookie 值通说（三家共用
      // 这个码），具体该复制哪个键写在字段的取凭据指引里，不在这里逐家复述
      return t(
        "只粘贴该 Cookie 的值：不要带「Cookie:」前缀或键名，也不能包含分号、空格、换行或中文",
      );
    case "opencode-cookie-format":
      return t(
        "Cookie 需包含 auth、__Host-auth 或 __Host-console_session；值里不能含空格或换行，总长不超过 8 KB",
      );
    case "opencode-workspace-not-found":
      return t("OpenCode 控制台找不到该工作区（HTTP 404），请核对 Workspace ID");
    case "network-error":
      return t("网络请求失败：{detail}").replace("{detail}", result.detail ?? "");
    case "ok":
      return t("连接正常（{latency}ms）").replace("{latency}", String(result.latencyMs));
    case "invalid-credentials":
      return t("凭据无效或已过期（HTTP {status}）").replace("{status}", String(result.status));
    case "no-go-subscription":
      return t("该 API Key 未开通 OpenCode Go 订阅");
    case "http-error":
      return t("接口返回 HTTP {status}").replace("{status}", String(result.status));
    default:
      return result.detail ?? result.code;
  }
}

/** 通用探测请求：用刚输入、尚未保存的凭据值发起真实请求 */
async function diagnose(
  url: string,
  auth: "bearer" | "cookie",
  credential: string,
  headers?: Record<string, string>,
): Promise<DiagnosisResult> {
  return invoke<DiagnosisResult>("diagnose_request", {
    url,
    auth,
    credential,
    headers,
  });
}

const oneDayQuery = (): { start: number; end: number; tz: number } => {
  const end = Date.now();
  return buildUsageQuery(end - 86_400_000, end);
};

/** DeepSeek API Key：余额接口探测 */
export function testDeepSeekApiKey(key: string): Promise<DiagnosisResult> {
  if (!key.trim()) return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-api-key" });
  return diagnose("https://api.deepseek.com/user/balance", "bearer", key);
}

/** DeepSeek UserToken：平台统计接口探测 */
export function testDeepSeekUserToken(token: string): Promise<DiagnosisResult> {
  if (!token.trim())
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-user-token" });
  const query = oneDayQuery();
  return diagnose(
    `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${query.start}&end=${query.end}&tz=${query.tz}`,
    "bearer",
    token,
  );
}

/**
 * OpenCode Go 余额凭据：探测控制台 `/console/api/billing/status`（Cookie + x-org-id）。
 * 404 单独映射为「工作区找不到」，避免和网络/服务端错误混在一起。
 */
export async function testOpenCodeConnection(
  workspaceId: string,
  cookie: string,
): Promise<DiagnosisResult> {
  const workspace = workspaceId.trim();
  if (!workspace || !cookie.trim())
    return { ok: false, status: 0, latencyMs: 0, code: "missing-workspace-cookie" };

  const result = await diagnose(
    "https://opencode.ai/console/api/billing/status",
    "cookie",
    cookie,
    { Accept: "application/json", "x-org-id": workspace },
  );
  if (!result.ok && result.status === 404) {
    return { ...result, code: "opencode-workspace-not-found" };
  }
  return result;
}

/** OpenCode Go API Key：官方 usage 接口探测；403 单独报「未开通 Go 订阅」 */
export async function testOpenCodeApiKey(key: string): Promise<DiagnosisResult> {
  if (!key.trim())
    return { ok: false, status: 0, latencyMs: 0, code: "missing-api-key" };
  const result = await diagnose("https://opencode.ai/zen/go/v1/usage", "bearer", key);
  if (!result.ok && result.status === 403) {
    return { ...result, code: "no-go-subscription" };
  }
  return result;
}

/** 小米 MiMo 登录凭据：余额端点探测（mimo_cookie 通道）。两个值交给 Rust 端的同一个拼装
 *  入口，所以探测用的 Cookie 头与 UA 与保存后刷新发出的一字不差（测得过即存得过）；
 *  探测走 GET 余额端点，与卡片刷新同法同端点 */
export function testMimoCredential(
  serviceToken: string,
  userId: string,
): Promise<DiagnosisResult> {
  const pair = {
    serviceToken: serviceToken.trim(),
    userId: userId.trim(),
  };
  if (!pair.serviceToken || !pair.userId)
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-mimo-credential" });
  // 探测与保存过同一份白名单：否则非法输入会真发出去，撞成一句查不出原因的 network-error
  if (
    !isValidMimoCredentialValue(pair.serviceToken, SERVICE_TOKEN_COOKIE_NAME) ||
    !isValidMimoCredentialValue(pair.userId, USER_ID_COOKIE_NAME)
  )
    return Promise.resolve({
      ok: false,
      status: 0,
      latencyMs: 0,
      code: "invalid-credential-format",
    });
  return invoke<DiagnosisResult>("diagnose_request", {
    url: MIMO_BALANCE_URL,
    mimoPair: pair,
    headers: mimoRequestHeaders(),
  });
}

/** 智谱 Coding Plan API Key：Coding Plan 配额接口探测 */
export function testGlmCodingPlanKey(key: string): Promise<DiagnosisResult> {
  if (!key.trim())
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-api-key" });
  return diagnose("https://open.bigmodel.cn/api/monitor/usage/quota/limit", "bearer", key);
}

/** WorkBuddy 登录凭据：billing 族 get-user-resource 探测（POST + 与刷新链路同一请求体与
 *  头）。探测与取数同法同族，一次问清「本站有没有这个端点」与「凭据过不过三元组同源」
 *  （ADR-0031）；三值交给 Rust 端的同一个拼装入口（instances::workbuddy_session），
 *  所以探测用的 Cookie 头与 UA 与保存后刷新发出的一字不差（ADR-0029 四次修订） */
export function testWorkbuddyCredential(
  session: string,
  session2: string,
  userAgent: string,
  site: ProviderSite,
): Promise<DiagnosisResult> {
  const triple = {
    session: session.trim(),
    session2: session2.trim(),
    userAgent: userAgent.trim(),
  };
  if (!triple.session || !triple.session2 || !triple.userAgent)
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-credential" });
  // 与保存侧同一份格式判定：非法输入不真发出去，免得撞成一句查不出原因的 network-error
  if (
    !isValidCookiePartValue(triple.session) ||
    !isValidCookiePartValue(triple.session2) ||
    !isValidUserAgentValue(triple.userAgent)
  )
    return Promise.resolve({
      ok: false,
      status: 0,
      latencyMs: 0,
      code: "invalid-credential-format",
    });
  const api = workbuddyApi(workbuddySiteOf({ site }));
  return invoke<DiagnosisResult>("diagnose_request", {
    url: api.urls.resource,
    method: "POST",
    bodyText: api.resourceBody,
    headers: api.headers.billing,
    sessionTriple: triple,
  });
}

/** Qoder 会话 Cookie 值：大模型积分接口探测（qoder_cookie 通道，与刷新链路同一拼装口径——
 *  键名与 Cookie 头由 Rust 拼、UA 用缺省 Chrome 常量、静态协议头随站点）。
 *  传的是输入框里的原文，与保存后刷新走的是同一个值（测得过即存得过） */
export function testQoderCookie(sessionCookieValue: string, site: ProviderSite): Promise<DiagnosisResult> {
  const text = sessionCookieValue.trim();
  if (!text)
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-credential" });
  // 探测与保存过同一份白名单：否则非法输入会真发出去，撞成一句查不出原因的 network-error
  if (!isValidSessionCookieValue(text))
    return Promise.resolve({
      ok: false,
      status: 0,
      latencyMs: 0,
      code: "invalid-credential-format",
    });
  return invoke<DiagnosisResult>("diagnose_request", {
    url: qoderUsageUrl(site),
    auth: "qoder_cookie",
    credential: text,
    headers: qoderUsageHeaders(site),
  });
}
