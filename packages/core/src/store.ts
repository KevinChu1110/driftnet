import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Item, Judgement, Kind, ShareContext, Summary, Worth } from "./types.ts";
import { categoryLabel, LOCALES } from "./i18n.ts";

interface ItemRow {
  id: number; url: string; title: string; kind: string; category: string; worth: string;
  is_ai_tool: number; summary: string | null; judge_engine: string; enriched_by: string | null;
  trashed_at: string | null; favorite: number; note: string | null;
  flags: string; source: string; share_count: number; created_at: string; updated_at: string;
}

export interface Reputation {
  source: string;
  up: number;
  down: number;
  /** Laplace-smoothed share of upvotes, 0..1; 0.5 with no votes. */
  score: number;
}

export interface Folder {
  id: string;
  parent: string | null;
  /** null: a built-in shelf, shown with its translated label until renamed. */
  name: string | null;
  description: string;
  position: number;
  /** Items directly in this folder (not counting sub-folders), trash excluded. */
  count: number;
}

export class FolderError extends Error {}
/** A bulk action named an item that doesn't exist; nothing was changed. */
export class ItemError extends Error {}

/** A free-standing note: Markdown, may point at items as #12. */
export interface Note {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListQuery {
  /** all (default, trash excluded), favorites, or trash. */
  view?: "all" | "favorites" | "trash";
  q?: string;
  category?: string;
  kind?: Kind;
  minWorth?: Worth;
  /** Hide items flagged by the pollution guard or down-voted away. Default true. */
  clean?: boolean;
  since?: string;
  /** best (worth, then recent; the default) | newest | shared (most shared first). */
  sort?: "best" | "newest" | "shared";
  limit?: number;
}

/** Untrusted numbers (query strings, JSON bodies) → an integer in range, never NaN. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
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
      -- The reader's own tree of shelves. Items point at a folder through items.category.
      -- name NULL = a built-in shelf still showing its translated label.
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES folders(id),
        name TEXT,
        description TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0
      );
      -- "child was found inside parent": repos named or linked in a post.
      CREATE TABLE IF NOT EXISTS found_in (
        parent_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        child_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        PRIMARY KEY (parent_id, child_id)
      );
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE INDEX IF NOT EXISTS items_category ON items(category);
      CREATE INDEX IF NOT EXISTS shares_item ON shares(item_id);
      CREATE INDEX IF NOT EXISTS items_source ON items(source);
    `);
    // Columns added after the first release.
    const cols = new Set((this.db.prepare("PRAGMA table_info(items)").all() as { name: string }[]).map((c) => c.name));
    // Links recorded before found_in existed live in share notes; recover them once.
    this.db.exec(`
      INSERT OR IGNORE INTO found_in (parent_id, child_id)
      SELECT p.id, s.item_id FROM shares s
      JOIN items p ON p.url = substr(s.note, CASE WHEN s.note LIKE 'Mentioned in %' THEN 14 ELSE 13 END)
      WHERE (s.note LIKE 'Mentioned in %' OR s.note LIKE 'Linked from %') AND p.id <> s.item_id`);
    for (const [name, type] of [
      ["claimed_at", "TEXT"], ["claimed_by", "TEXT"], ["enriched_by", "TEXT"],
      ["trashed_at", "TEXT"], ["favorite", "INTEGER NOT NULL DEFAULT 0"],
      // 1 once the reader moved the item: nobody re-classifies it after that.
      ["user_placed", "INTEGER NOT NULL DEFAULT 0"],
      // The reader's own words about the item.
      ["note", "TEXT"],
    ] as const) {
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
    // Shared again after being trashed: someone wants it, so it comes back.
    this.db.prepare("UPDATE items SET share_count = share_count + 1, trashed_at = NULL WHERE id = ?").run(itemId);
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  /** First run: the built-in (or DRIFTNET_CATEGORIES) shelves become the starting tree. */
  seedFolders(seed: Record<string, string>): void {
    const has = this.db.prepare("SELECT COUNT(*) AS n FROM folders").get() as { n: number };
    if (has.n > 0) return;
    const insert = this.db.prepare("INSERT INTO folders (id, description, position) VALUES (?, ?, ?)");
    Object.entries(seed).forEach(([id, description], i) => insert.run(id, description, i));
    if (!("other" in seed)) insert.run("other", "Anything that fits none of the above", Object.keys(seed).length);
  }

