import type { ProviderInstance, ProviderKind, ProviderSnapshot } from "../types/ipc";

export interface ProviderModule {
  id: ProviderKind;
  name: string;
  description: string;
  fetch: (instance: ProviderInstance) => Promise<ProviderSnapshot>;
}
