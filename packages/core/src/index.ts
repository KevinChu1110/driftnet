import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCategories } from "./categories.ts";
import { JevJudge } from "./judge/jev.ts";
import { Pipeline } from "./pipeline.ts";
import { Store } from "./store.ts";
import { PRICES, resolveSummaryProfile, Summarizer } from "./summarize.ts";

export * from "./types.ts";
export { canonicalize, extractUrls } from "./url.ts";
export { registerExtractor, type Extractor } from "./extractors/index.ts";
export { guard } from "./guard.ts";
export { Pipeline } from "./pipeline.ts";
export { Store, type ListQuery, type Reputation, type UsageReport } from "./store.ts";
export { renderText } from "./render.ts";
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
  const store = new Store(env.DRIFTNET_DB ?? "./data/driftnet.db");
  const categories = loadCategories();

  const jevKey = env.TYPESAFE_API_KEY ?? readKeyFile(join(homedir(), ".typesafe", "api_key"));
  const judge = jevKey && env.DRIFTNET_JUDGE !== "off" ? new JevJudge(jevKey) : undefined;

  // Not ANTHROPIC_API_KEY on purpose: exporting that makes Claude Code bill your
  // API account instead of your subscription. See Summarizer.
  const anthropicKey = env.DRIFTNET_ANTHROPIC_API_KEY;
  const profile = resolveSummaryProfile(env);
  const summarizer =
    anthropicKey && env.DRIFTNET_SUMMARIZER !== "off"
      ? new Summarizer(anthropicKey, env.DRIFTNET_LANGUAGE ?? "English", profile)
      : undefined;

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
      summarizer: summarizer ? `${profile.model} / ${profile.effort}` : "off",
    },
    warnings: [
      ...(summarizer && !(profile.model in PRICES)
        ? [`${profile.model} is not in the price table; its calls are logged at $0 (add it to PRICES in summarize.ts)`]
        : []),
      ...(!summarizer && env.ANTHROPIC_API_KEY && !anthropicKey
        ? ["ANTHROPIC_API_KEY is set but driftnet reads DRIFTNET_ANTHROPIC_API_KEY — summaries are off"]
        : []),
    ],
  };
}

function readKeyFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}
