import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCategories } from "./categories.ts";
import { JevJudge } from "./judge/jev.ts";
import { Pipeline } from "./pipeline.ts";
import { Store } from "./store.ts";
import { Summarizer } from "./summarize.ts";

export * from "./types.ts";
export { canonicalize, extractUrls } from "./url.ts";
export { registerExtractor, type Extractor } from "./extractors/index.ts";
export { guard } from "./guard.ts";
export { Pipeline } from "./pipeline.ts";
export { Store, type ListQuery, type Reputation } from "./store.ts";
export { renderText } from "./render.ts";
export type { Judge, JudgeResult } from "./judge/index.ts";

export interface Driftnet {
  pipeline: Pipeline;
  store: Store;
  categories: Record<string, string>;
  engines: { judge: string; summarizer: string };
}

/** Wires everything from environment variables. See .env.example. */
export function createDriftnet(env: NodeJS.ProcessEnv = process.env): Driftnet {
  const store = new Store(env.DRIFTNET_DB ?? "./data/driftnet.db");
  const categories = loadCategories();

  const jevKey = env.TYPESAFE_API_KEY ?? readKeyFile(join(homedir(), ".typesafe", "api_key"));
  const judge = jevKey && env.DRIFTNET_JUDGE !== "off" ? new JevJudge(jevKey) : undefined;

  const hasClaude =
    env.DRIFTNET_SUMMARIZER === "on" ||
    (env.DRIFTNET_SUMMARIZER !== "off" && Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE));
  const model = env.DRIFTNET_MODEL ?? "claude-haiku-5-5";
  const summarizer = hasClaude ? new Summarizer(model, env.DRIFTNET_LANGUAGE ?? "English") : undefined;

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
    engines: { judge: judge ? "jev" : summarizer ? "llm" : "heuristic", summarizer: summarizer ? model : "off" },
  };
}

function readKeyFile(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}
