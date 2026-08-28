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
}

export interface VaultCredentials {
  deepseekApiKey?: string;
  deepseekUserToken?: string;
  opencodeGoWorkspaceId?: string;
  opencodeGoAuthCookie?: string;
  opencodeGoApiKey?: string;
}

export interface CredentialsInput {
  deepseekApiKey?: string | null;
  deepseekUserToken?: string | null;
  opencodeGoWorkspaceId?: string | null;
  opencodeGoAuthCookie?: string | null;
  opencodeGoApiKey?: string | null;
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

export interface AppSettings {
  refreshEnabled: boolean;
  refreshIntervalMinutes: number;
  providers: Record<string, boolean>;
}
