import { AnthropicProvider } from "./anthropic.ts";
import { CliProvider } from "./cli.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import type { LlmProvider } from "./types.ts";

export * from "./types.ts";

/**
 * DRIFTNET_LLM_PROVIDER picks the adapter:
 *   anthropic — Claude through the official SDK
 *   openai    — any OpenAI-compatible Chat Completions API: OpenAI, Gemini, Grok,
 *               DeepSeek, OpenRouter, LiteLLM, Ollama, LM Studio… (set DRIFTNET_LLM_BASE_URL)
 *   claude-cli / gemini-cli — a logged-in Claude Code or Gemini CLI on this machine,
 *               i.e. your subscription instead of an API key (no key needed)
 *
 * The key is DRIFTNET_LLM_API_KEY for every provider. driftnet never reads the
 * vendors' own variables (ANTHROPIC_API_KEY, OPENAI_API_KEY): exporting those
 * changes how other tools on the machine bill you — Claude Code, for one, moves
 * from your subscription to API billing.
 */
export function createProvider(env: NodeJS.ProcessEnv): LlmProvider | undefined {
  const provider = env.DRIFTNET_LLM_PROVIDER?.toLowerCase();
  const model = env.DRIFTNET_LLM_MODEL;
  const apiKey = env.DRIFTNET_LLM_API_KEY;
  if (!provider || provider === "off") return undefined;

  if (provider === "claude-cli" || provider === "gemini-cli") {
    return new CliProvider({
      kind: provider === "claude-cli" ? "claude" : "gemini",
      ...(model ? { model } : {}),
      ...(env.DRIFTNET_LLM_EFFORT ? { effort: env.DRIFTNET_LLM_EFFORT } : {}),
      ...(env.DRIFTNET_CLI_PATH ? { bin: env.DRIFTNET_CLI_PATH } : {}),
      ...(env.DRIFTNET_CLI_CONCURRENCY ? { concurrency: Math.max(1, Number(env.DRIFTNET_CLI_CONCURRENCY)) } : {}),
    });
  }
  if (!model) throw new Error("DRIFTNET_LLM_MODEL is required when DRIFTNET_LLM_PROVIDER is set");

  switch (provider) {
    case "anthropic":
      if (!apiKey) throw new Error("DRIFTNET_LLM_API_KEY is required for the anthropic provider");
      return new AnthropicProvider(apiKey, model, env.DRIFTNET_LLM_EFFORT);
    case "openai":
      return new OpenAICompatibleProvider({
        baseUrl: env.DRIFTNET_LLM_BASE_URL ?? "https://api.openai.com/v1",
        model,
        // Local servers (Ollama, LM Studio) need no key.
        ...(apiKey ? { apiKey } : {}),
        ...(env.DRIFTNET_LLM_EFFORT ? { reasoningEffort: env.DRIFTNET_LLM_EFFORT } : {}),
      });
    default:
      throw new Error(`Unknown DRIFTNET_LLM_PROVIDER=${provider} (expected anthropic, openai, claude-cli, gemini-cli or off)`);
  }
}
