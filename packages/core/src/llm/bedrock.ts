import type { z } from "zod";
import { failFromResponse, jsonSchemaOf, safeSegment } from "./shared.ts";
import { signRequest, type AwsCredentials } from "./sigv4.ts";
import { IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./types.ts";

export interface BedrockOptions {
  model: string;
  region: string;
  /** SigV4 credentials (IAM keys, optionally temporary with a session token)… */
  credentials?: AwsCredentials;
  /** …or a Bedrock API key, sent as a bearer token. */
  bearerToken?: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Amazon Bedrock through the Converse API, which has the same shape for every
 * model family on it. Requests are signed with SigV4 written in sigv4.ts (no AWS
 * SDK). Converse has no schema-enforced output that every model supports, so the
 * schema goes into the system prompt and the reply is validated with zod, as
 * with any other provider.
 */
export class BedrockProvider implements LlmProvider {
  readonly label: string;
  private readonly host: string;

  constructor(private readonly opts: BedrockOptions) {
    if (!opts.credentials && !opts.bearerToken) throw new Error("bedrock needs AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK");
    this.host = `bedrock-runtime.${safeSegment("region", opts.region)}.amazonaws.com`;
    this.label = `bedrock:${opts.model} @ ${opts.region}`;
  }

  async complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const url = `https://${this.host}/model/${encodeURIComponent(this.opts.model)}/converse`;
    const body = JSON.stringify({
      system: [
        { text: `${req.system}\n\nReply with only one JSON object that matches this JSON Schema, with no other text and no code fence:\n${JSON.stringify(jsonSchemaOf(req.schema))}` },
      ],
      messages: [{ role: "user", content: [{ text: req.user }] }],
      inferenceConfig: { maxTokens: req.maxTokens },
    });
    const base = { "content-type": "application/json" };
    const headers = this.opts.bearerToken
      ? { ...base, authorization: `Bearer ${this.opts.bearerToken}` }
      : signRequest({
          method: "POST",
          url,
          headers: base,
          body,
          region: this.opts.region,
          service: "bedrock",
          credentials: this.opts.credentials!,
          ...(this.opts.now ? { date: this.opts.now() } : {}),
        });
    const res = await (this.opts.fetch ?? fetch)(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) });
    if (!res.ok) await failFromResponse(res, [this.opts.bearerToken, this.opts.credentials?.secretAccessKey, this.opts.credentials?.sessionToken]);
    const data = (await res.json()) as { stopReason?: string; output?: { message?: { content?: { text?: string }[] } } };
    const text = (data.output?.message?.content ?? []).map((c) => c.text ?? "").join("");
    if (!text) throw new IncompleteOutput(data.stopReason ? `no text, stopReason=${data.stopReason}` : "empty reply");
    if (data.stopReason && data.stopReason !== "end_turn" && data.stopReason !== "stop_sequence") throw new IncompleteOutput(`stopReason=${data.stopReason}`);
    return parseStructured(req.schema, text);
  }
}
