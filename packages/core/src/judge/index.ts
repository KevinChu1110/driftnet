import type { Digest, Judgement } from "../types.ts";

/**
 * A judge answers multiple-choice questions about a digest. It never writes prose,
 * which is what makes it cheap: Jev answers in ~100 ms for a few hundredths of a
 * cent, and the summarizer only runs on items the judge says are worth it.
 */
export interface Judge {
  name: Judgement["engine"];
  judge(digest: Digest, note: string | undefined, categories: Record<string, string>): Promise<JudgeResult | null>;
}

export interface JudgeResult {
  judgement: Judgement;
  /** Extra pollution flags the judge spotted (e.g. "injection"). */
  flags?: string[];
}

/** The state string every judge sees. Keep it short: it is billed per token. */
export function judgeState(digest: Digest, note: string | undefined): string {
  const meta = Object.entries(digest.meta)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [
    `URL: ${digest.url}`,
    `Title: ${digest.title}`,
    meta && `Meta: ${meta}`,
    note && `Shared with note: ${note.slice(0, 500)}`,
    digest.text && `Content:\n${digest.text.slice(0, 1200)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export const WORTH_CRITERIA = [
  "Spam, ads, giveaways, engagement bait, or nothing concrete to look at",
  "Loosely relevant or a minor variation of a well-known tool",
  "A real tool, project or guide someone could try or learn from",
  "Notably novel or useful: a new capability, a big release, or an exceptionally good resource",
];
