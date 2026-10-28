import { z } from "zod";
import { WORTH, type Digest, type Judgement, type Summary } from "./types.ts";
import { judgeState, WORTH_CRITERIA } from "./judge/index.ts";
import { IncompleteOutput, type LlmProvider } from "./llm/types.ts";

const SummarySchema = z.object({
  name: z
    .string()
    .describe("The tool's own name exactly as its authors write it (e.g. ascii-sharks), never translated; not the post title"),
  one_liner: z.string().describe("What it is, in one sentence of at most 40 characters for CJK or 20 words otherwise"),
  highlights: z.array(z.string()).describe("Up to 3 concrete things it does"),
  use_cases: z.array(z.string()).describe("Up to 2 situations where someone would reach for it"),
  tags: z.array(z.string()).describe("Up to 5 short lowercase tags"),
  primary_url: z.string().describe("Best link to the tool itself (repo or official site) if it appears in the input, else empty"),
  repo_guess: z
    .string()
    .describe(
      "If this is an open-source project and its repository is not linked, your best guess of the GitHub repository name, " +
        "e.g. ascii-sharks. Only the name, no owner. driftnet checks it on GitHub. Empty if unsure or not open source",
    ),
  mentions: z
    .array(z.object({ name: z.string(), open_source: z.boolean() }))
    .describe(
      "Other named tools, models or projects the content introduces or recommends (max 6), excluding the main one. " +
        "Leave out anything named only for comparison, as background, as a dependency, or to criticise it. Empty if none",
    ),
});

/** Used when there is no judge: one call answers the judge questions and writes the summary. */
function withJudgement(categories: string[]) {
  return SummarySchema.extend({
    ai_tool: z.boolean(),
    category: z.enum(categories as [string, ...string[]]),
    kind: z.enum(["repo", "product", "video", "article", "post", "other"]),
    worth: z.enum(WORTH),
  });
}

type Parsed = z.infer<typeof SummarySchema> & Partial<z.infer<ReturnType<typeof withJudgement>>>;

/**
 * What an agent working the queue sends back: the same fields the built-in
 * summariser produces, plus an optional re-classification once it has actually
 * read the thing.
 */
export function enrichSchema(categories: string[]) {
  return SummarySchema.extend({
    mentions: SummarySchema.shape.mentions.default([]),
    repo_guess: SummarySchema.shape.repo_guess.default(""),
    primary_url: SummarySchema.shape.primary_url.default(""),
    use_cases: SummarySchema.shape.use_cases.default([]),
    tags: SummarySchema.shape.tags.default([]),
    category: z.enum(categories as [string, ...string[]]).optional(),
    worth: z.enum(WORTH).optional(),
  });
}

/** Same lenient-in, strict-out cleaning as model output. */
export function normalizeSummary(out: z.infer<typeof SummarySchema>): Summary {
  return normalize(out as Parsed).summary!;
}

export interface SummarizeResult {
  summary: Summary | null;
  judgement?: Judgement;
  /** The model's guess of the repo name, to be verified on GitHub — never stored as-is. */
  repoGuess?: string;
  /** Set when every attempt failed. */
  error?: string;
}

export class Summarizer {
  constructor(
    private readonly llm: LlmProvider,
    private readonly language: string,
  ) {}

  get label(): string {
    return this.llm.label;
  }

  /**
   * One request per item, retried once when the model answered but not usefully
   * (truncated, refused, malformed). Auth and bad-request errors are not retried:
   * a second try will not fix them. The system prompt is byte-stable (no dates,
   * no ids) so providers with prompt caching can reuse it.
   * Pass `categories` only when no judge ran; the same call then classifies too.
   */
  async summarize(digest: Digest, note: string | undefined, categories?: Record<string, string>): Promise<SummarizeResult> {
    const schema = categories ? withJudgement(Object.keys(categories)) : SummarySchema;
    let error = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = (await this.llm.complete({
          system: this.systemPrompt(categories),
          user: judgeState(digest, note) + linkList(digest),
          schema,
          schemaName: "link_summary",
          // Thinking models (Gemini 3, Claude) count reasoning against this cap.
          maxTokens: 4096,
        })) as Parsed;
        return normalize(out);
      } catch (err) {
        error = (err as Error).message;
        if (!(err instanceof IncompleteOutput)) break;
        // Rate limits and overloads need a moment; an immediate retry just fails again.
        if (attempt === 1 && /\b(429|5\d\d)\b/.test(error)) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    console.warn(`[driftnet] summary failed for ${digest.url}: ${error}`);
    return { summary: null, error };
  }

  private systemPrompt(categories: Record<string, string> | undefined): string {
    return [
      "You catalogue AI tools that people share in group chats.",
      "Read the link digest and describe the tool itself, not the post that mentions it.",
      "If the content is a roundup of several tools, describe the roundup and list every tool it introduces in mentions.",
      "mentions is for tools a reader should look at next, never for tools the content argues against or only compares with.",
      `Write one_liner, highlights and use_cases in ${this.language}.`,
      "Never translate name: it is how people search for the tool (e.g. on GitHub). Keep the original spelling, usually English.",
      "Be concrete and terse. Never invent features that are not in the input.",
      "Reply with JSON only.",
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
function normalize(out: Parsed): SummarizeResult {
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

  const result: SummarizeResult = { summary };
  const guess = typeof out.repo_guess === "string" ? out.repo_guess.trim() : "";
  if (/^[A-Za-z0-9._-]{3,100}$/.test(guess)) result.repoGuess = guess;
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
