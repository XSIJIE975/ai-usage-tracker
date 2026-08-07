import type { ProviderSnapshot } from "../types/ipc";

export interface ProviderModule {
  id: string;
  name: string;
  description: string;
  fetch: () => Promise<ProviderSnapshot>;
}
