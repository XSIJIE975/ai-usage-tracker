import type { ProviderKind } from "../types/ipc";
import type { ProviderModule } from "./types";
import { deepseekProvider } from "./deepseek";
import { opencodeGoProvider } from "./opencode-go";
import { glmProvider } from "./glm";
import { workbuddyProvider } from "./workbuddy";

export const providerModules: ProviderModule[] = [
  opencodeGoProvider,
  deepseekProvider,
  glmProvider,
  workbuddyProvider,
];

export function getProviderModule(id: string) {
  return providerModules.find((provider) => provider.id === id);
}

export function providerName(id: ProviderKind): string {
  const module = providerModules.find((provider) => provider.id === id);
  return module?.name ?? id;
}

export { opencodeGoProvider } from "./opencode-go";
export { deepseekProvider } from "./deepseek";
export { glmProvider } from "./glm";
export { workbuddyProvider } from "./workbuddy";
export type { ProviderModule } from "./types";
