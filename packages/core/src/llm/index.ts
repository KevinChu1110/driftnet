import { readFileSync } from "node:fs";
import { AnthropicProvider } from "./anthropic.ts";
import { BedrockProvider } from "./bedrock.ts";
import { CliProvider } from "./cli.ts";
import { GeminiProvider } from "./gemini.ts";
import { OpenAICompatibleProvider } from "./openai.ts";
import { providerFactory, registeredProviders } from "./registry.ts";
import { parseServiceAccount, VertexProvider } from "./vertex.ts";
import type { LlmProvider } from "./types.ts";

export * from "./types.ts";
export { registerProvider, type ProviderFactory } from "./registry.ts";

/**
 * DRIFTNET_LLM_PROVIDER picks the adapter:
 *   anthropic — Claude through the official SDK
 *   openai    — any OpenAI-compatible Chat Completions API: OpenAI, Gemini, Grok,
 *               DeepSeek, OpenRouter, LiteLLM, Ollama, LM Studio… (set DRIFTNET_LLM_BASE_URL)
 *   gemini    — Google's Gemini API directly (key: DRIFTNET_LLM_API_KEY or GEMINI_API_KEY)
 *   bedrock   — Amazon Bedrock (Converse API, SigV4 signed by hand; AWS_* credentials)
 *   vertex    — Gemini on Google Cloud (service-account key or access token)
 *   claude-cli / gemini-cli — a logged-in Claude Code or Gemini CLI on this machine,
 *               i.e. your subscription instead of an API key (no key needed)
 *   <name>    — anything a plugin added with registerProvider
 *
 * The key is DRIFTNET_LLM_API_KEY for every key-based provider. driftnet never
 * reads ANTHROPIC_API_KEY / OPENAI_API_KEY: exporting those changes how other
 * tools on the machine bill you — Claude Code, for one, moves from your
 * subscription to API billing. The cloud providers do read the standard
 * credentials of their own cloud (AWS_*, GOOGLE_*, GEMINI_API_KEY), because that
 * is what those clouds' own tools use and nothing bills differently for it.
 */
export function createProvider(env: NodeJS.ProcessEnv): LlmProvider | undefined {
  const provider = env.DRIFTNET_LLM_PROVIDER?.toLowerCase();
  const model = env.DRIFTNET_LLM_MODEL;
  const apiKey = env.DRIFTNET_LLM_API_KEY;
  if (!provider || provider === "off") return undefined;

  const custom = providerFactory(provider);
  if (custom) return custom(env);

  if (provider === "claude-cli" || provider === "gemini-cli") {
    return new CliProvider({
      kind: provider === "claude-cli" ? "claude" : "gemini",
      ...(model ? { model } : {}),
      ...(env.DRIFTNET_LLM_EFFORT ? { effort: env.DRIFTNET_LLM_EFFORT } : {}),
      ...(env.DRIFTNET_CLI_PATH ? { bin: env.DRIFTNET_CLI_PATH } : {}),
      ...(env.DRIFTNET_CLI_CONCURRENCY ? { concurrency: Math.max(1, Number(env.DRIFTNET_CLI_CONCURRENCY)) } : {}),
    });
  }

  const region = env.DRIFTNET_LLM_REGION?.trim();
  if (provider === "gemini") {
    const key = apiKey || env.GEMINI_API_KEY;
    if (!key) throw new Error("DRIFTNET_LLM_API_KEY (or GEMINI_API_KEY) is required for the gemini provider");
    return new GeminiProvider({ apiKey: key, ...(model ? { model } : {}) });
  }
  if (provider === "bedrock") {
    if (!model) throw new Error("DRIFTNET_LLM_MODEL is required for the bedrock provider (a model id or inference profile id)");
    const awsRegion = region || env.AWS_REGION || env.AWS_DEFAULT_REGION;
    if (!awsRegion) throw new Error("DRIFTNET_LLM_REGION (or AWS_REGION) is required for the bedrock provider");
    const { AWS_ACCESS_KEY_ID: id, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: session, AWS_BEARER_TOKEN_BEDROCK: bearer } = env;
    return new BedrockProvider({
      model,
      region: awsRegion,
      ...(bearer ? { bearerToken: bearer } : {}),
      ...(id && secret ? { credentials: { accessKeyId: id, secretAccessKey: secret, ...(session ? { sessionToken: session } : {}) } } : {}),
    });
  }
  if (provider === "vertex") {
    if (!model) throw new Error("DRIFTNET_LLM_MODEL is required for the vertex provider (a Gemini model id on Vertex)");
    const source = (env.DRIFTNET_VERTEX_CREDENTIALS || env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
    let serviceAccount;
    if (source) {
      let json = source;
      if (!source.startsWith("{")) {
        try {
          json = readFileSync(source, "utf8");
        } catch {
          throw new Error(`the Vertex credentials file ${source} can't be read`);
        }
      }
      serviceAccount = parseServiceAccount(json);
    } else if (!apiKey) {
      throw new Error("the vertex provider needs a service-account key (GOOGLE_APPLICATION_CREDENTIALS or DRIFTNET_VERTEX_CREDENTIALS) or an access token in DRIFTNET_LLM_API_KEY");
    }
    const project = env.GOOGLE_CLOUD_PROJECT || env.GCLOUD_PROJECT;
    return new VertexProvider({
      model,
      region: region || "us-central1",
      ...(project ? { project } : {}),
      ...(serviceAccount ? { serviceAccount } : { accessToken: apiKey! }),
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
      throw new Error(`Unknown DRIFTNET_LLM_PROVIDER=${provider} (expected ${["anthropic", "openai", "gemini", "bedrock", "vertex", "claude-cli", "gemini-cli", ...registeredProviders(), "off"].join(", ")})`);
  }
}
