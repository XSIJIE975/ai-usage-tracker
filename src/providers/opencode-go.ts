import { invoke } from "@tauri-apps/api/core";
import type {
  CredentialStatus,
  HttpResult,
  MetricLine,
  ProviderSnapshot,
  VaultCredentials,
} from "../types/ipc";
import type { ProviderModule } from "./types";

const WINDOWS: Record<string, { label: string }> = {
  rolling: { label: "5 小时额度" },
  weekly: { label: "本周额度" },
  monthly: { label: "本月额度" },
};

interface ScrapedWindow {
  usagePercent: number;
  resetInSec: number;
}

function numberPattern() {
  return String.raw`(-?\d+(?:\.\d+)?)`;
}

function parseSsrWindow(html: string, name: string): ScrapedWindow | null {
  const num = numberPattern();
  const first = new RegExp(
    String.raw`${name}:\$R\[\d+\]=\{[^}]*usagePercent:${num}[^}]*resetInSec:${num}[^}]*\}`,
  );
  const second = new RegExp(
    String.raw`${name}:\$R\[\d+\]=\{[^}]*resetInSec:${num}[^}]*usagePercent:${num}[^}]*\}`,
  );

  let match = first.exec(html);
  if (match) return { usagePercent: Number(match[1]), resetInSec: Number(match[2]) };
  match = second.exec(html);
  if (match) return { usagePercent: Number(match[2]), resetInSec: Number(match[1]) };
  return null;
}

function parseHumanDuration(text: string): number | null {
  const normalized = text.trim().toLowerCase();
  if (["reset-now", "reset now", "now", "resets now"].includes(normalized)) return 0;
  let total = 0;
  const day = normalized.match(/(\d+(?:\.\d+)?)\s*days?/);
  const hour = normalized.match(/(\d+(?:\.\d+)?)\s*hours?/);
  const minute = normalized.match(/(\d+(?:\.\d+)?)\s*minutes?/);
  const second = normalized.match(/(\d+(?:\.\d+)?)\s*seconds?/);
  if (day) total += Number(day[1]) * 86_400;
  if (hour) total += Number(hour[1]) * 3_600;
  if (minute) total += Number(minute[1]) * 60;
  if (second) total += Number(second[1]);
  return day || hour || minute || second ? total : null;
}

function parseDataSlot(html: string): Partial<Record<string, ScrapedWindow>> {
  const result: Partial<Record<string, ScrapedWindow>> = {};
  const items = html.split(/data-slot="usage-item"/).slice(1);
  for (const item of items) {
    const labelMatch = item.match(/data-slot="usage-label">([^<]+)</);
    const usageMatch = item.match(/data-slot="usage-value">[^0-9]*(\d+(?:\.\d+)?)/);
    const resetMatch = item.match(/data-slot="(reset-time|reset-now)">([\s\S]*?)<\/span>/);
    if (!labelMatch || !usageMatch || !resetMatch) continue;
    const label = labelMatch[1].trim().toLowerCase();
    const usagePercent = Number(usageMatch[1]);
    const resetContent = resetMatch[2]
      .replace(/<!--\$-->/g, "")
      .replace(/<!--\/-->/g, "")
      .replace(/Resets?\s*in\s*/i, "")
      .trim();
    const resetInSec = resetMatch[1] === "reset-now" ? 0 : parseHumanDuration(resetContent);
    if (!Number.isFinite(usagePercent) || resetInSec === null || !Number.isFinite(resetInSec)) continue;
    if (label.includes("rolling")) result.rolling = { usagePercent, resetInSec };
    if (label.includes("weekly")) result.weekly = { usagePercent, resetInSec };
    if (label.includes("monthly")) result.monthly = { usagePercent, resetInSec };
  }
  return result;
}

export function parseOpenCodeGoHtml(html: string) {
  const windows: Partial<Record<string, ScrapedWindow>> = {
    rolling: parseSsrWindow(html, "rollingUsage") ?? undefined,
    weekly: parseSsrWindow(html, "weeklyUsage") ?? undefined,
    monthly: parseSsrWindow(html, "monthlyUsage") ?? undefined,
  };
  if (!windows.rolling && !windows.weekly && !windows.monthly) {
    Object.assign(windows, parseDataSlot(html));
  }
  return windows;
}

