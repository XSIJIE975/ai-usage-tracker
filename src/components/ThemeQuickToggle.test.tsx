/**
 * @vitest-environment jsdom
 *
 * 头部主题快捷按钮：图标显示当前模式，点击按三态循环，
 * 无障碍名称同时说出当前态与下一态。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeQuickToggle } from "./ThemeQuickToggle";

afterEach(cleanup);

describe("ThemeQuickToggle", () => {
  it("当前模式与下一态都写进 title / 无障碍名称", () => {
    render(<ThemeQuickToggle mode="system" onChange={() => undefined} />);

    const button = screen.getByRole("button", { name: /跟随系统.*浅色/ });
    expect(button.getAttribute("title")).toBe("主题：跟随系统，点击切换到浅色");
  });

  it("点击按 跟随系统 → 浅色 → 深色 → 跟随系统 回调", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ThemeQuickToggle mode="system" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith("light");

    rerender(<ThemeQuickToggle mode="light" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith("dark");

    rerender(<ThemeQuickToggle mode="dark" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onChange).toHaveBeenLastCalledWith("system");
  });
});
