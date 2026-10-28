import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCategories } from "./categories.ts";
import { JevJudge } from "./judge/jev.ts";
import { Pipeline } from "./pipeline.ts";
import { Store } from "./store.ts";
import { createProvider } from "./llm/index.ts";
import { Summarizer } from "./summarize.ts";
import { defaultDbPath } from "./home.ts";

export * from "./types.ts";
export { canonicalize, extractUrls } from "./url.ts";
export { BlockedUrl, registerExtractor, type Extractor } from "./extractors/index.ts";
export { guard } from "./guard.ts";
export { Pipeline } from "./pipeline.ts";
export { Store, type ListQuery, type Reputation } from "./store.ts";
export { createProvider, IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./llm/index.ts";
export { Summarizer } from "./summarize.ts";
export { defaultDbPath, driftnetHome, loadHomeEnv } from "./home.ts";
export { renderText } from "./render.ts";
export { categoryLabel, categoryLabels, LOCALES, messages, resolveLocale, type Locale, type Messages } from "./i18n.ts";
export type { Judge, JudgeResult } from "./judge/index.ts";

export interface Driftnet {
  pipeline: Pipeline;
  store: Store;
  categories: Record<string, string>;
  engines: { judge: string; summarizer: string };
  /** Configuration problems worth printing at startup. */
  warnings: string[];
}

/** Wires everything from environment variables. See .env.example. */
export function createDriftnet(env: NodeJS.ProcessEnv = process.env): Driftnet {
  const store = new Store(env.DRIFTNET_DB ?? defaultDbPath(env));
  const categories = loadCategories();

  const jevKey = env.TYPESAFE_API_KEY ?? readKeyFile(join(homedir(), ".typesafe", "api_key"));
  const judge = jevKey && env.DRIFTNET_JUDGE !== "off" ? new JevJudge(jevKey) : undefined;

  const llm = createProvider(env);
  const summarizer = llm ? new Summarizer(llm, env.DRIFTNET_LANGUAGE ?? "English") : undefined;

  const pipeline = new Pipeline({
    store,
    categories,
    ...(judge ? { judge } : {}),
    ...(summarizer ? { summarizer } : {}),
    ...(env.DRIFTNET_MIN_CONFIDENCE ? { minConfidence: Number(env.DRIFTNET_MIN_CONFIDENCE) } : {}),
  });
  return {
    pipeline,
    store,
    categories,
    engines: {
      judge: judge ? "jev" : summarizer ? "llm" : "heuristic",
      summarizer: summarizer?.label ?? "off",
    },
    warnings: [
      // Vendor variables are ignored on purpose (see llm/index.ts); say so instead of failing silently.
      ...(!summarizer && (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY)
        ? ["A vendor API key variable is set, but driftnet only reads DRIFTNET_LLM_PROVIDER / DRIFTNET_LLM_MODEL / DRIFTNET_LLM_API_KEY — summaries are off"]
        : []),
    ],
  };
}

function readKeyFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}
