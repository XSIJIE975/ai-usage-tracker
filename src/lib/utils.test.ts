import { describe, expect, it } from "vitest";
import { formatRefreshLabel, formatReset, normalizeOpenCodeAuthCookie } from "./utils";

describe("normalizeOpenCodeAuthCookie", () => {
  it("keeps a bare cookie value", () => {
    expect(normalizeOpenCodeAuthCookie(" abc ")).toBe("abc");
  });

  it("strips an auth= prefix", () => {
    expect(normalizeOpenCodeAuthCookie("auth=abc")).toBe("abc");
    expect(normalizeOpenCodeAuthCookie("AUTH=abc")).toBe("abc");
  });

  it("strips a Cookie header prefix", () => {
    expect(normalizeOpenCodeAuthCookie("Cookie: auth=abc")).toBe("abc");
  });

  it("extracts the auth cookie from a full cookie list", () => {
    expect(normalizeOpenCodeAuthCookie("foo=1; auth=abc; bar=2")).toBe("abc");
  });
});

describe("formatRefreshLabel", () => {
  it("formats minutes and hours", () => {
    expect(formatRefreshLabel(0)).toBe("已禁用");
    expect(formatRefreshLabel(45)).toBe("45 分钟");
    expect(formatRefreshLabel(60)).toBe("1 小时");
    expect(formatRefreshLabel(90)).toBe("1.5 小时");
    expect(formatRefreshLabel(120)).toBe("2 小时");
  });
});

describe("formatReset", () => {
  const now = new Date("2026-08-06T09:00:00.000Z").getTime();

  it("shows precise countdowns matching the OpenCode Go dashboard", () => {
    expect(formatReset(new Date(now + 104 * 60_000).toISOString(), now)).toBe("1 小时 44 分钟后重置");
    expect(formatReset(new Date(now + (3 * 86_400 + 2 * 3_600) * 1000).toISOString(), now)).toBe(
      "3 天 2 小时后重置",
    );
    expect(formatReset(new Date(now + (26 * 86_400 + 17 * 3_600) * 1000).toISOString(), now)).toBe(
      "26 天 17 小时后重置",
    );
  });

  it("handles zero and missing reset times", () => {
    expect(formatReset(new Date(now - 1).toISOString(), now)).toBe("即将重置");
    expect(formatReset(undefined, now)).toBe("重置时间未知");
    expect(formatReset("invalid-date", now)).toBe("重置时间未知");
  });
});
