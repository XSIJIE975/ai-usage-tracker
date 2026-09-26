/**
 * @vitest-environment jsdom
 *
 * 校验接线的组件级验证：schema 单测只证明规则本身，这里证明「规则 → resolver →
 * 字段红字 → 提交被挡住 → 焦点落到第一个错误字段」这条链在真实弹窗上是通的。
 * WorkBuddy 是唯一「三格全必填 + 成组探测」的种类，拿它当样本覆盖面最大。
 */
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { InstanceDialog } from "./InstanceDialog";
import { providerFormSpecs } from "../../forms/form-specs";
import { useAppStore } from "../../store/useAppStore";
import type { ProviderInstance, ProviderKind } from "../../types/ipc";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(),
  // 凭据加载钩子会把 listen() 的返回值当 unlisten 调用，返回 undefined 会在卸载时炸
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const field = (slot: string) => document.getElementById(`slot-${slot}`) as HTMLInputElement;

/** 三格合法值：UA 里带空格是允许的，Cookie 格不允许 */
const VALID = {
  session: "abcdefghijklmnop",
  session2: "qrstuvwxyz012345",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
};

function fill(slot: string, value: string) {
  fireEvent.change(field(slot), { target: { value } });
}

async function save() {
  fireEvent.click(screen.getByRole("button", { name: /保存/ }));
}

/**
 * 打开弹窗并等 Radix 的入场自动聚焦落定：它延迟到入场动画之后触发，
 * 不等就会和「提交失败聚焦首个错误字段」互相抢焦点，测出来的是竞态而不是行为。
 */
async function openDialog() {
  render(<InstanceDialog open onOpenChange={vi.fn()} instance={null} providerId="workbuddy" />);
  await waitFor(() => expect(document.activeElement?.id).toBe("instance-note"));
}

describe("新建 WorkBuddy 实例的必填校验", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("空表单点保存：三格都报必填，且不会提交", async () => {
    const addInstance = vi.fn();
    useAppStore.setState({ addInstance, refreshInstance: vi.fn() });
    await openDialog();

    // 断言「我们把焦点交给了第一个错误字段」而不是「焦点停在那儿」：Radix 的焦点陷阱
    // 靠 composedPath 判断是否越界，jsdom 这块支持不全，会把焦点又抢回首元素——
    // 真实浏览器里没有这次回抢，断 activeElement 测到的是 jsdom 的缺陷。
    const focused: string[] = [];
    const originalFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      focused.push(this.id);
      return originalFocus.apply(this, args as []);
    };

    try {
      await save();

      for (const slot of ["session", "session2", "userAgent"]) {
        await waitFor(() => expect(field(slot).getAttribute("aria-invalid")).toBe("true"));
      }
      expect(screen.getAllByText("该项为必填")).toHaveLength(3);
      expect(addInstance).not.toHaveBeenCalled();
      // 焦点交给视觉顺序上的第一个错误字段，不用用户自己找
      expect(focused).toEqual(["slot-session"]);
    } finally {
      HTMLElement.prototype.focus = originalFocus;
    }
  });

  it("补齐三格后错误消失并可提交，且提交的正是这三格", async () => {
    const addInstance = vi.fn().mockResolvedValue({ id: "new-1" });
    useAppStore.setState({ addInstance, refreshInstance: vi.fn() });
    await openDialog();

    await save();
    expect(await screen.findAllByText("该项为必填")).toHaveLength(3);

    fill("session", VALID.session);
    fill("session2", VALID.session2);
    fill("userAgent", VALID.userAgent);
    await save();

    await waitFor(() => expect(addInstance).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("该项为必填")).toBeNull();
    const [kind, note, credentials] = addInstance.mock.calls[0];
    expect(kind).toBe("workbuddy");
    expect(note).toBe("");
    expect(Object.keys(credentials).sort()).toEqual(["session", "session2", "userAgent"]);
  });

  it("Cookie 格混进空格：报格式错误并挡住提交，而不是存进去等网关 401", async () => {
    const addInstance = vi.fn();
    useAppStore.setState({ addInstance, refreshInstance: vi.fn() });
    await openDialog();

    fill("session", "abc def");
    fill("session2", VALID.session2);
    fill("userAgent", VALID.userAgent);
    await save();

    expect(
      await screen.findByText(
        "只粘贴该 Cookie 的值：不要带键名或「Cookie:」前缀，也不能包含分号、空格、换行或中文",
      ),
    ).toBeTruthy();
    expect(addInstance).not.toHaveBeenCalled();
  });

  it("阈值超出范围：报错而不是被静默 clamp 成 1", async () => {
    const addInstance = vi.fn();
    useAppStore.setState({ addInstance, refreshInstance: vi.fn() });
    await openDialog();

    fill("session", VALID.session);
    fill("session2", VALID.session2);
    fill("userAgent", VALID.userAgent);
    fireEvent.change(document.getElementById("instance-threshold") as HTMLInputElement, {
      target: { value: "0" },
    });
    await save();

    expect(await screen.findByText("阈值需在 1–100 之间")).toBeTruthy();
    expect(addInstance).not.toHaveBeenCalled();
  });
});

