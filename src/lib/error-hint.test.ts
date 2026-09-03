import { describe, expect, it } from "vitest";
import { classifyError, errorHintTitle } from "./error-hint";

describe("classifyError", () => {
  it("凭据类：HTTP 401/403 与登录/Cookie 措辞", () => {
    expect(
      classifyError(
        'DeepSeek 余额接口返回 HTTP 401：{"error":{"message":"Authentication Fails","type":"authentication_error"}}',
      ),
    ).toBe("auth");
    expect(classifyError("OpenCode Go 后台返回 HTTP 502，请检查 Cookie 是否过期")).toBe("auth");
    expect(classifyError("OpenCode Go 后台返回登录/挑战页，请重新复制 auth Cookie")).toBe("auth");
    expect(classifyError("Coding Plan 配额查询失败：code=403 msg=未开通 Coding Plan")).toBe("auth");
  });

  it("网络类：连接与超时措辞", () => {
    expect(classifyError("network down")).toBe("network");
    expect(classifyError("请求超时 timed-out")).toBe("network");
    expect(classifyError("connection refused")).toBe("network");
  });

  it("其余归为通用失败", () => {
    expect(classifyError("未能从 OpenCode Go 后台解析额度窗口")).toBe("generic");
    expect(classifyError("DeepSeek 暂无余额信息")).toBe("generic");
    expect(classifyError("Coding Plan 配额接口返回 HTTP 500")).toBe("generic");
  });
});

describe("errorHintTitle", () => {
  it("返回中文源文案 key", () => {
    expect(errorHintTitle("HTTP 401 Authentication Fails")).toBe("凭据无效或已过期");
    expect(errorHintTitle("network down")).toBe("网络连接失败");
    expect(errorHintTitle("解析失败")).toBe("获取用量失败");
  });
});
