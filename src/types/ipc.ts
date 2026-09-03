export type ProviderKind = "deepseek" | "opencode-go" | "glm";

export interface ProviderInstance {
  id: string;
  providerId: ProviderKind;
  note: string;
  sortOrder: number;
  pinned: boolean;
  autoRefresh: boolean;
  /** DeepSeek=元，其余=已用百分比；null=不告警 */
  threshold: number | null;
  createdAt: number;
}

/** 某实例已保存的凭据明文（凭据槽 → 值），仅含非空项 */
export type InstanceCredentials = Record<string, string>;
/** 某实例的凭据配置状态（凭据槽 → 是否已配置） */
export type InstanceCredentialStatus = Record<string, boolean>;

export interface VaultStatus {
  initialized: boolean;
  unlocked: boolean;
  needsMigration: boolean;
  keychainLost: boolean;
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
  /** bearer 时的凭据槽；缺省用该种类的主鉴权键 */
  credentialSlot?: string;
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
  instanceId: string;
  providerId: ProviderKind;
  providerName: string;
  status: "ok" | "error" | "needs_config";
  updatedAt: number;
  /** 中文模板串（含 {placeholder}），渲染端 applyParams(t(message), messageParams) 翻译 */
  message?: string;
  /** message 模板的占位符实参 */
  messageParams?: Record<string, string | number>;
  lines: MetricLine[];
}

export interface StoredSnapshot {
  instance_id: string;
  captured_at: number;
  payload: ProviderSnapshot;
}

export interface AppSettings {
  refreshEnabled: boolean;
  refreshIntervalMinutes: number;
  /** 用量告警总开关 */
  alertsEnabled: boolean;
  /** 快速面板全局快捷键（规范格式，如 "Alt+KeyU"；空字符串表示不启用） */
  quickPanelShortcut: string;
  /** 快速面板失焦自动隐藏 */
  quickAutoHide: boolean;
  /** 卡片重置时间的展示：relative 倒计时 / absolute 具体时刻 */
  resetTimeDisplay: "relative" | "absolute";
  /** 界面语言：auto 按系统语言检测（中文→中文，否则英文） */
  interfaceLanguage: "auto" | "zh" | "en";
}

export interface StoredNotification {
  id: number;
  created_at: number;
  instance_id: string;
  title: string;
  body: string;
  read: boolean;
}
