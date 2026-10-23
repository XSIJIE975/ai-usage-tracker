/**
 * @vitest-environment jsdom
 *
 * 速览卡片：多窗口逐行展示、已用口径明示、重置挂各自窗口、状态行不被余额吞掉。
 * jsdom 不验实际像素截断；320px 的视觉验收走静态预览与真机复查。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GlanceCards } from "./GlanceCards";
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
  tightestResetsAt: undefined,
  lines: [
    { kind: "window", label: "5-hour quota", percent: 0, tightest: false },
    { kind: "window", label: "Weekly quota", percent: 7, tightest: true },
    { kind: "window", label: "Monthly quota", percent: 3, tightest: false },
  ],
};

function renderCards(items: GlanceInstance[], translate: (text: string) => string = (text) => text) {
  return render(
    <GlanceCards
      items={items}
      translate={translate}
      language="zh"
      resetDisplay="relative"
      now={NOW}
    />,
  );
}

afterEach(cleanup);

describe("GlanceCards", () => {
  it("每个额度窗口各占一行，并明示已用口径", () => {
    renderCards([item]);

    expect(screen.getByText("5-hour quota")).toBeTruthy();
    expect(screen.getByText("Weekly quota")).toBeTruthy();
    expect(screen.getByText("Monthly quota")).toBeTruthy();
    expect(screen.getAllByText("已用")).toHaveLength(3);
    expect(screen.getByText("0%")).toBeTruthy();
    expect(screen.getByText("7%")).toBeTruthy();
    expect(screen.getByText("3%")).toBeTruthy();
  });

  it("余额型实例只显示余额行，不渲染额度列表", () => {
    renderCards([
      {
        ...item,
        id: "i-2",
        tightestPercent: null,
        tightestLabel: null,
        lines: [{ kind: "balance", label: "账户余额", value: "¥12.34" }],
      },
    ]);

    expect(screen.getByText("账户余额")).toBeTruthy();
    expect(screen.getByText("¥12.34")).toBeTruthy();
    expect(screen.queryByText(/quota/)).toBeNull();
  });

  it("状态型实例显示状态文案，不渲染额度列表", () => {
    renderCards([
      {
        ...item,
        id: "i-3",
        status: "needs_config",
        tightestPercent: null,
        tightestLabel: null,
        lines: [],
      },
    ]);

    expect(screen.getByText("待配置")).toBeTruthy();
    expect(screen.queryByText(/quota/)).toBeNull();
  });

  it("重置挂在各自窗口行上，余额行不再兼任倒计时", () => {
    renderCards([
      {
        ...item,
        id: "i-4",
        tightestResetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString(),
        lines: [
          {
            kind: "window",
            label: "Weekly quota",
            percent: 7,
            resetsAt: new Date(NOW + 2.5 * 3_600_000).toISOString(),
            tightest: true,
          },
          { kind: "balance", label: "账户余额", value: "¥1.00" },
        ],
      },
    ]);

    expect(screen.getByText("2 小时 30 分钟后重置")).toBeTruthy();
    expect(screen.getByText("账户余额")).toBeTruthy();
    expect(screen.getByText("¥1.00")).toBeTruthy();
  });

  it("状态行与余额并存：未订阅不会被余额吞掉", () => {
    renderCards([
      {
        ...item,
        id: "i-5",
        tightestPercent: null,
        tightestLabel: null,
        lines: [
          { kind: "status", label: "Coding Plan", value: "未订阅" },
          { kind: "balance", label: "账户余额", value: "¥0.01" },
        ],
      },
    ]);

    expect(screen.getByText("未订阅")).toBeTruthy();
    expect(screen.getByText("¥0.01")).toBeTruthy();
  });

  it("99.6% 不显示成 100%（未耗尽前 100 留给真实耗尽）", () => {
    renderCards([
      {
        ...item,
        id: "i-6",
        tightestPercent: 99.6,
        tightestLabel: "Weekly quota",
        lines: [{ kind: "window", label: "Weekly quota", percent: 99.6, tightest: true }],
      },
    ]);

    expect(screen.getAllByText("99%").length).toBeGreaterThan(0);
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("英文界面把已用译成 Used", () => {
    renderCards(
      [
        {
          ...item,
          id: "i-7",
          lines: [{ kind: "window", label: "Weekly quota", percent: 7, tightest: true }],
        },
      ],
      (text) => (text === "已用" ? "Used" : text),
    );

    expect(screen.getByText("Used")).toBeTruthy();
    expect(screen.queryByText("已用")).toBeNull();
  });

  it("明细行展示池余量与到期", () => {
    renderCards([
      {
        ...item,
        id: "i-8",
        providerId: "workbuddy",
        tightestPercent: 2,
        tightestLabel: "积分额度",
        lines: [
          { kind: "window", label: "积分额度", percent: 2, tightest: true },
          { kind: "balance", label: "剩余积分", value: "6,106.51" },
          {
            kind: "detail",
            label: "月度套餐",
            value: "余 6,106.51 · 10月31日到期",
          },
        ],
      },
    ]);

    expect(screen.getByText("月度套餐")).toBeTruthy();
    expect(screen.getByText("余 6,106.51 · 10月31日到期")).toBeTruthy();
  });
});
