/**
 * @vitest-environment jsdom
 *
 * 只此一个文件跑在 jsdom 下：项目其余测试都是纯逻辑，不需要 DOM，
 * 因此不改全局测试环境（见 ADR-0028）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { NotesErrorBoundary, ReleaseNotes, safeUrl } from "./ReleaseNotes";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

const mockedOpenUrl = vi.mocked(openUrl);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("safeUrl", () => {
  it("放行 http/https", () => {
    expect(safeUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
  });

  it("挡掉危险协议", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("JavaScript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(safeUrl("vbscript:msgbox(1)")).toBe("");
  });

  it("收掉库默认放行、但在桌面应用里没有意义的协议", () => {
    expect(safeUrl("mailto:someone@example.com")).toBe("");
    expect(safeUrl("irc://example.com")).toBe("");
    expect(safeUrl("xmpp:a@b.c")).toBe("");
  });

  it("收掉相对路径（没有「当前站点」可言）", () => {
    expect(safeUrl("/foo/bar")).toBe("");
    expect(safeUrl("foo/bar")).toBe("");
  });
});

describe("ReleaseNotes 渲染", () => {
  it("渲染标题、列表、加粗与嵌套子标题，且不再露出 Markdown 标记", () => {
    const markdown = [
      "### 新功能",
      "",
      "- 第一条，含 **加粗** 与 [站点](https://example.com/docs)",
      "",
      "  ### 子小节",
      "",
      "  - 嵌套项",
    ].join("\n");

    const { container } = render(<ReleaseNotes markdown={markdown} />);

    expect(container.querySelectorAll("h3").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelector("strong")?.textContent).toBe("加粗");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.textContent).toContain("新功能");
    // 现状 bug 的回归断言：说明里不得再出现字面 ###
    expect(container.textContent).not.toContain("###");
  });

  it("丢弃原始 HTML：不产生任何可执行元素", () => {
    const { container } = render(
      <ReleaseNotes markdown={'正文 <script>alert(1)</script>\n\n<div onclick="x">块级 HTML</div>'} />,
    );

    // 标签本身不会变成元素，因此没有可执行的入口（skipHtml 丢弃 raw 节点）
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onclick]")).toBeNull();
    expect(container.innerHTML).not.toContain("<script");
    // 块级 HTML 整块被丢弃
    expect(container.textContent).not.toContain("块级 HTML");
    // 行内 HTML 在 markdown 里被拆成「起标签 + 中间文本 + 止标签」三个节点，
    // 丢弃标签后中间文字会作为**纯文本**留下——只是可读文字，不构成注入
    expect(container.textContent).toContain("alert(1)");
  });

  it("javascript: 链接退化为不可点的纯文本", () => {
    const { container } = render(<ReleaseNotes markdown={"[点我](javascript:alert(1))"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("点我");
  });

  it("http 链接点击走系统浏览器且不导航当前页面", () => {
    const { container } = render(<ReleaseNotes markdown={"[站点](https://example.com)"} />);
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();

    fireEvent.click(anchor as HTMLAnchorElement);

    expect(mockedOpenUrl).toHaveBeenCalledWith("https://example.com");
    // preventDefault 生效：webview 不会被导航走
    expect(anchor?.getAttribute("href")).toBe("https://example.com");
  });

  it("渲染表格、行内代码、代码块与引用", () => {
    const markdown = [
      "| 列 | 值 |",
      "| --- | --- |",
      "| a | 1 |",
      "",
      "行内 `code` 与块级：",
      "",
      "```",
      "const x = 1;",
      "```",
      "",
      "> 引用",
    ].join("\n");

    const { container } = render(<ReleaseNotes markdown={markdown} />);

    expect(container.querySelectorAll("table th").length).toBe(2);
    expect(container.querySelectorAll("table td").length).toBe(2);
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
    expect(container.querySelector("blockquote")?.textContent).toContain("引用");
  });

  it("允许 http(s) 图片，不放行的来源不渲染 <img>", () => {
    const { container: allowed } = render(
      <ReleaseNotes markdown={"![截图](https://example.com/a.png)"} />,
    );
    const img = allowed.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(img?.getAttribute("loading")).toBe("lazy");

    const blocked = render(<ReleaseNotes markdown={"![x](data:image/png;base64,AAAA)"} />);
    expect(blocked.container.querySelector("img")).toBeNull();
  });
});

describe("NotesErrorBoundary", () => {
  it("子节点抛错时回退为纯文本并留痕", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // React 会把捕获到的错误再打一份到 console.error，测试里静音
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const Boom = () => {
      throw new Error("渲染器炸了");
    };

    const { container } = render(
      <NotesErrorBoundary fallback="### 降级后的原始 Markdown">
        <Boom />
      </NotesErrorBoundary>,
    );

    expect(container.textContent).toBe("### 降级后的原始 Markdown");
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
