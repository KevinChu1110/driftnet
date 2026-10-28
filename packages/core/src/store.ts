import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Item, Judgement, Kind, ShareContext, Summary, Worth } from "./types.ts";

interface ItemRow {
  id: number; url: string; title: string; kind: string; category: string; worth: string;
  is_ai_tool: number; summary: string | null; judge_engine: string; enriched_by: string | null;
  flags: string; source: string; share_count: number; created_at: string; updated_at: string;
}

export interface Reputation {
  source: string;
  up: number;
  down: number;
  /** Laplace-smoothed share of upvotes, 0..1; 0.5 with no votes. */
  score: number;
}

export interface ListQuery {
  q?: string;
  category?: string;
  kind?: Kind;
  minWorth?: Worth;
  /** Hide items flagged by the pollution guard or down-voted away. Default true. */
  clean?: boolean;
  since?: string;
  limit?: number;
}

const WORTH_ORDER = "CASE worth WHEN 'skip' THEN 0 WHEN 'low' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        worth TEXT NOT NULL,
        is_ai_tool REAL NOT NULL,
        summary TEXT,
        judge_engine TEXT NOT NULL,
        flags TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        share_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE TABLE IF NOT EXISTS aliases (
        url TEXT PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS shares (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT, note TEXT,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
        reason TEXT,
        voter TEXT NOT NULL,
        at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        UNIQUE (item_id, voter)
      );
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS items_category ON items(category);
      CREATE INDEX IF NOT EXISTS items_source ON items(source);
    `);
    // Columns added after the first release.
    const cols = new Set((this.db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of [["claimed_at", "TEXT"], ["claimed_by", "TEXT"], ["enriched_by", "TEXT"]] as const) {
      if (!cols.has(name)) this.db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
    }
  }

  /** Looks up by canonical URL or any URL that previously resolved to the same item. */
  findByUrl(url: string): Item | null {
    const row = this.db
      .prepare("SELECT i.* FROM items i LEFT JOIN aliases a ON a.item_id = i.id WHERE i.url = ? OR a.url = ? LIMIT 1")
      .get(url, url) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  get(id: number): Item | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  upsert(input: {
    url: string; aliases: string[]; title: string; judgement: Judgement; summary: Summary | null;
    flags: string[]; source: string;
  }): Item {
    const { judgement: j } = input;
    const row = this.db
      .prepare(
        `INSERT INTO items (url, title, kind, category, worth, is_ai_tool, summary, judge_engine, flags, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title, kind = excluded.kind, category = excluded.category, worth = excluded.worth,
           is_ai_tool = excluded.is_ai_tool, summary = excluded.summary, judge_engine = excluded.judge_engine,
           flags = excluded.flags, source = excluded.source,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         RETURNING *`,
      )
      .get(
        input.url, input.title, j.kind, j.category, j.worth, j.isAiTool,
        input.summary ? JSON.stringify(input.summary) : null, j.engine, input.flags.join(","), input.source,
      ) as unknown as ItemRow;
    const alias = this.db.prepare("INSERT OR IGNORE INTO aliases (url, item_id) VALUES (?, ?)");
    for (const a of input.aliases) if (a !== input.url) alias.run(a, row.id);
    return toItem(row);
  }

  recordShare(itemId: number, ctx: ShareContext): void {
    this.db
      .prepare("INSERT INTO shares (item_id, platform, chat_id, user_id, note) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, ctx.platform, ctx.chatId, ctx.userId ?? null, ctx.note?.slice(0, 1000) ?? null);
    this.db.prepare("UPDATE items SET share_count = share_count + 1 WHERE id = ?").run(itemId);
  }

  /** One vote per voter per item; voting again replaces the earlier vote. */
  vote(itemId: number, vote: 1 | -1, voter: string, reason?: string): void {
    this.db
      .prepare(
        `INSERT INTO feedback (item_id, vote, voter, reason) VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id, voter) DO UPDATE SET vote = excluded.vote, reason = excluded.reason`,
      )
      .run(itemId, vote, voter, reason ?? null);
  }

  /**
   * Reputation of a source (a GitHub owner, a domain, a channel) from every vote
   * on every item it produced. This is how driftnet "learns" what to skip: no
   * training, just counts that gate the expensive steps.
   */
  reputation(source: string): Reputation {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(f.vote = 1), 0) AS up, COALESCE(SUM(f.vote = -1), 0) AS down
         FROM feedback f JOIN items i ON i.id = f.item_id WHERE i.source = ?`,
      )
      .get(source) as { up: number; down: number };
    return { source, up: r.up, down: r.down, score: (r.up + 1) / (r.up + r.down + 2) };
  }

  /** Small key/value memory for adapters, e.g. the last message seen per channel. */
  getState(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  stateWithPrefix(prefix: string): { key: string; value: string }[] {
    return this.db.prepare("SELECT key, value FROM state WHERE key LIKE ? ESCAPE '\\'").all(
      prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%",
    ) as { key: string; value: string }[];
  }

  setState(key: string, value: string): void {
    this.db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /**
   * Hand out up to `limit` pending items to an agent and lease them for
   * `leaseMinutes`, so two agents working the queue don't do the same item.
   * Most-shared first, then oldest.
   */
  claimPending(agent: string, limit: number, leaseMinutes = 30): Item[] {
    const rows = this.db
      .prepare(
        `UPDATE items SET claimed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), claimed_by = ?
         WHERE id IN (
           SELECT id FROM items
           WHERE ${PENDING_SQL}
             AND (claimed_at IS NULL OR claimed_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now', ?))
           ORDER BY share_count DESC, created_at ASC LIMIT ?)
         RETURNING *`,
      )
      .all(agent, `-${leaseMinutes} minutes`, Math.min(Math.max(limit, 1), 20)) as unknown as ItemRow[];
    return rows.map(toItem).sort((a, b) => b.shareCount - a.shareCount || a.createdAt.localeCompare(b.createdAt));
  }

  pendingCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${PENDING_SQL}`).get() as { n: number }).n;
  }

  /** Notes people shared the link with: the context an agent needs to read it. */
  notes(itemId: number, limit = 5): string[] {
    return (
      this.db.prepare("SELECT note FROM shares WHERE item_id = ? AND note IS NOT NULL ORDER BY at DESC LIMIT ?").all(itemId, limit) as {
        note: string;
      }[]
    ).map((r) => r.note);
  }

  /** Store an agent's summary; optionally its classification. Releases the lease. */
  enrich(id: number, summary: Summary, by: string, classify?: { category?: string; worth?: Worth }): Item {
    const row = this.db
      .prepare(
        `UPDATE items SET summary = ?, title = ?, enriched_by = ?, claimed_at = NULL, claimed_by = NULL,
           category = COALESCE(?, category), worth = COALESCE(?, worth),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? RETURNING *`,
      )
      .get(JSON.stringify(summary), summary.name, by, classify?.category ?? null, classify?.worth ?? null, id) as unknown as ItemRow;
    return toItem(row);
  }

  /** Net votes per item, for hiding items the community voted down. */
  private static readonly NET_VOTES = "(SELECT COALESCE(SUM(vote), 0) FROM feedback f WHERE f.item_id = items.id)";

  list(query: ListQuery = {}): Item[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.category) { where.push("category = ?"); args.push(query.category); }
    if (query.kind) { where.push("kind = ?"); args.push(query.kind); }
    if (query.since) { where.push("created_at >= ?"); args.push(query.since); }
    if (query.minWorth) {
      where.push(`${WORTH_ORDER} >= ${["skip", "low", "normal", "must-see"].indexOf(query.minWorth)}`);
    }
    if (query.clean !== false) {
      where.push("flags NOT LIKE '%injection%'", `${Store.NET_VOTES} > -2`);
    }
    if (query.q) {
      where.push("(title LIKE ? OR summary LIKE ? OR url LIKE ?)");
      const like = `%${query.q}%`;
      args.push(like, like, like);
    }
    const sql = `SELECT * FROM items ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY ${WORTH_ORDER} DESC, updated_at DESC LIMIT ?`;
    args.push(Math.min(query.limit ?? 50, 500));
    return (this.db.prepare(sql).all(...args) as unknown as ItemRow[]).map(toItem);
  }

  stats(): { items: number; shares: number; byCategory: Record<string, number> } {
    const t = this.db
      .prepare("SELECT COUNT(*) AS items, COALESCE(SUM(share_count), 0) AS shares FROM items")
      .get() as { items: number; shares: number };
    const rows = this.db.prepare("SELECT category, COUNT(*) AS n FROM items GROUP BY category").all() as {
      category: string; n: number;
    }[];
    return {
      items: t.items,
      shares: t.shares,
      byCategory: Object.fromEntries(rows.map((r) => [r.category, r.n])),
    };
  }
}

/** SQL twin of isPending(). */
const PENDING_SQL = "summary IS NULL AND worth <> 'skip' AND flags NOT LIKE '%injection%' AND flags NOT LIKE '%low-reputation%'";

/** Worth reading, not blocked, and nobody has summarised it yet. */
function isPending(r: ItemRow): boolean {
  return r.summary === null && r.worth !== "skip" && !/injection|low-reputation/.test(r.flags);
}

function toItem(r: ItemRow): Item {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    kind: r.kind as Kind,
    category: r.category,
    worth: r.worth as Worth,
    isAiTool: r.is_ai_tool,
    summary: r.summary ? (JSON.parse(r.summary) as Summary) : null,
    judgeEngine: r.judge_engine as Judgement["engine"],
    flags: r.flags ? r.flags.split(",") : [],
    source: r.source,
    shareCount: r.share_count,
    pending: isPending(r),
    ...(r.enriched_by ? { enrichedBy: r.enriched_by } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
