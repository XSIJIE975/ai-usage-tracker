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
