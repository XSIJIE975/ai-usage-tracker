/**
 * @vitest-environment jsdom
 *
 * 速览卡片的多窗口明细必须逐行完整展示：面板只有 320px 宽，
 * 英文标签并排一行会被截断（回归：Monthly quota 只剩 "M…"）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GlanceCards } from "./GlanceCards";
import type { GlanceInstance } from "./data";

const item: GlanceInstance = {
  id: "i-1",
  providerId: "opencode-go",
  site: "china",
  label: "OpenCode Go",
  status: "ok",
  refreshing: false,
  alertActive: false,
  primaryPercent: 7,
  primaryLabel: "Weekly quota",
  primaryResetsAt: undefined,
  windows: [
    { label: "5-hour quota", percent: 0, primary: false },
    { label: "Weekly quota", percent: 7, primary: true },
    { label: "Monthly quota", percent: 3, primary: false },
  ],
  balanceText: null,
  neutralText: null,
};

afterEach(cleanup);

describe("GlanceCards", () => {
  it("每个额度窗口各占一行，英文标签不被截断", () => {
    render(<GlanceCards items={[item]} translate={(text) => text} />);

    expect(screen.getByText("5-hour quota 0%")).toBeTruthy();
    expect(screen.getByText("Weekly quota 7%")).toBeTruthy();
    expect(screen.getByText("Monthly quota 3%")).toBeTruthy();
  });

  it("余额型实例只显示余额行，不渲染额度列表", () => {
    render(
      <GlanceCards
        items={[
          {
            ...item,
            id: "i-2",
            primaryPercent: null,
            primaryLabel: null,
            windows: [],
            balanceText: "¥12.34",
          },
        ]}
        translate={(text) => text}
      />,
    );

    expect(screen.getByText("¥12.34")).toBeTruthy();
    expect(screen.queryByText(/quota/)).toBeNull();
  });

  it("状态型实例显示状态文案，不渲染额度列表", () => {
    render(
      <GlanceCards
        items={[
          {
            ...item,
            id: "i-3",
            status: "needs_config",
            primaryPercent: null,
            primaryLabel: null,
            windows: [],
            balanceText: null,
            neutralText: null,
          },
        ]}
        translate={(text) => text}
      />,
    );

    expect(screen.getByText("待配置")).toBeTruthy();
    expect(screen.queryByText(/quota/)).toBeNull();
  });

  it("余额与重置时间同现时分别落在左右两侧", () => {
    render(
      <GlanceCards
        items={[
          {
            ...item,
            id: "i-4",
            balanceText: "¥1.00",
            primaryResetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          },
        ]}
        translate={(text) => text}
      />,
    );

    expect(screen.getByText("账户余额 ¥1.00")).toBeTruthy();
    expect(screen.getByText(/后重置/)).toBeTruthy();
  });
});
