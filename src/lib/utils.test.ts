import { describe, expect, it } from "vitest";
import {
  dayOffsetMs,
  daySpan,
  escapeHtml,
  formatHoursLabel,
  formatRefreshLabel,
  formatReset,
  formatResetAt,
  hasOpenCodeConsoleSession,
  isValidOpenCodeCookieHeader,
  MAX_OPENCODE_COOKIE_HEADER_LENGTH,
  normalizeOpenCodeAuthCookie,
} from "./utils";
import { translateText } from "../i18n/translate";

/** 走真实英文字典，而不是测试里另抄一份英文 —— 键改了这边就会红 */
const tEn = (text: string) => translateText(text, "en");

describe("normalizeOpenCodeAuthCookie", () => {
  it("treats a bare value as the console session by default", () => {
    expect(normalizeOpenCodeAuthCookie(" abc ")).toBe("__Host-console_session=abc");
    expect(normalizeOpenCodeAuthCookie("st_TEST-session-0000")).toBe(
      "__Host-console_session=st_TEST-session-0000",
    );
    // base64 padding 不应让裸值被误判成整段 Cookie 头
    expect(normalizeOpenCodeAuthCookie("st_TEST-session-0000==")).toBe(
      "__Host-console_session=st_TEST-session-0000==",
    );
    expect(normalizeOpenCodeAuthCookie("Fe26.2**abc==")).toBe("auth=Fe26.2**abc==");
  });

  it("treats a bare Iron Session value as the legacy auth cookie", () => {
    expect(normalizeOpenCodeAuthCookie("Fe26.2**abc")).toBe("auth=Fe26.2**abc");
  });

  it("keeps auth= with a canonical name", () => {
    expect(normalizeOpenCodeAuthCookie("auth=abc")).toBe("auth=abc");
    expect(normalizeOpenCodeAuthCookie("AUTH=abc")).toBe("auth=abc");
  });

  it("strips a Cookie header prefix", () => {
    expect(normalizeOpenCodeAuthCookie("Cookie: auth=abc")).toBe("auth=abc");
  });

  it("keeps only OpenCode's own cookies from a full header", () => {
    expect(normalizeOpenCodeAuthCookie("foo=1; auth=abc; bar=2")).toBe("auth=abc");
    expect(
      normalizeOpenCodeAuthCookie(
        "auth=abc; __Host-console_session=def; oc_locale=zh",
      ),
    ).toBe("auth=abc; __Host-console_session=def");
    expect(normalizeOpenCodeAuthCookie("__Host-console_session=def")).toBe(
      "__Host-console_session=def",
    );
  });

  it("rejects a header without a recognized cookie or with header injection", () => {
    expect(normalizeOpenCodeAuthCookie("foo=1")).toBe("");
    expect(normalizeOpenCodeAuthCookie("auth=abc\r\nX-Injected: 1")).toBe("");
    expect(normalizeOpenCodeAuthCookie("auth=abc def")).toBe("");
    // Rust 侧对空值直接报错，TS 不能放行
    expect(normalizeOpenCodeAuthCookie("auth=; __Host-console_session=def")).toBe("");
    expect(normalizeOpenCodeAuthCookie("__Host-console_session=")).toBe("");
    // 与 Rust 的 8 KiB 上限对齐
    expect(
      normalizeOpenCodeAuthCookie(`auth=${"a".repeat(MAX_OPENCODE_COOKIE_HEADER_LENGTH)}`),
    ).toBe("");
  });
});

describe("isValidOpenCodeCookieHeader", () => {
  it("accepts any recognized cookie, including the legacy auth value", () => {
    expect(isValidOpenCodeCookieHeader("__Host-console_session=def")).toBe(true);
    expect(isValidOpenCodeCookieHeader("auth=abc; __Host-console_session=def")).toBe(true);
    // 旧实例只存了 auth：仍要能保存（余额/日志另由 hasOpenCodeConsoleSession 判定）
    expect(isValidOpenCodeCookieHeader("auth=abc")).toBe(true);
    expect(isValidOpenCodeCookieHeader("__Host-auth=abc")).toBe(true);
  });

  it("rejects empty, unknown-only, injected, or overlong headers", () => {
    expect(isValidOpenCodeCookieHeader("")).toBe(false);
    expect(isValidOpenCodeCookieHeader("foo=1")).toBe(false);
    expect(isValidOpenCodeCookieHeader("__Host-console_session=def\r\nX-Injected: 1")).toBe(false);
    expect(isValidOpenCodeCookieHeader("__Host-console_session=")).toBe(false);
    expect(isValidOpenCodeCookieHeader("auth=abc def")).toBe(false);
    // 任一可识别键为空即整条非法（与 Rust 同口径，不能靠另一个好键放行）
    expect(isValidOpenCodeCookieHeader("auth=; __Host-console_session=def")).toBe(false);
    expect(isValidOpenCodeCookieHeader("auth=abc; __Host-console_session=")).toBe(false);
    expect(
      isValidOpenCodeCookieHeader(`auth=${"a".repeat(MAX_OPENCODE_COOKIE_HEADER_LENGTH)}`),
    ).toBe(false);
  });
});

