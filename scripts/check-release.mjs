import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseVersion(value) {
  const [major = 0, minor = 0, patch = 0] = value
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number(part));
  return [major, minor, patch];
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }

  return 0;
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const overrideVersion = (process.env.RELEASE_VERSION ?? "").trim();
const forceBuild = overrideVersion !== "";
const version = overrideVersion || packageJson.version;

function readPreviousVersion() {
  try {
    const content = execFileSync(
      "git",
      ["show", "HEAD^1:package.json"],
      { encoding: "utf8" }
    );
    return JSON.parse(content).version;
  } catch {
    return null;
  }
}

const tags = execFileSync("git", ["tag", "--list", "v*"], {
  encoding: "utf8",
})
  .split(/\r?\n/)
  .map((tag) => tag.trim())
  .filter(Boolean)
  .sort((left, right) => compareVersions(right, left));

const latestTag = tags[0]?.replace(/^v/, "") ?? "";
const previousVersion = readPreviousVersion();
const changedFromPreviousCommit =
  previousVersion !== null &&
  compareVersions(version, previousVersion) > 0;
const changedFromLatestTag =
  latestTag !== "" && compareVersions(version, latestTag) > 0;
const shouldBuild = forceBuild || changedFromPreviousCommit || changedFromLatestTag;

process.stdout.write(
  [
    `should_build=${shouldBuild ? "true" : "false"}`,
    `version=${version}`,
    `latest_tag=${latestTag}`,
    `previous_version=${previousVersion ?? ""}`,
  ].join("\n") + "\n"
);
