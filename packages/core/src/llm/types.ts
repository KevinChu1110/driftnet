import type { z } from "zod";

/**
 * The one thing driftnet asks of a language model: fill in a JSON schema.
 * Any provider that can do that plugs in here; nothing else in driftnet knows
 * which model it is talking to.
 */
export interface LlmProvider {
  /** For logs and the startup line, e.g. "openai:gpt-5-mini". */
  readonly label: string;
  complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>>;
}

export interface StructuredRequest<T extends z.ZodType> {
  system: string;
  user: string;
  schema: T;
  /** Short name for the schema, required by some APIs. */
  schemaName: string;
  maxTokens: number;
}

/**
 * Thrown when the model answered but not usefully (truncated, refused, invalid
 * JSON, schema mismatch). Worth one retry. Anything else — auth, bad request,
 * network — is thrown as-is and not retried.
 */
export class IncompleteOutput extends Error {}

/** Parse and validate model text against the schema; any failure is an IncompleteOutput. */
export function parseStructured<T extends z.ZodType>(schema: T, text: string): z.infer<T> {
  let data: unknown;
  try {
    // Some models wrap JSON in a code fence even when asked not to.
    data = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new IncompleteOutput("output is not valid JSON");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new IncompleteOutput(`output does not match the schema: ${parsed.error.message.slice(0, 200)}`);
  return parsed.data;
}
