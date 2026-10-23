/**
 * @vitest-environment jsdom
 *
 * 紧凑行列表与迷你卡片必须看到同一组事实：最紧窗大号读数 + 其余窗口逐行、
 * 各自重置、余额/明细/状态行。最紧窗不再重复一行，避免同一个百分比出现两次。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GlanceRows } from "./GlanceRows";
import type { GlanceInstance } from "./data";

const NOW = Date.parse("2026-10-23T00:00:00.000Z");

const item: GlanceInstance = {
  id: "i-1",
  providerId: "opencode-go",
  site: "china",
  label: "OpenCode Go",
  status: "ok",
  refreshing: false,
  alertActive: false,
  tightestPercent: 7,
  tightestLabel: "Weekly quota",
  tightestResetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString(),
  lines: [
    {
      kind: "window",
      label: "5-hour quota",
      percent: 0,
      resetsAt: new Date(NOW + 3_600_000).toISOString(),
      tightest: false,
    },
    {
      kind: "window",
      label: "Weekly quota",
      percent: 7,
      resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString(),
      tightest: true,
    },
    { kind: "window", label: "Monthly quota", percent: 3, tightest: false },
  ],
};

function renderRows(items: GlanceInstance[], translate: (text: string) => string = (text) => text) {
  return render(
    <GlanceRows
      items={items}
      translate={translate}
      language="zh"
      resetDisplay="relative"
      now={NOW}
    />,
  );
}

afterEach(cleanup);

describe("GlanceRows", () => {
  it("大号读数是已用的最紧窗，最紧窗不重复一行，其余窗口逐行", () => {
    renderRows([item]);

    expect(screen.getAllByText("已用")).toHaveLength(3);
    expect(screen.getByText("7%")).toBeTruthy();
    // 最紧窗的标签只出现在大号读数下方；其余窗口各一行
    expect(screen.getAllByText("Weekly quota")).toHaveLength(1);
    expect(screen.getAllByText("5-hour quota")).toHaveLength(1);
    expect(screen.getAllByText("Monthly quota")).toHaveLength(1);
  });

  it("每行带各自的重置：最紧窗在读数下，副窗在行尾", () => {
    renderRows([item]);

    expect(screen.getByText("2 小时 30 分钟后重置")).toBeTruthy();
    expect(screen.getByText("1 小时后重置")).toBeTruthy();
  });

  it("余额型实例：金额行与钱包提示都在，不重复金额", () => {
    renderRows([
      {
        ...item,
        id: "i-2",
        tightestPercent: null,
        tightestLabel: null,
        tightestResetsAt: undefined,
        lines: [{ kind: "balance", label: "账户余额", value: "¥12.34" }],
      },
    ]);

    expect(screen.getByText("账户余额")).toBeTruthy();
    expect(screen.getByText("¥12.34")).toBeTruthy();
    expect(screen.getByLabelText("账户余额")).toBeTruthy();
  });

  it("状态行与余额并存", () => {
    renderRows([
      {
        ...item,
        id: "i-3",
        tightestPercent: null,
        tightestLabel: null,
        tightestResetsAt: undefined,
        lines: [
          { kind: "status", label: "Token Plan", value: "已过期" },
          { kind: "balance", label: "账户余额", value: "¥0.00" },
        ],
      },
    ]);

    expect(screen.getByText("已过期")).toBeTruthy();
    expect(screen.getByText("¥0.00")).toBeTruthy();
  });

  it("99.6% 的大号读数显示 99%", () => {
    renderRows([
      {
        ...item,
        id: "i-4",
        tightestPercent: 99.6,
        tightestResetsAt: undefined,
        lines: [{ kind: "window", label: "Weekly quota", percent: 99.6, tightest: true }],
      },
    ]);

    expect(screen.getByText("99%")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("英文界面把已用译成 Used", () => {
    renderRows([item], (text) => (text === "已用" ? "Used" : text));

    expect(screen.getAllByText("Used").length).toBeGreaterThan(0);
  });
});
