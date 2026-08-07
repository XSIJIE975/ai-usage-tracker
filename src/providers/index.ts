import type { ProviderModule } from "./types";
import { deepseekProvider } from "./deepseek";
import { opencodeGoProvider } from "./opencode-go";

export const providerModules: ProviderModule[] = [opencodeGoProvider, deepseekProvider];

export function getProviderModule(id: string) {
  return providerModules.find((provider) => provider.id === id);
}

export { opencodeGoProvider } from "./opencode-go";
export { deepseekProvider } from "./deepseek";
export type { ProviderModule } from "./types";
