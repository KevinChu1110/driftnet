import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { WORTH, type Digest, type Judgement, type Summary } from "./types.ts";
import { judgeState, WORTH_CRITERIA } from "./judge/index.ts";

/**
 * USD per token, copied from the official pricing page (2026-10). Only used for
 * the cost ledger; the real bill is in the Claude Console. A model missing here is
 * logged at $0 and flagged at startup.
 */
export const PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1e-6, cachedInput: 0.01e-6, output: 0.5e-6 },
  "claude-sonnet-5-5": { input: 2e-6, cachedInput: 0.2e-6, output: 10e-6 },
  "claude-opus-5-5": { input: 4e-6, cachedInput: 0.2e-6, output: 20e-6 },
};

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * Model and effort for summaries, overridable with DRIFTNET_SUMMARY_MODEL /
 * DRIFTNET_SUMMARY_EFFORT. A two-line summary is not a reasoning problem, so the
 * default is the smallest model at low effort.
 *
 * A typo in the effort ("hgih") would make every call 400 and the bot go quiet
 * with nothing in chat to explain why — fall back to the default and say so.
 */
export function resolveSummaryProfile(env: NodeJS.ProcessEnv = process.env): { model: string; effort: Effort } {
  const effort = env.DRIFTNET_SUMMARY_EFFORT ?? "low";
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    console.warn(`[driftnet] DRIFTNET_SUMMARY_EFFORT=${JSON.stringify(effort)} is not one of ${EFFORTS.join(" / ")}; using low`);
  }
  return {
    model: env.DRIFTNET_SUMMARY_MODEL ?? "claude-haiku-5-5",
    effort: (EFFORTS as readonly string[]).includes(effort) ? (effort as Effort) : "low",
  };
}

const SummarySchema = z.object({
  name: z.string().describe("The tool or project name, not the post title"),
  one_liner: z.string().describe("What it is, in one sentence of at most 40 characters for CJK or 20 words otherwise"),
  highlights: z.array(z.string()).describe("Up to 3 concrete things it does"),
  use_cases: z.array(z.string()).describe("Up to 2 situations where someone would reach for it"),
  tags: z.array(z.string()).describe("Up to 5 short lowercase tags"),
  primary_url: z.string().describe("Best link to the tool itself (repo or official site) if it appears in the input, else empty"),
  mentions: z
    .array(z.object({ name: z.string(), open_source: z.boolean() }))
    .describe("Other named tools, models or projects the content introduces (max 6), excluding the main one; empty if none"),
});

/** Used when there is no Jev key: one call answers the judge questions and writes the summary. */
function withJudgement(categories: string[]) {
  return SummarySchema.extend({
    ai_tool: z.boolean(),
    category: z.enum(categories as [string, ...string[]]),
    kind: z.enum(["repo", "product", "video", "article", "post", "other"]),
    worth: z.enum(WORTH),
  });
}

type Parsed = z.infer<typeof SummarySchema> & Partial<z.infer<ReturnType<typeof withJudgement>>>;

export interface SummarizeResult {
  summary: Summary | null;
  judgement?: Judgement;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Set when every attempt failed; tokens spent on failed attempts are still counted. */
  error?: string;
}

/** The output did not finish cleanly (refusal, truncation, unparseable) — worth one retry. */
class IncompleteOutput extends Error {}

export class Summarizer {
  private readonly client: Anthropic;
  readonly model: string;
  readonly effort: Effort;

  /**
   * The key is passed explicitly so the SDK never falls back to ANTHROPIC_API_KEY:
   * exporting that variable makes Claude Code switch from your subscription to
   * API billing, so driftnet uses its own DRIFTNET_ANTHROPIC_API_KEY.
   */
  constructor(apiKey: string, private readonly language: string, profile = resolveSummaryProfile()) {
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
    this.model = profile.model;
    this.effort = profile.effort;
  }

