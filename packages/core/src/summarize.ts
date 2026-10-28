import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { WORTH, type Digest, type Judgement, type Summary } from "./types.ts";
import { judgeState, WORTH_CRITERIA } from "./judge/index.ts";

/** USD per token for the models we price. Unknown models are logged at $0. */
const PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1e-6, cachedInput: 0.01e-6, output: 0.5e-6 },
  "claude-sonnet-5-5": { input: 2e-6, cachedInput: 0.2e-6, output: 10e-6 },
  "claude-opus-5-5": { input: 4e-6, cachedInput: 0.2e-6, output: 20e-6 },
};

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

export interface SummarizeResult {
  summary: Summary | null;
  judgement?: Judgement;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class Summarizer {
  private readonly client = new Anthropic();
  constructor(
    private readonly model: string,
    private readonly language: string,
  ) {}

  /**
   * One request per item. The system prompt is byte-stable (no dates, no ids) so
   * it is served from the prompt cache once it grows past the model's minimum.
   * Pass `categories` only when no judge ran; the same call then classifies too.
   */
  async summarize(digest: Digest, note: string | undefined, categories?: Record<string, string>): Promise<SummarizeResult> {
    const schema = categories ? withJudgement(Object.keys(categories)) : SummarySchema;
    const system = [
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

    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: judgeState(digest, note) + linkList(digest) }],
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });

    const usage = response.usage;
    const price = PRICES[this.model] ?? { input: 0, cachedInput: 0, output: 0 };
    const cached = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    const result: SummarizeResult = {
      summary: null,
      inputTokens: usage.input_tokens + written,
      cachedTokens: cached,
      outputTokens: usage.output_tokens,
      costUsd:
        usage.input_tokens * price.input +
        written * price.input * 1.25 +
        cached * price.cachedInput +
        usage.output_tokens * price.output,
    };

    const out = response.parsed_output as (z.infer<typeof SummarySchema> & Partial<z.infer<ReturnType<typeof withJudgement>>>) | null;
    if (response.stop_reason === "refusal" || !out) return result;

    result.summary = {
      name: out.name,
      oneLiner: out.one_liner,
      highlights: out.highlights.slice(0, 3),
      useCases: out.use_cases.slice(0, 2),
      tags: out.tags.slice(0, 5).map((t) => t.toLowerCase()),
      ...(out.primary_url ? { primaryUrl: out.primary_url } : {}),
      ...(out.mentions.length ? { mentions: out.mentions.slice(0, 6).map((m) => ({ name: m.name, openSource: m.open_source })) } : {}),
    };
    if (out.category && out.kind && out.worth && out.ai_tool !== undefined) {
      result.judgement = {
        isAiTool: out.ai_tool ? 1 : 0,
        category: out.category,
        kind: out.kind,
        worth: out.worth,
        engine: "llm",
        confidence: 1,
      };
    }
    return result;
  }
}

function linkList(digest: Digest): string {
  return digest.outlinks.length ? `\nLinks found inside:\n${digest.outlinks.join("\n")}` : "";
}
