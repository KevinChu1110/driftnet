import type { z } from "zod";
import { failFromResponse, jsonSchemaOf } from "./shared.ts";
import { IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./types.ts";

/** Used when DRIFTNET_LLM_MODEL is empty. An alias that always points at the current Flash model, so nothing here goes stale. */
export const GEMINI_DEFAULT_MODEL = "gemini-flash-latest";

/** The generateContent request body, shared by the Gemini API and Vertex AI. */
export function generateContentBody<T extends z.ZodType>(req: StructuredRequest<T>): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      responseMimeType: "application/json",
      responseJsonSchema: jsonSchemaOf(req.schema),
    },
  };
}

interface GenerateContentResponse {
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  promptFeedback?: { blockReason?: string };
}

/** The generateContent reply → validated data; anything but a clean finish is an IncompleteOutput. */
export function parseGenerateContent<T extends z.ZodType>(schema: T, data: GenerateContentResponse): z.infer<T> {
  if (data.promptFeedback?.blockReason) throw new IncompleteOutput(`blocked: ${data.promptFeedback.blockReason}`);
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (!text) throw new IncompleteOutput(cand?.finishReason ? `no text, finishReason=${cand.finishReason}` : "empty reply");
  if (cand?.finishReason && cand.finishReason !== "STOP") throw new IncompleteOutput(`finishReason=${cand.finishReason}`);
  return parseStructured(schema, text);
}

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

const HOST = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Google's Generative Language API (AI Studio keys) directly, with JSON-schema
 * output. The host is fixed, so this needs no SSRF guard.
 */
export class GeminiProvider implements LlmProvider {
  readonly label: string;
  private readonly model: string;

  constructor(private readonly opts: GeminiOptions) {
    this.model = (opts.model || GEMINI_DEFAULT_MODEL).replace(/^models\//, "");
    this.label = `gemini:${this.model}`;
  }

  async complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const res = await (this.opts.fetch ?? fetch)(`${HOST}/models/${encodeURIComponent(this.model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
      body: JSON.stringify(generateContentBody(req)),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) await failFromResponse(res, [this.opts.apiKey]);
    return parseGenerateContent(req.schema, (await res.json()) as GenerateContentResponse);
  }
}
