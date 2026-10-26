import { describe, expect, it } from "vitest";

import { resolveChangelogPrompt, type ChangelogEntry } from "./changelog";

const entries: ChangelogEntry[] = [
  { version: "0.5.0", date: "2026-10-20", notes: "五" },
  { version: "0.4.0", date: "2026-10-15", notes: "四" },
  { version: "0.3.0", date: "2026-10-10", notes: "三" },
  { version: "0.2.0", date: "2026-10-05", notes: "二" },
  { version: "0.1.0", date: "2026-10-01", notes: "一" },
];

describe("resolveChangelogPrompt", () => {
  it("跨版本升级聚合区间内全部条目（0.1.0 → 0.5.0）", () => {
    const result = resolveChangelogPrompt("0.1.0", "0.5.0", entries);
    expect(result.map((entry) => entry.version)).toEqual(["0.5.0", "0.4.0", "0.3.0", "0.2.0"]);
  });

  it("常规单版本升级只含新版本", () => {
    const result = resolveChangelogPrompt("0.4.0", "0.5.0", entries);
    expect(result.map((entry) => entry.version)).toEqual(["0.5.0"]);
  });

  it("首次安装（seen=null）不弹", () => {
    expect(resolveChangelogPrompt(null, "0.5.0", entries)).toEqual([]);
  });

  it("同版本（未升级）不弹", () => {
    expect(resolveChangelogPrompt("0.5.0", "0.5.0", entries)).toEqual([]);
  });

  it("降级（seen 高于 current）不弹", () => {
    expect(resolveChangelogPrompt("0.5.0", "0.3.0", entries)).toEqual([]);
  });

  it("seen 不在日志里也按数值区间过滤（旧版本早于日志起点）", () => {
    const result = resolveChangelogPrompt("0.0.9", "0.2.0", entries);
    expect(result.map((entry) => entry.version)).toEqual(["0.2.0", "0.1.0"]);
  });
});
