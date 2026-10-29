import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCategories } from "./categories.ts";
import { JevJudge } from "./judge/jev.ts";
import { Pipeline, type Engines } from "./pipeline.ts";
import { Store } from "./store.ts";
import { createProvider } from "./llm/index.ts";
import type { LlmProvider } from "./llm/types.ts";
import { Summarizer, summaryDepth } from "./summarize.ts";
import { categoryLabel, resolveLocale, type Locale } from "./i18n.ts";
import { sendWebhook } from "./webhook.ts";
import { defaultDbPath } from "./home.ts";

export * from "./types.ts";
export { canonicalize, extractUrls } from "./url.ts";
export { BlockedUrl, registerExtractor, type Extractor } from "./extractors/index.ts";
export { guard } from "./guard.ts";
export { Pipeline, RefreshBusy, RefreshTooSoon } from "./pipeline.ts";
export { DEFAULT_CATEGORIES, FOLDER_TEMPLATES, TEMPLATE_NAMES, isTemplate, loadCategories, applyFolderTemplate, TemplateError, type FolderTemplate } from "./categories.ts";
export { mediaSigOk, normalizeMedia, publicItem, publicMedia, setMediaSecret, type PublicMedia } from "./media.ts";
export { safeFetch } from "./extractors/net.ts";
export { HealthChecker, healthFor, isPrivateTarget } from "./health.ts";
export { cardLink } from "./render.ts";
export { loadPlugins, type PluginApi } from "./plugins.ts";
export { FolderError, ItemError, Store, hashToken, type AgentToken, type Folder, type FolderRow, type Note, type ListQuery, type Reputation, type RepoFacts } from "./store.ts";
export { createProvider, IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./llm/index.ts";
export { Summarizer, summaryDepth, DEPTHS, type Depth } from "./summarize.ts";
export { keywordSuggestions, cleanSuggestions, suggestionsFor } from "./suggest.ts";
export { applyPlan, proposePlan, validatePlan, PlanError, PLAN_MAX_OPS, PLAN_MAX_CARDS, type PlanOp, type PlanResult } from "./folderPlan.ts";
export { defaultDbPath, driftnetHome, loadHomeEnv } from "./home.ts";
export { sendWebhook, sendDigestWebhook, shouldNotify, webhookPayload, signBody } from "./webhook.ts";
export { IMPORT_CAP, IMPORT_FOLDER, IMPORT_FORMATS, detectFormat, importFolder, parseImport, planImport, runImport, type ImportEntry, type ImportFormat, type ImportPlan, type ImportProgress } from "./import.ts";
export { renderLink, renderText } from "./render.ts";
export { categoryLabel, categoryLabels, LOCALES, messages, resolveLocale, type Locale, type Messages } from "./i18n.ts";
export type { Judge, JudgeResult } from "./judge/index.ts";

export interface Driftnet {
  pipeline: Pipeline;
  store: Store;
  /** The reader's folders as the judge sees them (id → path and note). Read fresh on every access. */
  readonly categories: Record<string, string>;
  /** A folder's display name: the reader's name, or the built-in label in `locale`. */
  folderLabel(id: string, locale?: Locale): string;
  /** Like folderLabel, but reads the folder list once: use it when labelling many items. */
  folderLabeler(locale?: Locale): (id: string) => string;
  readonly engines: { judge: string; summarizer: string };
  /** The configured model, or undefined when none is (AI features then say so). */
  readonly llm: LlmProvider | undefined;
  /** Rebuild the judge, model and rules from (new) settings without restarting. */
  reconfigure(env?: NodeJS.ProcessEnv): { judge: string; summarizer: string };
  /** Configuration problems worth printing at startup. */
  warnings: string[];
}

/** Wires everything from environment variables. See .env.example. */
export function createDriftnet(env: NodeJS.ProcessEnv = process.env): Driftnet {
  const store = new Store(env.DRIFTNET_DB ?? defaultDbPath(env));
  // The reader's folder tree is the taxonomy; the built-in shelves only seed it.
  store.seedFolders(loadCategories(env));
  const folderLabel = (id: string, locale: Locale = resolveLocale(env)): string =>
    store.folders().find((f) => f.id === id)?.name ?? categoryLabel(id, locale);
  const folderLabeler = (locale: Locale = resolveLocale(env)) => {
    const names = new Map(store.folders().map((f) => [f.id, f.name]));
    return (id: string): string => names.get(id) ?? categoryLabel(id, locale);
  };
  const choices = () => store.folderChoices((f) => f.name ?? categoryLabel(f.id, "en"));

  let built = buildEngines(env);
  const pipeline = new Pipeline({
    store,
    get categories() {
      return choices();
    },
  });
  pipeline.configure(built.engines);
  // Read per event, so ⚙ Settings can set the webhook without a restart. Fire and forget.
  pipeline.onItem = (item, event) => { if (env.DRIFTNET_WEBHOOK_URL) void sendWebhook(store, item, event, env); };
  store.onTrash = (id, trashed) => {
    const item = store.get(id);
    if (item && env.DRIFTNET_WEBHOOK_URL) void sendWebhook(store, item, trashed ? "item.trashed" : "item.restored", env);
  };
  return {
    pipeline,
    store,
    get categories() {
      return choices();
    },
    folderLabel,
    folderLabeler,
    get engines() {
      return built.labels;
    },
    get llm() {
      return built.llm;
    },
    reconfigure(next = env) {
      built = buildEngines(next);
      pipeline.configure(built.engines);
      return built.labels;
    },
    warnings: [
      // Vendor variables are ignored on purpose (see llm/index.ts); say so instead of failing silently.
      ...(!built.engines.summarizer && (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY)
        ? ["A vendor API key variable is set, but driftnet only reads DRIFTNET_LLM_PROVIDER / DRIFTNET_LLM_MODEL / DRIFTNET_LLM_API_KEY — summaries are off"]
        : []),
    ],
  };
}

/** Judge, model and rules from settings; rebuilt when the settings page saves. */
function buildEngines(env: NodeJS.ProcessEnv): { engines: Engines; labels: { judge: string; summarizer: string }; llm: LlmProvider | undefined } {
  const jevKey = env.TYPESAFE_API_KEY || readKeyFile(join(homedir(), ".typesafe", "api_key"));
  const judge = jevKey && env.DRIFTNET_JUDGE !== "off" ? new JevJudge(jevKey) : undefined;
  const llm = createProvider(env);
  const summarizer = llm ? new Summarizer(llm, env.DRIFTNET_LANGUAGE || "English", env.DRIFTNET_SUMMARY_RULES?.trim() ?? "", summaryDepth(env)) : undefined;
  const blockedDomains = (env.DRIFTNET_BLOCK_DOMAINS ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
  const minConfidence = env.DRIFTNET_MIN_CONFIDENCE ? Number(env.DRIFTNET_MIN_CONFIDENCE) : undefined;
  return {
    llm,
    engines: {
      ...(judge ? { judge } : {}),
      ...(summarizer ? { summarizer } : {}),
      ...(minConfidence !== undefined && Number.isFinite(minConfidence) ? { minConfidence } : {}),
      ...(blockedDomains.length ? { blockedDomains } : {}),
    },
    labels: { judge: judge ? "jev" : summarizer ? "llm" : "heuristic", summarizer: summarizer?.label ?? "off" },
  };
}

function readKeyFile(path: string): string | undefined {
  // A key file we may not read (sandbox, container, wrong owner) means "no key", not a crash at start.
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
