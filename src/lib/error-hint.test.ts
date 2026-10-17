import { describe, expect, it } from "vitest";
import { classifyError, errorHintTitle } from "./error-hint";

describe("classifyError", () => {
  it("凭据类：HTTP 401/403 与登录/Cookie 措辞", () => {
    expect(
      classifyError(
        'DeepSeek 余额接口返回 HTTP {status}{detail}',
        { status: 401, detail: '{"message":"Authentication Fails"}' },
      ),
    ).toBe("auth");
    expect(classifyError("OpenCode Go API Key 无效或已过期")).toBe("auth");
    expect(classifyError("OpenCode 控制台返回 HTTP {status}", { status: 401 })).toBe("auth");
    expect(classifyError("该 API Key 未开通 OpenCode Go 订阅")).toBe("auth");
    expect(
      classifyError("Coding Plan 配额查询失败：{detail}", { detail: "code=403 msg=未开通 Coding Plan" }),
    ).toBe("auth");
  });

  it("网络类：连接与超时措辞", () => {
    expect(classifyError("network down")).toBe("network");
    expect(classifyError("请求超时 timed-out")).toBe("network");
    expect(classifyError("connection refused")).toBe("network");
  });

  it("其余归为通用失败（状态码在 params 中也参与匹配）", () => {
    expect(classifyError("OpenCode Go 用量接口返回结构无法解析")).toBe("generic");
    expect(classifyError("DeepSeek 暂无余额信息")).toBe("generic");
    expect(classifyError("参数无效")).toBe("generic");
    expect(classifyError("Coding Plan 配额接口返回 HTTP {status}", { status: 500 })).toBe("generic");
    expect(classifyError("DeepSeek 余额接口返回 HTTP {status}{detail}", { status: 401 })).toBe("auth");
  });
});

describe("errorHintTitle", () => {
  it("返回中文源文案 key", () => {
    expect(errorHintTitle("HTTP {status} Authentication Fails", { status: 401 })).toBe("凭据无效或已过期");
    expect(errorHintTitle("network down")).toBe("网络连接失败");
    expect(errorHintTitle("解析失败")).toBe("获取用量失败");
  });
});
