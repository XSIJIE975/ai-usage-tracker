/**
 * @vitest-environment jsdom
 *
 * 回归：智谱卡片翻到数值面后 Key 失效，快照转 error/needs_config、进度行消失，
 * canFlip 变 false（翻面按钮同时消失），但朝向状态仍留在 Dashboard 的 flippedIds
 * 或快速面板的 localFlipped 里。此时若继续把 flip-card-flipped 挂到已摘掉
 * flip-card/flip-inner 的普通卡上，整张卡会被 rotateY(180deg) 镜像，
 * 且用户没有入口翻回来。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import { ProviderCard } from "./ProviderCard";
import type { ProviderInstance, ProviderSnapshot } from "../types/ipc";

const instance: ProviderInstance = {
  id: "i-glm-test",
  providerId: "glm",
  note: "",
  sortOrder: 0,
  pinned: false,
  autoRefresh: false,
  threshold: null,
  balanceThreshold: null,
  site: "china",
  tokenAutoRenew: true,
  createdAt: 0,
};

const okSnapshot: ProviderSnapshot = {
  instanceId: instance.id,
  providerId: "glm",
  providerName: "智谱 GLM",
  status: "ok",
  updatedAt: 1_700_000_000_000,
  lines: [
    {
      type: "progress",
      label: "5 小时额度",
      percentUsed: 20,
      used: 100,
      limit: 500,
    },
  ],
};

const errorSnapshot: ProviderSnapshot = {
  instanceId: instance.id,
  providerId: "glm",
  providerName: "智谱 GLM",
  status: "error",
  updatedAt: 1_700_000_100_000,
  message: "Coding Plan 配额查询失败：HTTP 401",
  lines: [],
};

const needsConfigSnapshot: ProviderSnapshot = {
  instanceId: instance.id,
  providerId: "glm",
  providerName: "智谱 GLM",
  status: "needs_config",
  updatedAt: 1_700_000_100_000,
  message: "请在设置中填写智谱 Coding Plan API Key",
  lines: [],
};

/** 归一化后的卡片根：翻卡结构与朝向必须落在同一个元素上 */
const flippedCard = (container: HTMLElement) =>
  container.querySelector(".flip-card.flip-card-flipped");

const renderControlled = (snapshot: ProviderSnapshot | null) =>
  render(
    <ProviderCard
      instance={instance}
      snapshot={snapshot}
      flipped
      onToggleFlip={() => {}}
    />,
  );

afterEach(cleanup);

describe("ProviderCard 翻面", () => {
  it("可翻卡且处于数值面时，翻卡结构与朝向落在同一元素上", () => {
    const { container } = renderControlled(okSnapshot);

    expect(flippedCard(container)).not.toBeNull();
    expect(container.querySelectorAll(".flip-toggle")).toHaveLength(2);
  });

  it.each<[string, ProviderSnapshot | null]>([
    ["error", errorSnapshot],
    ["needs_config", needsConfigSnapshot],
    ["null", null],
  ])("受控路径：快照转为 %s 后不得让整卡镜像", (_label, nextSnapshot) => {
    const { container, rerender } = renderControlled(okSnapshot);
    expect(flippedCard(container)).not.toBeNull();

    rerender(
      <ProviderCard
        instance={instance}
        snapshot={nextSnapshot}
        flipped
        onToggleFlip={() => {}}
      />,
    );

    // flip-card 已随 canFlip=false 摘掉，flip-card-flipped 与翻面按钮必须一并消失；
    // 只剩单枚 flipped 类时整卡会被镜像且没有入口可恢复。
    expect(container.querySelector(".flip-card")).toBeNull();
    expect(container.querySelector(".flip-card-flipped")).toBeNull();
    expect(container.querySelector(".flip-toggle")).toBeNull();
  });

  it("受控路径：数据恢复后保留原始朝向，回到数值面", () => {
    const { container, rerender } = renderControlled(okSnapshot);

    rerender(
      <ProviderCard
        instance={instance}
        snapshot={errorSnapshot}
        flipped
        onToggleFlip={() => {}}
      />,
    );
    expect(flippedCard(container)).toBeNull();

    rerender(
      <ProviderCard
        instance={instance}
        snapshot={okSnapshot}
        flipped
        onToggleFlip={() => {}}
      />,
    );
    expect(flippedCard(container)).not.toBeNull();
  });

  it("非受控路径（快速面板）：失效屏蔽镜像，恢复后仍回到数值面", () => {
    const { container, rerender } = render(
      <ProviderCard instance={instance} snapshot={okSnapshot} />,
    );
    const frontToggle = container.querySelector<HTMLButtonElement>(
      ".flip-toggle:not(.flip-toggle-back)",
    );
    expect(frontToggle).not.toBeNull();

    fireEvent.click(frontToggle!);
    expect(flippedCard(container)).not.toBeNull();

    rerender(<ProviderCard instance={instance} snapshot={errorSnapshot} />);
    expect(container.querySelector(".flip-card")).toBeNull();
    expect(container.querySelector(".flip-card-flipped")).toBeNull();
    expect(container.querySelector(".flip-toggle")).toBeNull();

    rerender(<ProviderCard instance={instance} snapshot={okSnapshot} />);
    expect(flippedCard(container)).not.toBeNull();
  });
});
