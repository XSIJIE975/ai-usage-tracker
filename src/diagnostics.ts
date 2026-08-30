import { invoke } from "@tauri-apps/api/core";
import { buildUsageQuery } from "./providers/deepseek-stats";

export interface DiagnosisResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  message: string;
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
  if (!key.trim()) return Promise.resolve({ ok: false, status: 0, latencyMs: 0, message: "请先填写 API Key" });
  return diagnose("https://api.deepseek.com/user/balance", "bearer", key);
}

/** DeepSeek UserToken：平台统计接口探测 */
export function testDeepSeekUserToken(token: string): Promise<DiagnosisResult> {
  if (!token.trim())
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, message: "请先填写 UserToken" });
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
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, message: "请先填写 Workspace ID 和 Auth Cookie" });
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
    return Promise.resolve({ ok: false, status: 0, latencyMs: 0, message: "请先填写 API Key" });
  return diagnose("https://opencode.ai/zen/go/v1/usage", "bearer", key);
}