  folders(): Folder[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.parent_id AS parent, f.name, f.description, f.position,
                (SELECT COUNT(*) FROM items i WHERE i.category = f.id AND i.trashed_at IS NULL) AS count
         FROM folders f ORDER BY f.position, f.id`,
      )
      .all() as unknown as Folder[];
    return rows.map((r) => ({ id: r.id, parent: r.parent ?? null, name: r.name ?? null, description: r.description, position: r.position, count: r.count }));
  }

  /** A folder and every folder below it. */
  descendants(id: string): string[] {
    const all = this.folders();
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const f of all) if (f.parent === out[i]) out.push(f.id);
    return out;
  }

  createFolder(input: { name: string; description?: string; parent?: string | null }): Folder {
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new FolderError("a folder needs a name");
    const parent = input.parent || null;
    if (parent && !this.folderExists(parent)) throw new FolderError(`no folder ${parent}`);
    // Two folders with the same name side by side can't be told apart (in the tree, or by the classifier).
    // A built-in folder goes by its label in every language ("Other", "其他"), not just its id.
    const names = (f: Folder) => (f.name ? [f.name] : [f.id, ...LOCALES.map((l) => categoryLabel(f.id, l))]).map((x) => x.toLowerCase());
    if (this.folders().some((f) => (f.parent ?? null) === parent && names(f).includes(name.toLowerCase()))) {
      throw new FolderError(`there is already a folder called “${name}” here`);
    }
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    let id = base.length >= 2 ? base : `f-${Math.random().toString(36).slice(2, 8)}`;
    while (this.folderExists(id)) id = `${base || "f"}-${Math.random().toString(36).slice(2, 6)}`;
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM folders WHERE parent_id IS ?").get(parent) as { p: number }).p;
    this.db.prepare("INSERT INTO folders (id, parent_id, name, description, position) VALUES (?, ?, ?, ?, ?)")
      .run(id, parent, name, (input.description ?? "").trim().slice(0, 300), position);
    return this.folders().find((f) => f.id === id)!;
  }

  updateFolder(id: string, patch: { name?: string; description?: string; parent?: string | null; position?: number }): Folder {
    if (!this.folderExists(id)) throw new FolderError(`no folder ${id}`);
    if (patch.parent !== undefined && patch.parent !== null) {
      if (!this.folderExists(patch.parent)) throw new FolderError(`no folder ${patch.parent}`);
      if (this.descendants(id).includes(patch.parent)) throw new FolderError("a folder can't go inside itself");
    }
    if (patch.name !== undefined && !patch.name.trim()) throw new FolderError("a folder needs a name");
    this.db
      .prepare(
        `UPDATE folders SET
           name = COALESCE(?, name), description = COALESCE(?, description),
           parent_id = CASE WHEN ? THEN ? ELSE parent_id END, position = COALESCE(?, position)
         WHERE id = ?`,
      )
      .run(
        patch.name?.trim().slice(0, 60) ?? null, patch.description?.trim().slice(0, 300) ?? null,
        patch.parent !== undefined ? 1 : 0, patch.parent ?? null, patch.position ?? null, id,
      );
    return this.folders().find((f) => f.id === id)!;
  }

  /** Items and sub-folders move up one level ("other" if there is no parent). "other" itself stays. */
  deleteFolder(id: string): void {
    if (id === "other") throw new FolderError("“other” catches everything unsorted and can't be deleted");
    const row = this.db.prepare("SELECT parent_id AS parent FROM folders WHERE id = ?").get(id) as { parent: string | null } | undefined;
    if (!row) throw new FolderError(`no folder ${id}`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE items SET category = ? WHERE category = ?").run(row.parent ?? "other", id);
      this.db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").run(row.parent, id);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** The reader put this item here; classification won't touch it again. */
  moveItem(itemId: number, folderId: string): boolean {
    if (!this.folderExists(folderId)) throw new FolderError(`no folder ${folderId}`);
    return this.db.prepare("UPDATE items SET category = ?, user_placed = 1 WHERE id = ?").run(folderId, itemId).changes > 0;
  }

  /** Move many items at once, all or nothing. Returns each item's earlier folder so the whole batch can be undone. */
  moveItems(ids: number[], folderId: string): { id: number; category: string; user_placed: number }[] {
    if (!this.folderExists(folderId)) throw new FolderError(`no folder ${folderId}`);
    return this.inTransaction(ids, "category, user_placed", (id, before) => {
      this.db.prepare("UPDATE items SET category = ?, user_placed = 1 WHERE id = ?").run(folderId, id);
      return { id, category: String(before.category), user_placed: Number(before.user_placed) };
    });
  }

  /** Put items back exactly as an earlier bulk action found them (folder and placement, trash, star). */
  restoreItems(rows: { id: number; category?: string; user_placed?: number; trashed_at?: string | null; favorite?: number }[]): void {
    const ids = rows.map((r) => r.id);
    for (const r of rows) if (r.category !== undefined && !this.folderExists(r.category)) throw new FolderError(`no folder ${r.category}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    this.inTransaction(ids, "id", (id) => {
      const r = byId.get(id)!;
      if (r.category !== undefined) this.db.prepare("UPDATE items SET category = ?, user_placed = ? WHERE id = ?").run(r.category, r.user_placed ?? 0, id);
      if (r.trashed_at !== undefined) this.db.prepare("UPDATE items SET trashed_at = ? WHERE id = ?").run(r.trashed_at, id);
      if (r.favorite !== undefined) this.db.prepare("UPDATE items SET favorite = ? WHERE id = ?").run(r.favorite ? 1 : 0, id);
      return undefined;
    });
  }

