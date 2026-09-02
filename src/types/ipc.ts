export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  needsMigration: boolean;
  keychainLost: boolean;
}

export interface CredentialStatus {
  deepseekApiKey: boolean;
  deepseekUserToken: boolean;
  opencodeGoWorkspaceId: boolean;
  opencodeGoAuthCookie: boolean;
  opencodeGoApiKey: boolean;
  glmCodingPlanKey: boolean;
}

export interface VaultCredentials {
  deepseekApiKey?: string;
  deepseekUserToken?: string;
  opencodeGoWorkspaceId?: string;
  opencodeGoAuthCookie?: string;
  opencodeGoApiKey?: string;
  glmCodingPlanKey?: string;
}

export interface CredentialsInput {
  deepseekApiKey?: string | null;
  deepseekUserToken?: string | null;
  opencodeGoWorkspaceId?: string | null;
  opencodeGoAuthCookie?: string | null;
  opencodeGoApiKey?: string | null;
  glmCodingPlanKey?: string | null;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

export interface ProviderRequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  bodyText?: string;
  auth?: "bearer" | "cookie" | "none";
}

export interface MetricLine {
  type: "progress" | "text" | "badge";
  label: string;
  /** label 模板的 {name} 占位符实参（如 "{hours} 小时请求配额" 的 hours），渲染端替换 */
  params?: Record<string, string | number>;
  value?: string;
  used?: number;
  limit?: number;
  suffix?: string;
  percentUsed?: number;
  resetsAt?: string;
  color?: string;
}

export interface ProviderSnapshot {
  providerId: string;
  providerName: string;
  status: "ok" | "error" | "needs_config";
  updatedAt: number;
  message?: string;
  lines: MetricLine[];
}

export interface StoredSnapshot {
  provider_id: string;
  captured_at: number;
  payload: ProviderSnapshot;
}

export interface AlertThresholds {
  /** DeepSeek 余额低于该值（元）时告警 */
  deepseekBalanceBelowCny: number;
  /** OpenCode Go 本月额度已用达到该百分比时告警 */
  opencodeMonthlyUsedPercent: number;
  /** 智谱 Coding Plan 配额已用达到该百分比时告警 */
  glmQuotaUsedPercent: number;
}

export interface AppSettings {
  refreshEnabled: boolean;
  refreshIntervalMinutes: number;
  providers: Record<string, boolean>;
  /** 用量告警总开关 */
  alertsEnabled: boolean;
  alertThresholds: AlertThresholds;
  /** 快速面板全局快捷键（规范格式，如 "Alt+KeyU"；空字符串表示不启用） */
  quickPanelShortcut: string;
  /** 快速面板失焦自动隐藏 */
  quickAutoHide: boolean;
  /** 界面语言：auto 按系统语言检测（中文→中文，否则英文） */
  interfaceLanguage: "auto" | "zh" | "en";
}

export interface StoredNotification {
  id: number;
  created_at: number;
  provider_id: string;
  title: string;
  body: string;
  read: boolean;
}
