import { invoke } from "@tauri-apps/api/core";
import { buildUsageQuery } from "./providers/deepseek-stats";

/** 机器可读的诊断结果码，与 src-tauri/src/commands.rs 的 diagnose_request 保持一致 */
export type DiagnosisCode =
  | "ok"
  | "missing-api-key"
  | "missing-user-token"
  | "missing-workspace-cookie"
  | "missing-credential"
  | "network-error"
  | "login-redirect"
  | "invalid-credentials"
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
      return t("请先填写 Workspace ID 和 Auth Cookie");
    case "missing-credential":
      return t("请先填写凭据值");
    case "network-error":
      return t("网络请求失败：{detail}").replace("{detail}", result.detail ?? "");
    case "login-redirect":
      return t("Cookie 已失效（页面跳转到登录）");
    case "ok":
      return t("连接正常（{latency}ms）").replace("{latency}", String(result.latencyMs));
    case "invalid-credentials":
      return t("凭据无效或已过期（HTTP {status}）").replace("{status}", String(result.status));
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
  expectHtml = false,
): Promise<DiagnosisResult> {
  return invoke<DiagnosisResult>("diagnose_request", {
    url,
    auth,
    credential,
    expectHtml,
  });
}

/** WorkBuddy 凭据探测：粘贴原文（curl / Cookie 头 / 裸 session Value）直接透传，
 *  解析与拼头全在 Rust 端（curl_paste），与刷新链路走同一份实现，
 *  保证「测得过 ≒ 存得过」；畸形粘贴由 Rust 报出具体缺什么 */
async function diagnoseWithCredentialText(url: string, credentialText: string): Promise<DiagnosisResult> {
  return invoke<DiagnosisResult>("diagnose_request", {
    url,
    credentialText,
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

/** OpenCode Go：Workspace ID + Auth Cookie（后台页面抓取探测，校验未跳转登录） */
export function testOpenCodeConnection(workspaceId: string, authCookie: string): Promise<DiagnosisResult> {
  if (!workspaceId.trim() || !authCookie.trim())
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-workspace-cookie" });
  return diagnose(
    `https://opencode.ai/workspace/${encodeURIComponent(workspaceId.trim())}/go`,
    "cookie",
    authCookie,
    true,
  );
}

/** OpenCode Go 可选 API Key：官方 usage 接口探测 */
export function testOpenCodeApiKey(key: string): Promise<DiagnosisResult> {
  if (!key.trim())
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-api-key" });
  return diagnose("https://opencode.ai/zen/go/v1/usage", "bearer", key);
}

/** 智谱 Coding Plan API Key：Coding Plan 配额接口探测 */
export function testGlmCodingPlanKey(key: string): Promise<DiagnosisResult> {
  if (!key.trim())
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-api-key" });
  return diagnose("https://open.bigmodel.cn/api/monitor/usage/quota/limit", "bearer", key);
}

/** WorkBuddy 登录凭据：连登接口探测（activity 族只读端点，Cookie 会话）。
 *  输入是粘贴原文，原文透传，解析与拼头由 Rust 端负责 */
export function testWorkbuddyCredential(credentialText: string): Promise<DiagnosisResult> {
  const text = credentialText.trim();
  if (!text)
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, code: "missing-credential" });
  return diagnoseWithCredentialText("https://www.workbuddy.cn/activity/growth/streak", text);
}

/** Rust 端解析结果（curl_paste::WorkbuddyCredential）；值本身不外露，只取有没有 */
interface ParsedWorkbuddyCredential {
  session: string;
  session2?: string;
  userAgent?: string;
}

export interface WorkbuddyCredentialParts {
  session: boolean;
  session2: boolean;
  userAgent: boolean;
}

/** 粘贴内容的解析预览：录入界面据此提示三要素缺哪一项（解析规则与刷新链路同源） */
export async function inspectWorkbuddyCredential(
  credentialText: string,
): Promise<WorkbuddyCredentialParts> {
  const parsed = await invoke<ParsedWorkbuddyCredential>("parse_workbuddy_credential", {
    credentialText,
  });
  return {
    session: Boolean(parsed.session),
    session2: Boolean(parsed.session2),
    userAgent: Boolean(parsed.userAgent),
  };
}
