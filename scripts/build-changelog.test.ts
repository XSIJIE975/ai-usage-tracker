import { describe, expect, it } from "vitest";

import { parseChangelog } from "./build-changelog.mjs";

const markdown = [
  "# ai-usage-tracker",
  "",
  "## 0.15.0",
  "",
  "### 新功能",
  "",
  "- 摘要行 [abc123](https://github.com/x/y/commit/abc123)",
  "",
  "  ### 小节一",
  "",
  "  - **条目**：说明文字",
  "",
  "## v0.14.0",
  "",
  "### 新功能",
  "",
  "- 上一版内容",
  "",
  "## 0.13.0",
].join("\n");

describe("parseChangelog", () => {
  it("按 ## 版本分段，notes 为段内 Markdown 原文", () => {
    const sections = parseChangelog(markdown);
    expect(sections.map((section) => section.version)).toEqual(["0.15.0", "0.14.0"]);
    expect(sections[0].notes).toContain("### 新功能");
    expect(sections[0].notes).toContain("- 摘要行 [abc123]");
    expect(sections[0].notes).toContain("  ### 小节一");
  });

  it("段不越界：小节内容不出现在下一段", () => {
    const sections = parseChangelog(markdown);
    expect(sections[1].notes).not.toContain("小节一");
    expect(sections[1].notes.trim()).toBe("### 新功能\n\n- 上一版内容");
  });

  it("去掉 v 前缀、跳过空段", () => {
    const sections = parseChangelog("## v1.2.3\n\n- 内容\n\n## 1.0.0\n");
    expect(sections.map((section) => section.version)).toEqual(["1.2.3"]);
  });
});
