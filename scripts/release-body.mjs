import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;
const changelogPath = "CHANGELOG.md";

function extractSection(content, version) {
  const heading = `## ${version}`;
  const start = content.indexOf(heading);

  if (start < 0) return "";

  const rest = content.slice(start + heading.length);
  const nextHeading = rest.search(/^##\s/m);
  const sectionEnd = nextHeading < 0 ? rest.length : nextHeading;
  return rest.slice(0, sectionEnd).trim();
}

let body = "";

try {
  const changelog = readFileSync(changelogPath, "utf8");
  body = extractSection(changelog, version);
} catch {
  body = "";
}

const releaseBody = body
  ? `## ${version}\n\n${body}\n`
  : `## ${version}\n\n暂无变更说明。\n`;

writeFileSync("release-body.md", releaseBody);