  /** Run `fn` for every id in one transaction; an unknown id rolls the whole batch back. `cols` are read first and passed in. */
  private inTransaction<T>(ids: number[], cols: string, fn: (id: number, before: Record<string, unknown>) => T): T[] {
    const read = this.db.prepare(`SELECT ${cols} FROM items WHERE id = ?`);
    this.db.exec("BEGIN");
    try {
      const out = ids.map((id) => {
        const before = read.get(id) as Record<string, unknown> | undefined;
        if (!before) throw new ItemError(`no item ${id}`);
        return fn(id, before);
      });
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * What the judge and the model choose from: every folder, described by its
   * path and the reader's note, e.g. "Games › MapleStory — MapleStory tools".
   */
  folderChoices(label: (f: Folder) => string): Record<string, string> {
    const all = this.folders();
    const byId = new Map(all.map((f) => [f.id, f]));
    const path = (f: Folder): string => (f.parent && byId.has(f.parent) ? `${path(byId.get(f.parent)!)} › ` : "") + label(f);
    return Object.fromEntries(all.map((f) => [f.id, f.description ? `${path(f)} — ${f.description}` : path(f)]));
  }

  private folderExists(id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM folders WHERE id = ?").get(id));
  }

  /** Remember that `childId` was found inside `parentId` (a repo named in a post). */
  linkFound(parentId: number, childId: number): void {
    if (parentId !== childId) this.db.prepare("INSERT OR IGNORE INTO found_in (parent_id, child_id) VALUES (?, ?)").run(parentId, childId);
  }

  /** Every parent → children pair, for building the tree. */
  foundLinks(): { parent: number; child: number }[] {
    return (this.db.prepare("SELECT parent_id AS parent, child_id AS child FROM found_in").all() as { parent: number; child: number }[])
      .map(({ parent, child }) => ({ parent, child }));
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  /** The reader's note on an item; empty text clears it. */
  setNote(id: number, note: string): boolean {
    const text = note.trim().slice(0, 5000);
    return this.db.prepare("UPDATE items SET note = ? WHERE id = ?").run(text || null, id).changes > 0;
  }

  /**
   * What people said when they shared each item (the chat message around the
   * link), newest first, without driftnet's own "Mentioned in …" bookkeeping.
   */
  chatNotes(ids: number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT item_id AS id, note FROM shares
         WHERE item_id IN (${ids.map(() => "?").join(",")}) AND note IS NOT NULL AND note <> ''
           AND note NOT LIKE 'Mentioned in %' AND note NOT LIKE 'Linked from %'
         GROUP BY item_id, note ORDER BY MAX(at) DESC`,
      )
      .all(...ids) as { id: number; note: string }[];
    for (const { id, note } of rows) out.set(id, [...(out.get(id) ?? []), note]);
    return out;
  }

  listNotes(q?: string): Note[] {
    const like = q ? `%${q}%` : null;
    return (this.db
      .prepare(`SELECT * FROM notes ${like ? "WHERE title LIKE ? OR body LIKE ?" : ""} ORDER BY updated_at DESC, id DESC`)
      .all(...(like ? [like, like] : [])) as unknown as NoteRow[]).map(toNote);
  }

  getNote(id: number): Note | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
    return row ? toNote(row) : null;
  }

  /** Every item worth keeping in an export: not trashed, not flagged for prompt injection. */
  exportable(): Item[] {
    return (this.db.prepare(`SELECT * FROM items WHERE trashed_at IS NULL AND flags NOT LIKE '%injection%' ORDER BY ${WORTH_ORDER} DESC, id`)
      .all() as unknown as ItemRow[]).map(toItem);
  }

  /** New note without an id; null when updating a note that doesn't exist. */
  saveNote(input: { id?: number; title: string; body: string }): Note | null {
    const title = input.title.trim().slice(0, 200);
    const body = input.body.slice(0, 100_000);
    const row = input.id
      ? this.db.prepare("UPDATE notes SET title = ?, body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? RETURNING *").get(title, body, input.id)
      : this.db.prepare("INSERT INTO notes (title, body) VALUES (?, ?) RETURNING *").get(title, body);
    return row ? toNote(row as unknown as NoteRow) : null;
  }

  deleteNote(id: number): boolean {
    return this.db.prepare("DELETE FROM notes WHERE id = ?").run(id).changes > 0;
  }

  /** Soft delete: hidden everywhere, restorable from the trash. Returns false if there is no such item. */
  setTrashed(id: number, trashed: boolean): boolean {
    return (
      this.db
        .prepare("UPDATE items SET trashed_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END WHERE id = ?")
        .run(trashed ? 1 : 0, id).changes > 0
    );
  }

  setFavorite(id: number, favorite: boolean): boolean {
    return this.db.prepare("UPDATE items SET favorite = ? WHERE id = ?").run(favorite ? 1 : 0, id).changes > 0;
  }

  /** Bulk {@link setTrashed}, all or nothing. Returns each item's earlier trash time for undo. */
  setTrashedMany(ids: number[], trashed: boolean): { id: number; trashed_at: string | null }[] {
    return this.inTransaction(ids, "trashed_at", (id, before) => {
      this.setTrashed(id, trashed);
      return { id, trashed_at: (before.trashed_at as string | null) ?? null };
    });
  }

  /** Bulk {@link setFavorite}, all or nothing. Returns each item's earlier star for undo. */
  setFavoriteMany(ids: number[], favorite: boolean): { id: number; favorite: number }[] {
    return this.inTransaction(ids, "favorite", (id, before) => {
      this.setFavorite(id, favorite);
      return { id, favorite: Number(before.favorite) };
    });
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
      .all(agent, `-${clampInt(leaseMinutes, 0, 1440, 30)} minutes`, clampInt(limit, 1, 20, 5)) as unknown as ItemRow[];
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
           category = CASE WHEN user_placed = 1 THEN category ELSE COALESCE(?, category) END, worth = COALESCE(?, worth),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? RETURNING *`,
      )
      .get(JSON.stringify(summary), summary.name, by, classify?.category ?? null, classify?.worth ?? null, id) as unknown as ItemRow;
    return toItem(row);
  }

  /** Net votes per item, for hiding items the community voted down. */
  private static readonly NET_VOTES = "(SELECT COALESCE(SUM(vote), 0) FROM feedback f WHERE f.item_id = items.id)";

  list(query: ListQuery = {}): Item[] {
    const where: string[] = [query.view === "trash" ? "trashed_at IS NOT NULL" : "trashed_at IS NULL"];
    const args: (string | number)[] = [];
    if (query.view === "favorites") where.push("favorite = 1");
    if (query.category) {
      // A folder shows everything below it too.
      const ids = this.descendants(query.category);
      where.push(`category IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
    }
    if (query.kind) { where.push("kind = ?"); args.push(query.kind); }
    if (query.since) { where.push("created_at >= ?"); args.push(query.since); }
    if (query.minWorth) {
      where.push(`${WORTH_ORDER} >= ${["skip", "low", "normal", "must-see"].indexOf(query.minWorth)}`);
    }
    if (query.clean !== false) {
      where.push("flags NOT LIKE '%injection%'", `${Store.NET_VOTES} > -2`);
    }
    if (query.q) {
      // The reader's note and what people said in chat are searchable too.
      where.push(`(title LIKE ? OR summary LIKE ? OR url LIKE ? OR note LIKE ?
                   OR EXISTS (SELECT 1 FROM shares s WHERE s.item_id = items.id AND s.note LIKE ?))`);
      const like = `%${query.q}%`;
      args.push(like, like, like, like, like);
    }
    // The trash lists what was removed last first; elsewhere the best comes first.
    const order = query.view === "trash" ? "trashed_at DESC"
      : query.sort === "newest" ? "created_at DESC, id DESC"
      : query.sort === "shared" ? `share_count DESC, ${WORTH_ORDER} DESC, updated_at DESC`
      : `${WORTH_ORDER} DESC, updated_at DESC`;
    const sql = `SELECT * FROM items WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`;
    args.push(clampInt(query.limit, 1, 500, 50));
    return (this.db.prepare(sql).all(...args) as unknown as ItemRow[]).map(toItem);
  }

  stats(): { items: number; shares: number; favorites: number; trash: number; byCategory: Record<string, number> } {
    const t = this.db
      .prepare(
        `SELECT COUNT(*) FILTER (WHERE trashed_at IS NULL) AS items,
                COALESCE(SUM(share_count) FILTER (WHERE trashed_at IS NULL), 0) AS shares,
                COUNT(*) FILTER (WHERE trashed_at IS NULL AND favorite = 1) AS favorites,
                COUNT(*) FILTER (WHERE trashed_at IS NOT NULL) AS trash
         FROM items`,
      )
      .get() as { items: number; shares: number; favorites: number; trash: number };
    const rows = this.db.prepare("SELECT category, COUNT(*) AS n FROM items WHERE trashed_at IS NULL GROUP BY category").all() as {
      category: string; n: number;
    }[];
    return {
      items: t.items,
      shares: t.shares,
      favorites: t.favorites,
      trash: t.trash,
      byCategory: Object.fromEntries(rows.map((r) => [r.category, r.n])),
    };
  }
}

/** SQL twin of isPending(). */
const PENDING_SQL =
  "summary IS NULL AND worth <> 'skip' AND flags NOT LIKE '%injection%' AND flags NOT LIKE '%low-reputation%' AND trashed_at IS NULL";

/** Worth reading, not blocked, and nobody has summarised it yet. */
function isPending(r: ItemRow): boolean {
  return r.summary === null && r.worth !== "skip" && !/injection|low-reputation/.test(r.flags) && r.trashed_at === null;
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
    favorite: r.favorite === 1,
    ...(r.trashed_at ? { trashedAt: r.trashed_at } : {}),
    ...(r.enriched_by ? { enrichedBy: r.enriched_by } : {}),
    ...(r.note ? { note: r.note } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface NoteRow { id: number; title: string; body: string; created_at: string; updated_at: string }

function toNote(r: NoteRow): Note {
  return { id: r.id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at };
}
