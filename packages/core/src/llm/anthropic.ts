import type { z } from "zod";
import { BlockedUrl, endpointFetch, type EndpointFetch } from "../extractors/net.ts";
import { strictJsonSchema } from "./openai.ts";
import { failFromResponse } from "./shared.ts";
import { IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./types.ts";

const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
type Effort = (typeof EFFORTS)[number];

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
const TIMEOUT_MS = 30_000;

export interface AnthropicOptions {
  baseUrl?: string;
  fetch?: EndpointFetch;
  env?: NodeJS.ProcessEnv;
}

export type AnthropicContentBlock =
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "text"; text: string };

interface MessagesResponse {
  stop_reason?: string | null;
  content?: Array<{ type?: string; text?: unknown }>;
}

/** Claude via the Messages API directly, with structured outputs and a cacheable system prompt. */
export class AnthropicProvider implements LlmProvider {
  readonly label: string;
  readonly media = { images: true };
  private readonly effort: Effort;
  private readonly url: string;
  private readonly fetch: EndpointFetch;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    effort?: string,
    opts?: AnthropicOptions,
  ) {
    // A typo here would 400 every call and the bot would just go quiet.
    if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
      console.warn(`[driftnet] DRIFTNET_LLM_EFFORT=${JSON.stringify(effort)} is not one of ${EFFORTS.join(" / ")}; using low`);
    }
    this.effort = effort && (EFFORTS as readonly string[]).includes(effort) ? (effort as Effort) : "low";
    this.label = `anthropic:${model} / ${this.effort}`;
    const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
    this.url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;
    this.fetch = opts?.fetch ?? endpointFetch(baseUrl, opts?.env);
  }

  async complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent(req) }],
      output_config: {
        effort: this.effort,
        format: { type: "json_schema", schema: strictJsonSchema(req.schema) },
      },
    });
    const headers = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };

    let res: Response | undefined;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        res = await this.fetch(this.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof BlockedUrl || attempt > 0) throw err;
        continue;
      }
      if (res.ok) break;
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await res.body?.cancel();
        continue;
      }
      await failFromResponse(res, [this.apiKey]);
    }

    const data = (await res!.json()) as MessagesResponse;
    // Structured output is only guaranteed for a normal finish.
    if (data.stop_reason !== "end_turn") throw new IncompleteOutput(`stop_reason=${data.stop_reason}`);
    const block = data.content?.find((b) => b.type === "text" && typeof b.text === "string");
    if (!block) throw new IncompleteOutput("empty reply");
    return parseStructured(req.schema, block.text as string);
  }
}

/** Plain text, or `image` blocks (before the text) when frames are attached. Other attachment kinds are ignored. */
export function userContent(req: StructuredRequest<z.ZodType>): string | AnthropicContentBlock[] {
  const images = (req.attachments ?? []).filter((a) => a.type === "image");
  if (!images.length) return req.user;
  return [
    ...images.map((a) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: a.mime, data: (a as { data: string }).data },
    })),
    { type: "text" as const, text: req.user },
  ];
}
