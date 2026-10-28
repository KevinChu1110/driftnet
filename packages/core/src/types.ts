/** What kind of thing a link points to, after following it. */
export type Kind = "repo" | "product" | "video" | "article" | "post" | "other";

/** How much the item is worth a human's attention. Ordered low → high. */
export const WORTH = ["skip", "low", "normal", "must-see"] as const;
export type Worth = (typeof WORTH)[number];

/**
 * A compact, token-budgeted description of a link. Extractors build this from
 * cheap sources (APIs, meta tags, README head) so the LLM never sees a full page.
 */
export interface Digest {
  url: string;
  kind: Kind;
  title: string;
  /** Plain text, already trimmed to the extractor's budget. */
  text: string;
  /** Links found inside the content (e.g. the GitHub repo a Threads post talks about). */
  outlinks: string[];
  meta: Record<string, string | number>;
}

export interface Judgement {
  isAiTool: number; // 0..1
  category: string;
  kind: Kind;
  worth: Worth;
  engine: "jev" | "llm" | "heuristic";
  confidence: number; // 0..1, lowest confidence among the questions
}

export interface Summary {
  name: string;
  oneLiner: string;
  highlights: string[];
  useCases: string[];
  tags: string[];
  /** The canonical link to send people to, if better than the shared one. */
  primaryUrl?: string;
  /** Other tools the content talks about — roundup posts mention several. */
  mentions?: { name: string; openSource: boolean }[];
}

export interface Item {
  id: number;
  url: string;
  title: string;
  kind: Kind;
  category: string;
  worth: Worth;
  isAiTool: number;
  summary: Summary | null;
  judgeEngine: Judgement["engine"];
  /** Set by the pollution guard, e.g. "injection", "hidden-chars", "low-reputation". */
  flags: string[];
  /** Who published it (GitHub owner, YouTube channel, domain) — the unit reputation is kept for. */
  source: string;
  shareCount: number;
  /** Worth reading but not summarised yet: waiting for a model or an agent. */
  pending: boolean;
  /** The agent that wrote the summary, when it came from the queue. */
  enrichedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** Who dropped the link, and where. Adapters fill this in. */
export interface ShareContext {
  platform: "line" | "slack" | "discord" | "telegram" | "http" | (string & {});
  chatId: string;
  userId?: string;
  /** The rest of the chat message — often the most useful context for social posts. */
  note?: string;
}

/**
 * What a browser extension saw on the page, logged in: the post text, comments
 * and links that an anonymous fetch cannot reach. Untrusted like any content.
 */
export interface PageContent {
  title?: string;
  text?: string;
  links?: string[];
}

export interface IngestResult {
  item: Item;
  /** true when the item came from the cache: nothing was fetched or sent to a model. */
  cached: boolean;
  /** Repos found from tools the content mentioned by name. */
  related?: IngestResult[];
}
