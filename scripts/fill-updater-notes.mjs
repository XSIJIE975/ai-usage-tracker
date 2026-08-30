import { readFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const releaseId = process.env.RELEASE_ID;

// 各更新产物对应的 platforms 键。基础键给新版 updater，带后缀的键兼容旧版。
// 映射需与 release.yml 构建矩阵保持一致。
const PLATFORM_MAP = [
  { pattern: /_universal\.app\.tar\.gz\.sig$/, keys: ["darwin-universal", "darwin-universal-app"] },
  { pattern: /_aarch64\.app\.tar\.gz\.sig$/, keys: ["darwin-aarch64", "darwin-aarch64-app"] },
  { pattern: /_x64-setup\.exe\.sig$/, keys: ["windows-x86_64", "windows-x86_64-nsis"] },
  { pattern: /_arm64-setup\.exe\.sig$/, keys: ["windows-aarch64", "windows-aarch64-nsis"] },
  { pattern: /_amd64\.AppImage\.sig$/, keys: ["linux-x86_64", "linux-x86_64-appimage"] },
  { pattern: /_amd64\.deb\.sig$/, keys: ["linux-x86_64-deb"] },
  { pattern: /_aarch64\.AppImage\.sig$/, keys: ["linux-aarch64", "linux-aarch64-appimage"] },
  { pattern: /_arm64\.deb\.sig$/, keys: ["linux-aarch64-deb"] },
];

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
const assets = release.assets;

// 多平台并行构建各自上传 latest.json 存在竞态（读旧-合并-写回互相覆盖），
// 因此这里不信任已上传的清单，而是从 Release 资产上的 .sig 文件确定性重建 platforms
const signatureAssets = assets.filter((asset) => asset.name.endsWith(".sig"));
const platforms = {};
for (const asset of signatureAssets) {
  const mapping = PLATFORM_MAP.find((entry) => entry.pattern.test(asset.name));
  if (!mapping) {
    console.log(`跳过未映射的签名文件：${asset.name}`);
    continue;
  }
  const binaryName = asset.name.replace(/\.sig$/, "");
  const binaryAsset = assets.find((item) => item.name === binaryName);
  if (!binaryAsset) {
    throw new Error(`找不到签名对应的产物：${binaryName}`);
  }
  const sigResponse = await fetch(`${apiRoot}/releases/assets/${asset.id}`, {
    headers: headers({ Accept: "application/octet-stream" }),
  });
  if (!sigResponse.ok) {
    throw new Error(`下载 ${asset.name} 失败：${sigResponse.status}`);
  }
  const signature = (await sigResponse.text()).trim();
  for (const key of mapping.keys) {
    platforms[key] = {
      signature,
      url: `${apiRoot}/releases/assets/${binaryAsset.id}`,
    };
  }
}

const version = release.tag_name.replace(/^v/, "");
const notes = toPlainText(readFileSync("release-body.md", "utf8"));

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const latestAsset = assets.find((asset) => asset.name === "latest.json");
if (latestAsset) {
  const deleteResponse = await fetch(
    `${apiRoot}/releases/assets/${latestAsset.id}`,
    { method: "DELETE", headers: headers() }
  );
  if (!deleteResponse.ok) {
    throw new Error(`删除旧 latest.json 失败：${deleteResponse.status}`);
  }
}

const uploadUrl = release.upload_url.split("{")[0];
const payload = JSON.stringify(manifest);
const uploadResponse = await fetch(`${uploadUrl}?name=latest.json`, {
  method: "POST",
  headers: headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": Buffer.byteLength(payload),
  }),
  body: payload,
});
if (!uploadResponse.ok) {
  throw new Error(`上传 latest.json 失败：${uploadResponse.status}`);
}

console.log(
  `已重建 v${version} 更新清单：${Object.keys(platforms).length} 个平台条目，更新说明 ${notes.length} 字`
);
