import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "../types/ipc";
import { extractMetric, parseMetricValue } from "./metric";

const snapshot = (lines: ProviderSnapshot["lines"]): ProviderSnapshot => ({
  instanceId: "p",
  providerId: "deepseek",
  providerName: "P",
  status: "ok",
  updatedAt: 0,
  lines,
});

describe("parseMetricValue", () => {
  it("解析货币字符串", () => {
    expect(parseMetricValue("¥1,234.56")).toBe(1234.56);
    expect(parseMetricValue("$12.3")).toBe(12.3);
  });

  it("解析负数与纯数字", () => {
    expect(parseMetricValue("-3.2")).toBe(-3.2);
    expect(parseMetricValue("42")).toBe(42);
  });

  it("无法解析返回 null", () => {
    expect(parseMetricValue("不可用")).toBeNull();
    expect(parseMetricValue("")).toBeNull();
    expect(parseMetricValue("¥")).toBeNull();
  });
});

describe("extractMetric", () => {
  it("OpenCode：取 resetsAt 最远的 progress 行（本月额度）", () => {
    const result = extractMetric(
      snapshot([
        { type: "progress", label: "5 小时额度", percentUsed: 40, resetsAt: "2026-08-30T18:00:00Z" },
        { type: "progress", label: "本周额度", percentUsed: 55, resetsAt: "2026-09-01T00:00:00Z" },
        { type: "progress", label: "本月额度", percentUsed: 72, resetsAt: "2026-09-30T00:00:00Z" },
      ]),
    );
    expect(result).toEqual({ value: 72, resetsAt: "2026-09-30T00:00:00Z" });
  });

  it("DeepSeek：取第一个可解析数值的 text 行（账户余额）", () => {
    const result = extractMetric(
      snapshot([
        { type: "badge", label: "可用状态", value: "可用" },
        { type: "text", label: "账户余额", value: "¥88.40" },
        { type: "text", label: "充值余额", value: "¥50.00" },
      ]),
    );
    expect(result).toEqual({ value: 88.4 });
  });

  it("resetsAt 缺失的窗口按结构化周期外推，不落空到短窗（主指标口径修正）", () => {
    // GLM 周窗无消耗时不下发 nextResetTime；按旧口径（空串=最近）主指标会错落到 5h 窗。
    // 5h 窗的重置时刻取过去值（parse < now 恒成立），周窗外推距离 = now + 7 天必然更远
    const result = extractMetric(
      snapshot([
        {
          type: "progress",
          label: "{hours} 小时请求配额",
          percentUsed: 20,
          resetsAt: "2020-01-01T00:00:00Z",
          windowPeriodMs: 5 * 3_600_000,
        },
        { type: "progress", label: "每周请求配额", percentUsed: 90, windowPeriodMs: 7 * 86_400_000 },
      ]),
    );
    expect(result?.value).toBe(90);
  });

  it("无可用行 → null", () => {
    expect(extractMetric(snapshot([]))).toBeNull();
    expect(extractMetric(snapshot([{ type: "badge", label: "状态", value: "错误" }]))).toBeNull();
  });
});
