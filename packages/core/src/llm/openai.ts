import { z } from "zod";
import { IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./types.ts";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Passed as reasoning_effort; only some models accept it. */
  reasoningEffort?: string;
  timeoutMs?: number;
}

/**
 * Any server that speaks the OpenAI Chat Completions API. Uses JSON-schema
 * response_format where supported; the reply is validated with zod either way,
 * so a server that ignores the schema still cannot store malformed data.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly label: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.label = `openai:${opts.model}${opts.baseUrl.includes("api.openai.com") ? "" : ` @ ${new URL(opts.baseUrl).host}`}`;
  }

  async complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        max_completion_tokens: req.maxTokens,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: req.schemaName, strict: true, schema: strictJsonSchema(req.schema) },
        },
        ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      // 429 and 5xx are transient: let the summarizer retry once.
      if (res.status === 429 || res.status >= 500) throw new IncompleteOutput(`HTTP ${res.status}: ${detail}`);
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
    };
    const choice = data.choices?.[0];
    if (!choice?.message?.content) throw new IncompleteOutput(choice?.message?.refusal ? "refused" : "empty reply");
    if (choice.finish_reason && choice.finish_reason !== "stop") throw new IncompleteOutput(`finish_reason=${choice.finish_reason}`);
    return parseStructured(req.schema, choice.message.content);
  }
}

/**
 * OpenAI strict mode wants every object closed and every property required.
 * zod's JSON Schema already lists all non-optional keys as required; close the
 * objects and drop keywords strict mode rejects.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      out[k] = walk(v);
    }
    if (out.type === "object") out.additionalProperties = false;
    return out;
  };
  return walk(z.toJSONSchema(schema)) as Record<string, unknown>;
}
