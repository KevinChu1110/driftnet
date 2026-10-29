/** What kind of thing a link points to, after following it. */
export type Kind = "repo" | "product" | "video" | "article" | "post" | "other";

/** What the periodic link check found; null/absent = never checked. */
export const HEALTH = ["ok", "dead", "archived", "stale", "moved"] as const;
export type Health = (typeof HEALTH)[number];

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
  /** Candidate pictures (original URLs), best first. */
  media?: MediaRef[];
}

/** A picture or GIF that shows what the thing looks like. `url` is the third-party original; pages only ever see the proxy path. */
export interface MediaRef {
  url: string;
  /** "video": the image is a thumbnail and the card links to the video. */
  kind: "image" | "gif" | "video";
  alt: string;
}

export interface Judgement {
  isAiTool: number; // 0..1
  category: string;
  kind: Kind;
  worth: Worth;
  /** Which judge decided: "jev", "llm", "heuristic", "rules", or the name of a registered judge. */
  engine: string;
  confidence: number; // 0..1, lowest confidence among the questions
}

export interface Summary {
  name: string;
  oneLiner: string;
  highlights: string[];
  useCases: string[];
  tags: string[];
  /** What a person sees or gets when using it; null/absent when unknown (older cards have neither). */
  demo?: string | null;
  /** Why it is worth a look for this reader, from the chat/note/post; null when there is no signal. */
  why?: string | null;
  /** Install/run command or first step (detailed depth only). */
  tryIt?: string | null;
  /** The canonical link to send people to, if better than the shared one. */
  primaryUrl?: string;
  /** Other tools the content talks about — roundup posts mention several. */
  mentions?: { name: string; openSource: boolean }[];
}

/** A folder the classifier thought a card could go into, with its confidence (0..1). */
export interface Suggestion {
  folder: string;
  score: number;
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
  /** Starred by the reader. */
  favorite: boolean;
  /** Set while the item is in the trash. */
  trashedAt?: string;
  /** The agent that wrote the summary, when it came from the queue. */
  enrichedBy?: string;
  /** The reader's own note. */
  note?: string;
  /** Up to 3 folders the card could go into, best first (the Inbox shows them as one-tap chips). */
  suggestions?: Suggestion[];
  /** True once the reader (or an agent) filed the card by hand; the Inbox holds the ones that are not. */
  placed?: boolean;
  /** Up to 6 pictures, best first (original URLs; see publicMedia for what the API exposes). */
  media?: MediaRef[];
  /** Link health from the last check (null: not checked yet). */
  health?: Health | null;
  healthCheckedAt?: string | null;
  /** GitHub stars, for repos (null: unknown). */
  stars?: number | null;
  /** When the repo last saw a push (ISO date or timestamp). */
  pushedAt?: string | null;
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
