import { z } from "zod";
import { IncompleteOutput } from "./types.ts";

/** zod → plain JSON Schema (no `$schema` key, which several vendor APIs reject). */
export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/** Hide every occurrence of a secret in text that may reach a log or an error. */
export function redact(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("***");
  return out;
}

/**
 * Turn a failed vendor response into an error that carries the vendor's own
 * message (Google, AWS and others all put a readable one in the JSON body) and
 * never a key. 429 and 5xx are transient, so they are an IncompleteOutput and
 * the summarizer retries once; everything else is thrown as-is.
 */
export async function failFromResponse(res: Response, secrets: readonly (string | undefined)[]): Promise<never> {
  const raw = await res.text().catch(() => "");
  let detail = raw;
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string; Message?: string };
    const msg = typeof j.error === "string" ? j.error : j.error?.message ?? j.message ?? j.Message;
    if (msg) detail = msg;
  } catch {
    // not JSON: keep the text
  }
  const text = `HTTP ${res.status}: ${redact(detail, secrets).replace(/\s+/g, " ").slice(0, 300)}`;
  if (res.status === 429 || res.status >= 500) throw new IncompleteOutput(text);
  throw new Error(text);
}

/** A region or project id goes into a hostname or path: keep it to the characters those allow. */
export function safeSegment(name: string, value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(value)) throw new Error(`${name} ${JSON.stringify(value)} is not a valid ${name}`);
  return value;
}
