import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerModules } from "./index";

/**
 * 目的地面白名单的漂移守卫（ADR-0032）。Rust 侧的 ALLOWED_HOSTS
 * （src-tauri/src/instances.rs）是 provider_request / diagnose_request 唯一放行的目标域：
 * 凭据由后端注入，所以「凭据会被发去哪」由那张表说了算，不看调用方传来的 url。
 *
 * 本测试把前端拼出的 URL 常量与那张表对齐全：接新供应商或加新端点却忘了在 Rust 表里
 * 登记 host 时，这里先红，而不是等刷新时用户看到一句「拒绝向 xxx 发请求」。
 */

const instancesRs = new URL("../../src-tauri/src/instances.rs", import.meta.url);

/** 只解析 ALLOWED_HOSTS 这一块：PROVIDER_KINDS 里也有 ("glm", &[...]) 形状的元组 */
function parseAllowedHosts(source: string): Record<string, string[]> {
  const start = source.indexOf("const ALLOWED_HOSTS");
  const end = start < 0 ? -1 : source.indexOf("\n];", start);
  if (end < 0) throw new Error("src-tauri/src/instances.rs 里找不到 ALLOWED_HOSTS 表");
  const table: Record<string, string[]> = {};
  const block = source.slice(start, end);
  for (const entry of block.matchAll(/\(\s*"([a-z0-9-]+)",\s*&\[([^\]]*)\],?\s*\)/g)) {
    table[entry[1]] = [...entry[2].matchAll(/"([^"]+)"/g)].map((host) => host[1]);
  }
  return table;
}

const allowedHosts = parseAllowedHosts(readFileSync(instancesRs, "utf8"));
const allHosts = new Set(Object.values(allowedHosts).flat());

/** 一个模块里出现的主机名（含注释里写的端点：那些同样是要发出去的地址） */
function hostsOf(file: URL): string[] {
  return [...readFileSync(file, "utf8").matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)].map(
    (host) => host[1],
  );
}

// 文件名的种类前缀：opencode-go 的模块叫 opencode-*.ts，其余前缀即种类名
const kindOfFile = (fileName: string): string | undefined =>
  Object.keys(allowedHosts).find((kind) => fileName.startsWith(kind.split("-")[0]));

const providerFiles = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .map((name) => ({ name, url: new URL(`./${name}`, import.meta.url) }));

describe("ALLOWED_HOSTS 与前端 URL 常量对齐", () => {
  it("表覆盖的种类与前端注册的供应商一一对应", () => {
    expect(Object.keys(allowedHosts).sort()).toEqual(providerModules.map((module) => module.id).sort());
  });

  it("每个种类都登记了目标域名，且只写主机名", () => {
    for (const [kind, hosts] of Object.entries(allowedHosts)) {
      expect(hosts.length, `${kind} 没有登记任何目标域名`).toBeGreaterThan(0);
      for (const host of hosts) {
        expect(host, `${kind} 的 ${host} 应只写主机名`).not.toMatch(/[/:]/);
      }
    }
  });

  it("各供应商模块只打自己种类的域名", () => {
    for (const file of providerFiles) {
      const hosts = hostsOf(file.url);
      if (hosts.length === 0) continue;
      const kind = kindOfFile(file.name);
      expect(kind, `${file.name} 含 URL 常量但归不到任何种类，请补种类前缀`).toBeDefined();
      const own = new Set(allowedHosts[kind as string]);
      for (const host of hosts) {
        expect(own.has(host), `${file.name} 打向 ${host}，不在 ${kind} 的允许域名内`).toBe(true);
      }
    }
  });

  it("探测端点落在登记域名的全集内", () => {
    for (const host of hostsOf(new URL("../diagnostics.ts", import.meta.url))) {
      expect(allHosts.has(host), `diagnostics.ts 打向 ${host}`).toBe(true);
    }
  });

  it("表里没有已经用不上的域名", () => {
    // 反方向也要对齐：端点换域或下线后忘清理，白名单会越攒越长、审计时看不出哪个还在用
    const used = new Set([
      ...providerFiles.flatMap((file) => hostsOf(file.url)),
      ...hostsOf(new URL("../diagnostics.ts", import.meta.url)),
    ]);
    const stale = [...allHosts].filter((host) => !used.has(host));
    expect(stale, `ALLOWED_HOSTS 里的这些域名前端已经不再请求：${stale.join("、")}`).toEqual([]);
  });

  it("取数与探测链路没有 http 明文端点", () => {
    // 明文端点会被 Rust 侧的方案校验拒掉（只放 https），出现即说明两边不一致
    const plain = [...providerFiles, { name: "diagnostics.ts", url: new URL("../diagnostics.ts", import.meta.url) }]
      .filter((file) => /http:\/\//.test(readFileSync(file.url, "utf8")))
      .map((file) => file.name);
    expect(plain).toEqual([]);
  });
});
