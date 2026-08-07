import { readFileSync, writeFileSync, existsSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = packageJson.version;

const cargoTomlPath = "src-tauri/Cargo.toml";
const cargoToml = readFileSync(cargoTomlPath, "utf8");
const nextCargoToml = cargoToml.replace(
  /^(version\s*=\s*")[^"]+(")/m,
  `$1${version}$2`
);
writeFileSync(cargoTomlPath, nextCargoToml);

const cargoLockPath = "src-tauri/Cargo.lock";
const cargoLock = readFileSync(cargoLockPath, "utf8");
const nextCargoLock = cargoLock.replace(
  /^(name = "ai-usage-tracker"\nversion = ")[^"]+(")/m,
  `$1${version}$2`
);
writeFileSync(cargoLockPath, nextCargoLock);

const tauriConfigPath = "src-tauri/tauri.conf.json";
const tauriConfigText = readFileSync(tauriConfigPath, "utf8");
const nextTauriConfigText = tauriConfigText.replace(
  /("version"\s*:\s*")[^"]+(")/,
  `$1${version}$2`
);
writeFileSync(tauriConfigPath, nextTauriConfigText);

const changelogPath = "CHANGELOG.md";
if (existsSync(changelogPath)) {
  const changelog = readFileSync(changelogPath, "utf8");
  const nextChangelog = changelog
    .replace(/^### Major Changes/gm, "### 破坏性变更")
    .replace(/^### Minor Changes/gm, "### 新功能")
    .replace(/^### Patch Changes/gm, "### 修复");
  writeFileSync(changelogPath, nextChangelog);
}

console.log(`Synced version ${version} to Tauri configuration`);
