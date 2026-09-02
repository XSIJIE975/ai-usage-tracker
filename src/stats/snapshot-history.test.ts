import { describe, expect, it } from "vitest";
import type { ProviderSnapshot } from "../types/ipc";
import {
  downsampleByHour,
  extractMetric,
  parseMetricValue,
  type MetricPoint,
} from "./snapshot-history";

const HOUR = 3_600_000;

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

  it("无可用行 → null", () => {
    expect(extractMetric(snapshot([]))).toBeNull();
    expect(extractMetric(snapshot([{ type: "badge", label: "状态", value: "错误" }]))).toBeNull();
  });
});

describe("downsampleByHour", () => {
  it("同一小时保留最后一个点", () => {
    const base = 1_700_000_000_000;
    const points: MetricPoint[] = [
      { t: base, v: 1 },
      { t: base + HOUR / 2, v: 2 },
      { t: base + HOUR, v: 3 },
    ];
    expect(downsampleByHour(points)).toEqual([
      { t: base + HOUR / 2, v: 2 },
      { t: base + HOUR, v: 3 },
    ]);
  });

  it("乱序输入输出仍按时间升序", () => {
    const base = 1_700_000_000_000;
    const points: MetricPoint[] = [
      { t: base + 2 * HOUR, v: 3 },
      { t: base, v: 1 },
    ];
    expect(downsampleByHour(points)).toEqual([
      { t: base, v: 1 },
      { t: base + 2 * HOUR, v: 3 },
    ]);
  });
});
