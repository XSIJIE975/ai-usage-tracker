import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import type { DiagnosisResult } from "./diagnostics";
import { describeDiagnosis, testQoderCookie, testWorkbuddyCredential } from "./diagnostics";

const mockInvoke = vi.mocked(invoke);

const ok: DiagnosisResult = { ok: true, status: 200, latencyMs: 8, code: "ok" };

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("testQoderCookie", () => {
  it("空输入不发请求", async () => {
    const result = await testQoderCookie("   ", "china");
    expect(result.code).toBe("missing-credential");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("没过白名单的输入不发请求：探测与保存同口径", async () => {
    for (const bad of [
      "Cookie: qoder_session_cookie=abc",
      "qoder_session_cookie=abc",
      "qoder_session_cookie=abc; theme=dark",
      "abc def",
      "a=中文",
    ]) {
      const result = await testQoderCookie(bad, "china");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("invalid-credential-format");
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("合法输入（单个 Cookie 的值）按 qoder_cookie 通道打选中站点的端点", async () => {
    mockInvoke.mockResolvedValue(ok);
    await testQoderCookie("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.9dpJFQ", "international");
    const [command, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("diagnose_request");
    expect(args.url).toBe("https://qoder.com/api/v2/me/usages/big_model_credits");
    expect(args.auth).toBe("qoder_cookie");
    expect((args.headers as Record<string, string>).Origin).toBe("https://qoder.com");
  });

  it("格式非法的展示文案与保存时同一条", () => {
    const t = (text: string) => text;
    expect(
      describeDiagnosis({ ok: false, status: 0, latencyMs: 0, code: "invalid-credential-format" }, t),
    ).toBe(
      "只粘贴 qoder_session_cookie 的值：不要带「Cookie:」前缀或键名，也不能包含分号、空格、换行或中文",
    );
  });
});

describe("testWorkbuddyCredential", () => {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0";

  it("探测走 POST billing 族，带与刷新链路同款的请求体与头（ADR-0031）", async () => {
    mockInvoke.mockResolvedValue(ok);
    await testWorkbuddyCredential("s-1", "s-2", UA, "china");
    const [command, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("diagnose_request");
    expect(args.url).toBe("https://www.workbuddy.cn/billing/meter/get-user-resource");
    expect(args.method).toBe("POST");
    expect(JSON.parse(args.bodyText as string)).toMatchObject({ ProductCode: "p_tcaca" });
    expect((args.headers as Record<string, string>)["x-client-platform"]).toBe("web");
    // 探测不再依赖 activity 族（国际站没有成长中心）
    expect(args.url).not.toContain("activity");
    // 三值原样交给 Rust 端同一个拼装入口：探测发出的 Cookie 头与刷新的一字不差
    expect(args.sessionTriple).toEqual({ session: "s-1", session2: "s-2", userAgent: UA });
  });

  it("国际站探测换域", async () => {
    mockInvoke.mockResolvedValue(ok);
    await testWorkbuddyCredential("s-1", "s-2", UA, "international");
    const [, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.url).toBe("https://www.workbuddy.ai/billing/meter/get-user-resource");
    expect((args.headers as Record<string, string>).Origin).toBe("https://www.workbuddy.ai");
  });

  it("三值缺一就不发请求", async () => {
    const result = await testWorkbuddyCredential("s-1", "", UA, "china");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.code).toBe("missing-credential");
  });

  it("把整段 Cookie 头贴进一格时报格式非法而不是网络错误", async () => {
    const result = await testWorkbuddyCredential("session=s-1; session_2=s-2", "s-2", UA, "china");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.code).toBe("invalid-credential-format");
  });

  it("UA 带换行（头注入形态）同样按格式非法拒掉", async () => {
    const result = await testWorkbuddyCredential("s-1", "s-2", "Mozilla/5.0\r\nX-Injected: 1", "china");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result.code).toBe("invalid-credential-format");
  });
});
