/**
 * 统计页占位数据（本阶段不对接真实接口）。
 * 使用确定性伪随机生成，保证每次渲染数据稳定、便于截图与走查。
 * 后续对接真实数据时，仅需替换本文件的导出函数，视图组件无需改动。
 */

/* 确定性 PRNG（mulberry32） */
function seededRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ApiKeyOption {
  value: string;
  label: string;
}

export interface ModelSeries {
  model: string;
  /** 每日数据点，与 days 对齐 */
  tokensIn: number[];
  tokensOut: number[];
  requests: number[];
}

export interface DayPoint {
  /** 如 "8月13" 或 ISO 日期 */
  label: string;
}

/* ---------------- DeepSeek ---------------- */

export const deepseekApiKeys: ApiKeyOption[] = [
  { value: "all", label: "全部密钥" },
  { value: "sk-live-8f3a", label: "sk-live-…8f3a（生产）" },
  { value: "sk-test-21bc", label: "sk-test-…21bc（测试）" },
];

export const deepseekModels = ["deepseek-chat", "deepseek-reasoner", "deepseek-v4-flash"] as const;

/** 生成近 n 天的 DeepSeek 占位序列（按密钥缩放） */
export function getDeepSeekSeries(days: number, apiKeyId: string): { labels: string[]; series: ModelSeries[] } {
  const keyFactor = apiKeyId === "sk-live-8f3a" ? 0.72 : apiKeyId === "sk-test-21bc" ? 0.28 : 1;
  const rand = seededRandom(20260801 + days * 7 + apiKeyId.length * 131);
  const labels: string[] = [];
  const now = new Date(2026, 7, 23); // 占位基准日：2026-08-23
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    labels.push(`${d.getMonth() + 1}月${d.getDate()}日`);
  }

  const base: Record<string, { tokens: number; requests: number }> = {
    "deepseek-chat": { tokens: 180_000, requests: 320 },
    "deepseek-reasoner": { tokens: 96_000, requests: 140 },
    "deepseek-v4-flash": { tokens: 240_000, requests: 460 },
  };

  const series: ModelSeries[] = deepseekModels.map((model, mi) => {
    const b = base[model];
    const tokensIn: number[] = [];
    const tokensOut: number[] = [];
    const requests: number[] = [];
    for (let i = 0; i < days; i++) {
      const weekend = new Date(now.getTime() - (days - 1 - i) * 86_400_000).getDay() % 6 === 0 ? 0.45 : 1;
      const wave = 0.55 + rand() * 0.9;
      const req = Math.round(b.requests * wave * weekend * keyFactor);
      const tin = Math.round(b.tokens * wave * weekend * keyFactor * (0.55 + (mi + 1) * 0.1));
      requests.push(req);
      tokensIn.push(tin);
      tokensOut.push(Math.round(tin * (0.18 + rand() * 0.14)));
    }
    return { model, tokensIn, tokensOut, requests };
  });

  return { labels, series };
}

/* ---------------- OpenCode Go ---------------- */

export const opencodeModels = [
  "deepseek-v4-flash (go)",
  "glm-5.2 (go)",
  "gpt-5.6-luna (go)",
  "hy3 (go)",
  "mimo-v2.5 (go)",
  "muse-spark-1.2 (go)",
] as const;

export const opencodeKeys: ApiKeyOption[] = [
  { value: "all", label: "所有密钥" },
  { value: "go-prod", label: "生产密钥 go-prod" },
  { value: "go-test", label: "测试密钥 go-test" },
];

export interface CostDay {
  label: string;
  /** 与 opencodeModels 对齐的当日成本（美元） */
  costs: number[];
}

/** 生成某年某月的每日成本占位数据（形态参照产品截图：稀疏、有高峰） */
export function getOpenCodeCosts(year: number, month: number, keyId: string): CostDay[] {
  const rand = seededRandom(year * 100 + month + keyId.length * 17);
  const daysInMonth = new Date(year, month, 0).getDate();
  const keyFactor = keyId === "go-prod" ? 0.78 : keyId === "go-test" ? 0.22 : 1;
  const result: CostDay[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const active = rand() > 0.42;
    const spike = rand() > 0.86 ? 2.2 + rand() * 1.6 : 1;
    const costs = opencodeModels.map((_, mi) => {
      if (!active) return 0;
      const modelWeight = [1.9, 0.5, 0.35, 1.1, 0.55, 0.3][mi] ?? 0.4;
      const present = rand() > 0.62 ? 1 : 0;
      return Number((present * modelWeight * spike * (0.4 + rand()) * keyFactor).toFixed(2));
    });
    result.push({ label: `${month}月 ${String(day).padStart(2, "0")}`, costs });
  }
  return result;
}

export interface UsageHistoryRow {
  time: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costLabel: string;
  session: string;
}

const historyModels = ["ox-alpha-free", "deepseek-v4-flash (go)", "hy3 (go)", "mimo-v2.5 (go)"];

export function getOpenCodeHistory(count = 14): UsageHistoryRow[] {
  const rand = seededRandom(42);
  const rows: UsageHistoryRow[] = [];
  const base = new Date(2026, 7, 23, 0, 5); // 2026-08-23 00:05
  let input = 152_704;

  for (let i = 0; i < count; i++) {
    const t = new Date(base.getTime() - i * (1 + Math.floor(rand() * 9)) * 60_000);
    const month = t.getMonth() + 1;
    const day = t.getDate();
    const hour24 = t.getHours();
    const period = hour24 < 6 ? "凌晨" : hour24 < 12 ? "上午" : hour24 < 18 ? "下午" : "晚上";
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const minute = String(t.getMinutes()).padStart(2, "0");
    const paid = rand() > 0.7;
    rows.push({
      time: `${month}月${day}日 ${period}${hour12}:${minute}`,
      model: historyModels[Math.floor(rand() * historyModels.length)],
      inputTokens: input,
      outputTokens: Math.round(30 + rand() * 1500),
      costLabel: paid ? `Go（$${(rand() * 0.02).toFixed(4)}）` : "Go（$0.0000）",
      session: "9gEsMMah",
    });
    input -= Math.round(200 + rand() * 900);
  }
  return rows;
}
