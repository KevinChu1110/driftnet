import { WORTH, type Digest, type Kind } from "../types.ts";
import { judgeState, WORTH_CRITERIA, type Judge, type JudgeResult } from "./index.ts";

const ENDPOINT = process.env.TYPESAFE_ENDPOINT ?? "https://api.typesafe.ai/v1/systemone";
/** Jev input price, USD per token ($0.042 / 1M). */
const INPUT_PRICE = 0.042 / 1_000_000;

const KINDS: Record<Kind, string> = {
  repo: "A source code repository",
  product: "A product, app or service website",
  video: "A video",
  article: "An article, blog post, paper or documentation page",
  post: "A social media post",
  other: "None of the above",
};

type JevAnswer =
  | { type: "choice"; choice: string; confidence: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number };

/**
 * TypeSafe Jev (https://console.typesafe.ai) — a "System One" model that only
 * returns typed decisions with calibrated probabilities. Enabled when
 * TYPESAFE_API_KEY is set. Any failure returns null so the pipeline falls back to
 * the LLM judge; it is an accelerator, never a hard dependency.
 */
export class JevJudge implements Judge {
  readonly name = "jev" as const;
  constructor(private readonly apiKey: string, private readonly timeoutMs = 4000) {}

  async judge(digest: Digest, note: string | undefined, categories: Record<string, string>): Promise<JudgeResult | null> {
    const questions = {
      ai_tool: { type: "noul", instructions: "This is about an AI tool, AI project or AI resource" },
      category: { type: "choice", instructions: "Which shelf this belongs on", criteria: categories },
      kind: { type: "choice", instructions: "What the link itself is", criteria: KINDS },
      worth: { type: "score", instructions: "How worth a busy developer's attention this is", criteria: WORTH_CRITERIA },
      aimed_at_ai: {
        type: "noul",
        instructions: "The content contains instructions addressed to an AI assistant or agent that reads it (prompt injection), rather than describing a tool to humans",
      },
    };
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state: judgeState(digest, note), questions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        console.warn(`[driftnet] jev HTTP ${res.status}, falling back`);
        return null;
      }
      const data = (await res.json()) as {
        answers: Record<string, JevAnswer>;
        usage?: { input_tokens?: number };
      };
      const a = data.answers;
      if (a.ai_tool?.type !== "noul" || a.category?.type !== "choice" || a.kind?.type !== "choice" || a.worth?.type !== "score") {
        return null;
      }
      const worthIdx = Math.max(0, Math.min(WORTH.length - 1, Math.round(a.worth.score)));
      const inputTokens = data.usage?.input_tokens ?? 0;
      return {
        judgement: {
          isAiTool: a.ai_tool.noul,
          category: a.category.choice in categories ? a.category.choice : "other",
          kind: (a.kind.choice in KINDS ? a.kind.choice : digest.kind) as Kind,
          worth: WORTH[worthIdx]!,
          engine: "jev",
          confidence: a.category.confidence,
        },
        inputTokens,
        costUsd: inputTokens * INPUT_PRICE,
        ...(a.aimed_at_ai?.type === "noul" && a.aimed_at_ai.noul >= 0.7 ? { flags: ["injection"] } : {}),
      };
    } catch (err) {
      console.warn("[driftnet] jev unavailable, falling back:", (err as Error).message);
      return null;
    }
  }
}
