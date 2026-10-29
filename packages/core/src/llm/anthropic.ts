import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { IncompleteOutput, type LlmProvider, type StructuredRequest } from "./types.ts";

const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
type Effort = (typeof EFFORTS)[number];

/** Claude via the official SDK, with structured outputs and a cacheable system prompt. */
export class AnthropicProvider implements LlmProvider {
  readonly label: string;
  readonly media = { images: true };
  private readonly client: Anthropic;
  private readonly effort: Effort;

  constructor(apiKey: string, private readonly model: string, effort?: string) {
    // Key passed explicitly so the SDK never falls back to ANTHROPIC_API_KEY.
    this.client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
    // A typo here would 400 every call and the bot would just go quiet.
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
      console.warn(`[driftnet] DRIFTNET_LLM_EFFORT=${JSON.stringify(effort)} is not one of ${EFFORTS.join(" / ")}; using low`);
    }
    this.effort = effort && (EFFORTS as readonly string[]).includes(effort) ? (effort as Effort) : "low";
    this.label = `anthropic:${model} / ${this.effort}`;
  }

  async complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent(req) }],
      output_config: { effort: this.effort, format: zodOutputFormat(req.schema as any) },
    });
    // Structured output is only guaranteed for a normal finish.
    if (response.stop_reason !== "end_turn") throw new IncompleteOutput(`stop_reason=${response.stop_reason}`);
    if (!response.parsed_output) throw new IncompleteOutput("output did not match the schema");
    return response.parsed_output as z.infer<T>;
  }
}

/** Plain text, or `image` blocks (before the text) when frames are attached. Other attachment kinds are ignored. */
export function userContent(req: StructuredRequest<z.ZodType>): string | Anthropic.ContentBlockParam[] {
  const images = (req.attachments ?? []).filter((a) => a.type === "image");
  if (!images.length) return req.user;
  return [
    ...images.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.mime as "image/jpeg", data: (a as { data: string }).data } })),
    { type: "text" as const, text: req.user },
  ];
}
