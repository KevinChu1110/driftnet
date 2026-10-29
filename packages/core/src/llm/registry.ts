import type { LlmProvider } from "./types.ts";

/** Builds a provider from the settings (environment variables). May throw a readable error. */
export type ProviderFactory = (env: NodeJS.ProcessEnv) => LlmProvider | undefined;

const providers = new Map<string, ProviderFactory>();

/**
 * Add a provider selectable with DRIFTNET_LLM_PROVIDER=<name>. Registered names
 * are checked before the built-in ones, so a plugin can also replace one.
 */
export function registerProvider(name: string, factory: ProviderFactory): void {
  providers.set(name.toLowerCase(), factory);
}

export function providerFactory(name: string): ProviderFactory | undefined {
  return providers.get(name.toLowerCase());
}

export function registeredProviders(): string[] {
  return [...providers.keys()];
}
