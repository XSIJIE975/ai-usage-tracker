import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const changelogPath = "CHANGELOG.md";
const outputPath = "src-tauri/changelog.json";

/**
 * 按 `## <version>` 分段解析 CHANGELOG.md。notes 为段内 Markdown 原文
 * （与 release-body.mjs 的抽取同口径），内嵌后由前端 ReleaseNotes.tsx 渲染。
 * 段内缩进的小节标题（如「  ### 速览面板」）不属于 `^## ` 行，不会截断分段。
 */
export function parseChangelog(markdown) {
  const headingPattern = /^##\s+(.+)$/gm;
  const matches = [...markdown.matchAll(headingPattern)];
  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const version = matches[index][1].trim().replace(/^v/, "");
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : markdown.length;
    const notes = markdown.slice(start, end).trim();
    if (!version || !notes) continue;
    sections.push({ version, notes });
  }
  return sections;
}

function main() {
  const markdown = readFileSync(changelogPath, "utf8");
  const sections = parseChangelog(markdown);

  // CHANGELOG.md 不含日期：旧版本从已生成的 changelog.json 回读，新版本记首次生成的当天
  let previousDates = {};
  if (existsSync(outputPath)) {
    try {
      previousDates = Object.fromEntries(
        JSON.parse(readFileSync(outputPath, "utf8")).map((entry) => [entry.version, entry.date]),
      );
    } catch {
      previousDates = {};
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const entries = sections.map((section) => ({
    version: section.version,
    date: previousDates[section.version] ?? today,
    notes: section.notes,
  }));

  writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`Wrote ${outputPath} with ${entries.length} version(s)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