describe("hasOpenCodeConsoleSession", () => {
  it("only reports true when __Host-console_session is present and non-empty", () => {
    expect(hasOpenCodeConsoleSession("__Host-console_session=def")).toBe(true);
    expect(hasOpenCodeConsoleSession("auth=abc; __Host-console_session=def")).toBe(true);
    expect(hasOpenCodeConsoleSession("auth=abc")).toBe(false);
    expect(hasOpenCodeConsoleSession("__Host-console_session=")).toBe(false);
    expect(hasOpenCodeConsoleSession("")).toBe(false);
  });
});

describe("escapeHtml", () => {
  it("转义 ECharts tooltip（innerHTML 落点）会解释的字符", () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(escapeHtml('a & b "c" \'d\'')).toBe("a &amp; b &quot;c&quot; &#39;d&#39;");
    expect(escapeHtml("GLM-5.2")).toBe("GLM-5.2");
  });
});

describe("dayOffsetMs / daySpan", () => {
  const midnight = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

  it("按日历日推进，跨月跨年都落在目标日的本地零点", () => {
    expect(dayOffsetMs(midnight(2026, 12, 31), 1)).toBe(midnight(2027, 1, 1));
    expect(dayOffsetMs(midnight(2026, 3, 1), -1)).toBe(midnight(2026, 2, 28));
    expect(dayOffsetMs(midnight(2024, 2, 28), 1)).toBe(midnight(2024, 2, 29));
    // 入参带时分秒时先归到当日零点，不会把时间部分带进结果
    expect(dayOffsetMs(new Date(2026, 5, 23, 14, 14, 3), 0)).toBe(midnight(2026, 6, 23));
  });

  it("daySpan 把夏令时的 ±1 小时抹平成整天数", () => {
    expect(daySpan(midnight(2026, 6, 23), midnight(2026, 7, 23))).toBe(30);
    expect(daySpan(midnight(2026, 6, 23), midnight(2026, 6, 23) + 23 * 3_600_000)).toBe(1);
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

  it("英文间隔标签用缩写单位（「1 hours」是错的）", () => {
    expect(formatRefreshLabel(30, tEn)).toBe("30 min");
    expect(formatRefreshLabel(60, tEn)).toBe("1 h");
    expect(formatRefreshLabel(90, tEn)).toBe("1.5 h");
    expect(formatHoursLabel(1, tEn)).toBe("1 h");
    expect(formatRefreshLabel(0, tEn)).toBe("Disabled");
  });
});

describe("formatReset", () => {
  const now = new Date("2026-08-06T09:00:00.000Z").getTime();

  it("shows the same current-minute countdown as the OpenCode Go dashboard", () => {
    expect(formatReset(new Date(now + 104 * 60_000).toISOString(), now)).toBe("1 小时 44 分钟后重置");
    expect(formatReset(new Date(now + 104 * 60_000 + 59_000).toISOString(), now)).toBe(
      "1 小时 44 分钟后重置",
    );
    expect(formatReset(new Date(now + (3 * 86_400 + 2 * 3_600) * 1000).toISOString(), now)).toBe(
      "3 天 2 小时后重置",
    );
    expect(
      formatReset(new Date(now + (3 * 86_400 + 2 * 3_600 + 59) * 1000).toISOString(), now),
    ).toBe("3 天 2 小时后重置");
    expect(formatReset(new Date(now + (26 * 86_400 + 17 * 3_600) * 1000).toISOString(), now)).toBe(
      "26 天 17 小时后重置",
    );
    expect(
      formatReset(new Date(now + (26 * 86_400 + 17 * 3_600 + 59 * 60) * 1000).toISOString(), now),
    ).toBe("26 天 17 小时后重置");
  });

  it("英文口径不出现 1 days 这种单复数错误（缩写单位 + 整串模板）", () => {
    expect(formatReset(new Date(now + 40 * 3_600_000).toISOString(), now, tEn)).toBe("1d 16h to reset");
    expect(formatReset(new Date(now + 2 * 86_400_000).toISOString(), now, tEn)).toBe("2d to reset");
    expect(formatReset(new Date(now + 104 * 60_000).toISOString(), now, tEn)).toBe("1h 44min to reset");
    expect(formatReset(new Date(now + 45 * 60_000).toISOString(), now, tEn)).toBe("45min to reset");
    expect(formatReset(new Date(now - 1).toISOString(), now, tEn)).toBe("Resets soon");
  });

  it("handles zero and missing reset times", () => {
    expect(formatReset(new Date(now - 1).toISOString(), now)).toBe("即将重置");
    expect(formatReset(undefined, now)).toBe("重置时间未知");
    expect(formatReset("invalid-date", now)).toBe("重置时间未知");
  });
});

describe("formatResetAt", () => {
  // 用本地时间构造输入，断言与本地时区无关
  const local = new Date(2026, 8, 8, 14, 30);

  it("中文输出 M/D HH:mm（24 小时制）", () => {
    expect(formatResetAt(local.toISOString(), "zh")).toBe("9/8 14:30");
  });

  it("英文输出 12 小时制", () => {
    expect(formatResetAt(local.toISOString(), "en")).toBe("9/8, 02:30 PM");
  });

  it("无效输入返回占位符", () => {
    expect(formatResetAt("invalid-date", "zh")).toBe("-");
  });
});