  /**
   * One request per item, retried once if the output did not finish cleanly.
   * Rate limits and 5xx get the SDK's single retry; auth and bad-request errors
   * are not retried here, a second try will not fix them.
   * The system prompt is byte-stable (no dates, no ids) so it can be cached.
   * Pass `categories` only when no judge ran; the same call then classifies too.
   */
  async summarize(digest: Digest, note: string | undefined, categories?: Record<string, string>): Promise<SummarizeResult> {
    const result: SummarizeResult = {
      summary: null, model: this.model, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0,
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await this.request(digest, note, categories, result);
        Object.assign(result, normalize(out));
        delete result.error;
        return result;
      } catch (err) {
        result.error = (err as Error).message;
        if (!(err instanceof IncompleteOutput)) break;
      }
    }
    console.warn(`[driftnet] summary failed for ${digest.url}: ${result.error}`);
    return result;
  }

  private async request(
    digest: Digest, note: string | undefined, categories: Record<string, string> | undefined, acc: SummarizeResult,
  ): Promise<Parsed> {
    const schema = categories ? withJudgement(Object.keys(categories)) : SummarySchema;
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      system: [{ type: "text", text: this.systemPrompt(categories), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: judgeState(digest, note) + linkList(digest) }],
      output_config: { effort: this.effort, format: zodOutputFormat(schema) },
    });

    const usage = response.usage;
    const price = PRICES[this.model] ?? { input: 0, cachedInput: 0, output: 0 };
    const cached = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    acc.inputTokens += usage.input_tokens + written;
    acc.cachedTokens += cached;
    acc.outputTokens += usage.output_tokens;
    acc.costUsd +=
      usage.input_tokens * price.input + written * price.input * 1.25 + cached * price.cachedInput + usage.output_tokens * price.output;

    // Structured output is only guaranteed for a normal finish.
    if (response.stop_reason !== "end_turn") throw new IncompleteOutput(`stop_reason=${response.stop_reason}`);
    if (!response.parsed_output) throw new IncompleteOutput("output did not match the schema");
    return response.parsed_output as Parsed;
  }

  private systemPrompt(categories: Record<string, string> | undefined): string {
    return [
      "You catalogue AI tools that people share in group chats.",
      "Read the link digest and describe the tool itself, not the post that mentions it.",
      "If the content is a roundup of several tools, describe the roundup and list every tool in mentions.",
      `Write name as-is; write one_liner, highlights and use_cases in ${this.language}.`,
      "Be concrete and terse. Never invent features that are not in the input.",
      categories &&
        [
          "Also classify it.",
          "category — pick one:",
          ...Object.entries(categories).map(([k, v]) => `- ${k}: ${v}`),
          "worth — pick one:",
          ...WORTH.map((w, i) => `- ${w}: ${WORTH_CRITERIA[i]}`),
        ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * Lenient in, strict out: model output is stored for good and shown to people and
 * agents, so drop anything that is not a clean, short, unique string rather than
 * failing the whole item over one bad field.
 */
function normalize(out: Parsed): Pick<SummarizeResult, "summary" | "judgement"> {
  const summary: Summary = {
    name: cleanText(out.name, 80) || "(unnamed)",
    oneLiner: cleanText(out.one_liner, 160),
    highlights: cleanList(out.highlights, 3, 120),
    useCases: cleanList(out.use_cases, 2, 120),
    tags: cleanList(out.tags.map((t) => t.toLowerCase().replace(/^#/, "")), 5, 24),
  };
  if (/^https?:\/\//.test(out.primary_url)) summary.primaryUrl = out.primary_url.trim();
  const mentions = out.mentions
    .filter((m, i, all) => cleanText(m.name, 60) && all.findIndex((x) => x.name === m.name) === i)
    .slice(0, 6)
    .map((m) => ({ name: m.name.trim(), openSource: m.open_source }));
  if (mentions.length) summary.mentions = mentions;

  const result: Pick<SummarizeResult, "summary" | "judgement"> = { summary };
  if (out.category && out.kind && out.worth && out.ai_tool !== undefined) {
    result.judgement = {
      isAiTool: out.ai_tool ? 1 : 0, category: out.category, kind: out.kind, worth: out.worth, engine: "llm", confidence: 1,
    };
  }
  return result;
}

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? text.slice(0, maxChars - 1) + "…" : text;
}

/** Non-strings, blanks, over-long entries (sentences, not items) and duplicates are dropped. */
export function cleanList(value: unknown, limit: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const text = v.replace(/\s+/g, " ").trim();
    if (!text || text.length > maxChars || out.includes(text)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function linkList(digest: Digest): string {
  return digest.outlinks.length ? `\nLinks found inside:\n${digest.outlinks.join("\n")}` : "";
}