function buildLines(windows: Partial<Record<string, ScrapedWindow>>, updatedAt: number): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const window = windows[key];
    const config = WINDOWS[key];
    if (!window || !config) continue;
    const usedPercent = Math.max(0, window.usagePercent);
    lines.push({
      type: "progress",
      label: config.label,
      percentUsed: usedPercent,
      resetsAt: new Date(updatedAt + window.resetInSec * 1000).toISOString(),
    });
  }
  return lines;
}

async function fetchUsage(): Promise<ProviderSnapshot> {
  const status = await invoke<CredentialStatus>("vault_credential_status");
  const credentials = await invoke<VaultCredentials>("vault_credentials");
  const updatedAt = Date.now();
  const workspaceId = credentials.opencodeGoWorkspaceId?.trim() ?? "";
  const authCookie = credentials.opencodeGoAuthCookie?.trim() ?? "";
  if (!workspaceId || !authCookie) {
    return {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      status: "needs_config",
      updatedAt,
      message: "请在设置中填写 Workspace ID 和 Auth Cookie",
      lines: [],
    };
  }

  if (status.opencodeGoApiKey) {
    const official = await invoke<HttpResult>("provider_request", {
      providerId: "opencode-go",
      url: "https://opencode.ai/zen/go/v1/usage",
      method: "GET",
      auth: "bearer",
      headers: { Accept: "application/json" },
    });
    if (official.status === 200) {
      try {
        const data = JSON.parse(official.bodyText) as {
          plan?: string;
          windows?: Array<{
            name?: string;
            status?: string;
            usagePercent?: number;
            resetInSec?: number;
            used?: number;
            limit?: number;
          }>;
          useBalance?: boolean;
        };
        const windows: Partial<Record<string, ScrapedWindow>> = {};
        for (const item of data.windows ?? []) {
          const key = item.name?.includes("5-hour") ? "rolling" : item.name === "weekly" ? "weekly" : item.name === "monthly" ? "monthly" : undefined;
          if (key && typeof item.usagePercent === "number" && typeof item.resetInSec === "number") {
            windows[key] = { usagePercent: item.usagePercent, resetInSec: item.resetInSec };
          }
        }
        if (Object.keys(windows).length > 0) {
          return {
            providerId: "opencode-go",
            providerName: "OpenCode Go",
            status: "ok",
            updatedAt,
            lines: buildLines(windows, updatedAt),
          };
        }
      } catch {
        // fall through to dashboard scraping
      }
    }
  }

  const url = `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
  const dashboard = await invoke<HttpResult>("provider_request", {
    providerId: "opencode-go",
    url,
    method: "GET",
    auth: "cookie",
    headers: {
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0",
    },
  });

  if (dashboard.status !== 200) {
    return {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      status: "error",
      updatedAt,
      message: `OpenCode Go 后台返回 HTTP ${dashboard.status}，请检查 Cookie 是否过期`,
      lines: [],
    };
  }

  const title = dashboard.bodyText.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  if (title && title.toLowerCase().includes("openauth")) {
    return {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      status: "error",
      updatedAt,
      message: "OpenCode Go 后台返回登录/挑战页，请重新复制 auth Cookie",
      lines: [],
    };
  }

  const windows = parseOpenCodeGoHtml(dashboard.bodyText);
  const lines = buildLines(windows, updatedAt);
  if (lines.length === 0) {
    return {
      providerId: "opencode-go",
      providerName: "OpenCode Go",
      status: "error",
      updatedAt,
      message: "未能从 OpenCode Go 后台解析额度窗口",
      lines: [],
    };
  }

  return {
    providerId: "opencode-go",
    providerName: "OpenCode Go",
    status: "ok",
    updatedAt,
    lines,
  };
}

export const opencodeGoProvider: ProviderModule = {
  id: "opencode-go",
  name: "OpenCode Go",
  description: "读取 OpenCode Go 订阅的 5 小时/周/月额度",
  fetch: fetchUsage,
};