describe("编辑已有实例：表单值就是事实源", () => {
  const WORKBUDDY_STORED = {
    session: "storedsessionvalue1",
    session2: "storedsessionvalue2",
    userAgent: "Mozilla/5.0 (Windows NT 10.0)",
  };

  afterEach(() => {
    // 必须清：字段 id 是固定的（slot-session 等），上一颗弹窗留在 document 里会让查询命中旧节点
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * 搭一个假的凭据库：invoke 读它、saveInstanceCredentials 写它，
   * 这样才能断言「保存到底往库里写了什么」——本次修复的核心就在这件事上。
   */
  function harness(kind: ProviderKind, stored: Record<string, string>) {
    const vault: Record<string, string> = { ...stored };
    const saveCredentials = vi.fn(async (_id: string, credentials: Record<string, string | null>) => {
      for (const [slot, value] of Object.entries(credentials)) {
        if (value === null) delete vault[slot];
        else vault[slot] = value;
      }
    });
    const updateInstance = vi.fn();
    (invoke as unknown as Mock).mockImplementation(async (command: string) => {
      if (command === "vault_credentials") return { ...vault };
      if (command === "vault_credential_status") {
        return Object.fromEntries(
          providerFormSpecs[kind].fields.map((field) => [field.slot, Boolean(vault[field.slot])]),
        );
      }
      return undefined;
    });
    const instance: ProviderInstance = {
      id: "i-1",
      providerId: kind,
      note: "公司主账号",
      sortOrder: 0,
      pinned: false,
      autoRefresh: true,
      threshold: null,
      balanceThreshold: null,
      site: "china",
      createdAt: 0,
    };
    useAppStore.setState({
      vaultStatus: { initialized: true, unlocked: true, needsMigration: false, keychainLost: false },
      saveInstanceCredentials: saveCredentials,
      updateInstance,
      reloadInstances: vi.fn(),
      refreshInstance: vi.fn(),
    });
    return { vault, saveCredentials, updateInstance, instance };
  }

  async function openEditor(instance: ProviderInstance) {
    render(
      <InstanceDialog
        open
        onOpenChange={vi.fn()}
        instance={instance}
        providerId={instance.providerId}
      />,
    );
    const first = providerFormSpecs[instance.providerId].fields[0].slot;
    // 等凭据明文回填到位：没回填就断言，测的是加载竞态而不是表单行为
    await waitFor(() => expect(field(first).value).not.toBe(""));
  }

  it("不动凭据直接保存：不产生任何凭据写入", async () => {
    const h = harness("workbuddy", WORKBUDDY_STORED);
    await openEditor(h.instance);

    await save();

    await waitFor(() => expect(h.updateInstance).toHaveBeenCalledTimes(1));
    expect(h.saveCredentials).not.toHaveBeenCalled();
    expect(screen.queryByText("该项为必填")).toBeNull();
  });

  it("手动把必填格删空再保存：报必填并挡住，不会让库里的旧值悄悄回来", async () => {
    const h = harness("workbuddy", WORKBUDDY_STORED);
    await openEditor(h.instance);

    fill("session", "");
    await save();

    expect(await screen.findByText("该项为必填")).toBeTruthy();
    expect(h.updateInstance).not.toHaveBeenCalled();
    expect(h.saveCredentials).not.toHaveBeenCalled();
    expect(h.vault.session).toBe(WORKBUDDY_STORED.session);
  });

  it("点「清除」只清输入框：不写库，保存前什么都还没丢", async () => {
    const h = harness("workbuddy", WORKBUDDY_STORED);
    await openEditor(h.instance);

    fireEvent.click(field("session").closest("div")?.querySelector('[aria-label="清除"]') as Element);

    await waitFor(() => expect(field("session").value).toBe(""));
    expect(h.saveCredentials).not.toHaveBeenCalled();
    expect(h.vault.session).toBe(WORKBUDDY_STORED.session);

    // 必填格空着不让保存——想真的删掉这项凭据，得走删除实例
    await save();
    expect(await screen.findByText("该项为必填")).toBeTruthy();
    expect(h.updateInstance).not.toHaveBeenCalled();
  });

  it("选填格点「清除」后保存：按 null 写回，真的清掉（以前删不掉）", async () => {
    const h = harness("opencode-go", {
      workspaceId: "wrk_abcdef",
      cookie: "abcdefghij",
      apiKey: "sk-official-key",
    });
    await openEditor(h.instance);

    fireEvent.click(field("apiKey").closest("div")?.querySelector('[aria-label="清除"]') as Element);
    await waitFor(() => expect(field("apiKey").value).toBe(""));

    await save();

    await waitFor(() => expect(h.saveCredentials).toHaveBeenCalledTimes(1));
    // 只发变化的那一格：回填进去又原样保存的格子不该被重写
    expect(h.saveCredentials.mock.calls[0][1]).toEqual({ apiKey: null });
    expect(h.vault.apiKey).toBeUndefined();
    expect(h.vault.workspaceId).toBe("wrk_abcdef");
  });
});
