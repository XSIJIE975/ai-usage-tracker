import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const releaseId = process.env.RELEASE_ID;
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const overrideVersion = (process.env.RELEASE_VERSION ?? "").trim();
const version = overrideVersion || packageJson.version;

function toPlainText(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      // 提交哈希链接（如 [f0607eb](url)）对应用内更新说明没有意义，直接去掉
      let text = line.replace(/\s*\[[0-9a-f]{7,40}\]\([^)]*\)/g, "");
      // PR 链接保留编号（[#12](url) -> #12）
      text = text.replace(/\s*\[#(\d+)\]\([^)]*\)/g, " #$1");
      text = text.replace(/\*\*/g, "");
      text = text.replace(/^###\s*/, "");
      return text.trimEnd();
    })
    .filter((line, index, lines) => {
      if (/^##\s/.test(line)) return false;
      if (line === "" && (index === 0 || lines[index - 1] === "")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function headers(extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    ...extra,
  };
}

const apiRoot = `https://api.github.com/repos/${repo}`;

const releaseResponse = await fetch(`${apiRoot}/releases/${releaseId}`, {
  headers: headers(),
});
if (!releaseResponse.ok) {
  throw new Error(`获取 Release 失败：${releaseResponse.status}`);
}
const release = await releaseResponse.json();

const latestAsset = release.assets.find((asset) => asset.name === "latest.json");
if (!latestAsset) {
  throw new Error("Release 上没有找到 latest.json，构建可能未完成");
}

const manifestResponse = await fetch(
  `${apiRoot}/releases/assets/${latestAsset.id}`,
  { headers: headers({ Accept: "application/octet-stream" }) }
);
if (!manifestResponse.ok) {
  throw new Error(`下载 latest.json 失败：${manifestResponse.status}`);
}
const manifest = await manifestResponse.json();

const body = readFileSync("release-body.md", "utf8");
manifest.notes = toPlainText(body);

const deleteResponse = await fetch(
  `${apiRoot}/releases/assets/${latestAsset.id}`,
  { method: "DELETE", headers: headers() }
);
if (!deleteResponse.ok) {
  throw new Error(`删除旧 latest.json 失败：${deleteResponse.status}`);
}

const uploadUrl = release.upload_url.split("{")[0];
const uploadResponse = await fetch(`${uploadUrl}?name=latest.json`, {
  method: "POST",
  headers: headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": Buffer.byteLength(JSON.stringify(manifest)),
  }),
  body: JSON.stringify(manifest),
});
if (!uploadResponse.ok) {
  throw new Error(`上传 latest.json 失败：${uploadResponse.status}`);
}

console.log(`已为 v${version} 回填应用内更新说明（${manifest.notes.length} 字）`);
