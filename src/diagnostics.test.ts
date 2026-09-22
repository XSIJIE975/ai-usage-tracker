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
    for (const bad of ["Cookie: a=1; b=2", "a=1\r\nX-Evil: 2", "a=中文"]) {
      const result = await testQoderCookie(bad, "china");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("invalid-credential-format");
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("合法输入按 raw_cookie 通道打选中站点的端点", async () => {
    mockInvoke.mockResolvedValue(ok);
    await testQoderCookie("session=abc; session_2=def", "international");
    const [command, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("diagnose_request");
    expect(args.url).toBe("https://qoder.com/api/v2/me/usages/big_model_credits");
    expect(args.auth).toBe("raw_cookie");
    expect((args.headers as Record<string, string>).Origin).toBe("https://qoder.com");
  });

  it("格式非法的展示文案与保存时同一条", () => {
    const t = (text: string) => text;
    expect(
      describeDiagnosis({ ok: false, status: 0, latencyMs: 0, code: "invalid-credential-format" }, t),
    ).toBe("只粘贴 Cookie 的值：不能带「Cookie:」前缀，也不能包含换行等控制字符或中文");
  });
});

describe("testWorkbuddyCredential", () => {
  it("探测走 POST billing 族，带与刷新链路同款的请求体与头（ADR-0031）", async () => {
    mockInvoke.mockResolvedValue(ok);
    await testWorkbuddyCredential("curl --url 'https://www.workbuddy.cn/...' -H 'cookie: ...'", "china");
    const [command, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("diagnose_request");
    expect(args.url).toBe("https://www.workbuddy.cn/billing/meter/get-user-resource");
    expect(args.method).toBe("POST");
    expect(JSON.parse(args.bodyText as string)).toMatchObject({ ProductCode: "p_tcaca" });
    expect((args.headers as Record<string, string>)["x-client-platform"]).toBe("web");
    // 探测不再依赖 activity 族（国际站没有成长中心）
    expect(args.url).not.toContain("activity");
  });

  it("国际站探测换域", async () => {
    mockInvoke.mockResolvedValue(ok);
    await testWorkbuddyCredential("curl --url 'https://www.workbuddy.ai/...'", "international");
    const [, args] = mockInvoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(args.url).toBe("https://www.workbuddy.ai/billing/meter/get-user-resource");
    expect((args.headers as Record<string, string>).Origin).toBe("https://www.workbuddy.ai");
  });
});
