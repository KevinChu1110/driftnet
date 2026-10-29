import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizeMedia } from "./media.ts";
import type { Item, Judgement, Kind, MediaRef, ShareContext, Suggestion, Summary, Worth } from "./types.ts";
import { migrate } from "./migrations.ts";
import { ftsMatchQuery, FTS_WEIGHTS, reindexItem } from "./search-index.ts";
import { categoryLabel, LOCALES } from "./i18n.ts";

interface ItemRow {
  id: number; url: string; title: string; kind: string; category: string; worth: string;
  is_ai_tool: number; summary: string | null; judge_engine: string; enriched_by: string | null;
  trashed_at: string | null; favorite: number; note: string | null; user_placed: number; suggestions: string | null; media: string | null;
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
  /** Came with driftnet; false for folders the reader (or an accepted AI plan) made. */
  builtin: boolean;
  /** How often items were filed here by hand or by an agent (moves minus undone moves): higher = filed into more often. */
  uses: number;
}

export interface FolderRow { id: string; parent: string | null; name: string | null; description: string; position: number; builtin: number }

export class FolderError extends Error {}
/** A bulk action named an item that doesn't exist; nothing was changed. */
export class ItemError extends Error {}

/** A named key for one agent. Only its sha256 is stored; the token itself is shown once, at creation. */
export interface AgentToken {
  id: string;
  name: string;
  /** read: the reading tools and routes. write: everything the admin password may do except settings. */
  scope: "read" | "write";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A free-standing note: Markdown, may point at items as #12. */
export interface Note {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListQuery {
  /** all (default, trash excluded), favorites, trash, or inbox (not filed by hand yet, newest first). */
  view?: "all" | "favorites" | "trash" | "inbox";
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
  /** Skip this many rows (paging). */
  offset?: number;
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
    this.db.exec("PRAGMA journal_mode = WAL");
    migrate(this.db, { path });
  }

  /** Looks up by canonical URL or any URL that previously resolved to the same item. */
  findByUrl(url: string): Item | null {
    const row = (this.db.prepare("SELECT * FROM items WHERE url = ?").get(url)
      ?? this.db.prepare("SELECT i.* FROM aliases a JOIN items i ON i.id = a.item_id WHERE a.url = ?").get(url)) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  get(id: number): Item | null {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  upsert(input: {
    url: string; aliases: string[]; title: string; judgement: Judgement; summary: Summary | null;
    flags: string[]; source: string; suggestions?: Suggestion[]; media?: MediaRef[];
  }): Item {
    const { judgement: j } = input;
    const row = this.db
      .prepare(
        `INSERT INTO items (url, title, kind, category, worth, is_ai_tool, summary, judge_engine, flags, source, suggestions, media)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title, kind = excluded.kind, category = excluded.category, worth = excluded.worth,
           is_ai_tool = excluded.is_ai_tool, summary = excluded.summary, judge_engine = excluded.judge_engine,
           flags = excluded.flags, source = excluded.source, suggestions = COALESCE(excluded.suggestions, suggestions), media = COALESCE(excluded.media, media),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         RETURNING *`,
      )
      .get(
        input.url, input.title, j.kind, j.category, j.worth, j.isAiTool,
        input.summary ? JSON.stringify(input.summary) : null, j.engine, input.flags.join(","), input.source,
        input.suggestions?.length ? JSON.stringify(input.suggestions) : null,
        input.media?.length ? JSON.stringify(input.media) : null,
      ) as unknown as ItemRow;
    const alias = this.db.prepare("INSERT OR IGNORE INTO aliases (url, item_id) VALUES (?, ?)");
    for (const a of input.aliases) if (a !== input.url) alias.run(a, row.id);
    this.reindex(row.id);
    return toItem(row);
  }

  /**
   * Overwrite what a fresh fetch decides (content, summary, judgement), keep what the
   * reader owns: shares, note, favorite, trash state, and a folder they placed.
   */
  refreshItem(id: number, input: {
    title: string; judgement: Judgement; summary: Summary | null; flags: string[]; source: string; suggestions?: Suggestion[]; media?: MediaRef[];
  }): Item | null {
    const j = input.judgement;
    // No new summary (no model, it failed, source distrusted): the old summary and what came with it stay; only metadata moves.
    const keep = !input.summary && this.get(id)?.summary ? 1 : 0;
    const row = this.db
      .prepare(
        `UPDATE items SET title = CASE WHEN ? THEN title ELSE ? END, kind = ?,
           category = CASE WHEN user_placed = 1 OR ? THEN category ELSE ? END,
           worth = CASE WHEN ? THEN worth ELSE ? END, is_ai_tool = CASE WHEN ? THEN is_ai_tool ELSE ? END,
           summary = COALESCE(?, summary), judge_engine = CASE WHEN ? THEN judge_engine ELSE ? END,
           flags = ?, source = ?, suggestions = CASE WHEN ? THEN suggestions ELSE ? END, media = COALESCE(?, media),
           enriched_by = CASE WHEN ? THEN enriched_by ELSE NULL END,
           claimed_at = CASE WHEN ? THEN claimed_at ELSE NULL END, claimed_by = CASE WHEN ? THEN claimed_by ELSE NULL END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? RETURNING *`,
      )
      .get(
        keep, input.title, j.kind, keep, j.category, keep, j.worth, keep, j.isAiTool,
        input.summary ? JSON.stringify(input.summary) : null, keep, j.engine,
        input.flags.join(","), input.source, keep, input.suggestions?.length ? JSON.stringify(input.suggestions) : null,
        input.media?.length ? JSON.stringify(input.media) : null, keep, keep, keep, id,
      ) as unknown as ItemRow | undefined;
    if (row) this.reindex(row.id);
    return row ? toItem(row) : null;
  }

  /** Rebuild one item's search row; every writer of an indexed field (title, summary, note, share notes) calls this. */
  private reindex(id: number): void {
    reindexItem(this.db, id);
  }

  /** Replace an item's pictures (empty list keeps what is there: a page that is down must not wipe them). */
  setMedia(id: number, media: MediaRef[]): Item | null {
    if (!media.length) return this.get(id);
    const row = this.db.prepare("UPDATE items SET media = ? WHERE id = ? RETURNING *").get(JSON.stringify(media), id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  recordShare(itemId: number, ctx: ShareContext): void {
    this.db
      .prepare("INSERT INTO shares (item_id, platform, chat_id, user_id, note) VALUES (?, ?, ?, ?, ?)")
      .run(itemId, ctx.platform, ctx.chatId, ctx.userId ?? null, ctx.note?.slice(0, 1000) ?? null);
    // Shared again after being trashed: someone wants it, so it comes back.
    this.db.prepare("UPDATE items SET share_count = share_count + 1, trashed_at = NULL WHERE id = ?").run(itemId);
    this.reindex(itemId);
  }

  // ── Folders ──────────────────────────────────────────────────────────────

  /** First run: the built-in (or DRIFTNET_CATEGORIES) shelves become the starting tree. */
  seedFolders(seed: Record<string, string>): void {
    const has = this.db.prepare("SELECT COUNT(*) AS n FROM folders").get() as { n: number };
    if (has.n > 0) return;
    const insert = this.db.prepare("INSERT INTO folders (id, description, position, builtin) VALUES (?, ?, ?, 1)");
    Object.entries(seed).forEach(([id, description], i) => insert.run(id, description, i));
    if (!("other" in seed)) insert.run("other", "Anything that fits none of the above", Object.keys(seed).length);
  }

  /** Every item ever stored, trash included: a template may only replace the tree of an empty catalogue. */
  itemCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  }

  /**
   * Swap the whole folder tree for `seed`. Callers check it is safe (no items,
   * untouched tree); this only does it, in one transaction.
   */
  replaceFolders(seed: Record<string, string>): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM folders");
      this.seedFolders(seed);
      this.setState("folder_uses", "{}");
    });
  }

  folders(): Folder[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.parent_id AS parent, f.name, f.description, f.position, f.builtin,
                (SELECT COUNT(*) FROM items i WHERE i.category = f.id AND i.trashed_at IS NULL) AS count
         FROM folders f ORDER BY f.position, f.id`,
      )
      .all() as unknown as Folder[];
    const uses = this.folderUses();
    return rows.map((r) => ({ id: r.id, parent: r.parent ?? null, name: r.name ?? null, description: r.description, position: r.position, builtin: Number(r.builtin) === 1, count: r.count, uses: uses[r.id] ?? 0 }));
  }

  /** The move counter per folder: one JSON object in the state table. */
  private folderUses(): Record<string, number> {
    try { return JSON.parse(this.getState("folder_uses") ?? "{}") || {}; } catch { return {}; }
  }

  /** Count a move into (or, with a negative `by`, an undone move out of) a folder. Never goes below 0. */
  bumpFolderUse(folderId: string, by = 1): void {
    const uses = this.folderUses();
    const n = Math.max(0, (uses[folderId] ?? 0) + by);
    if (n > 0) uses[folderId] = n; else delete uses[folderId];
    this.setState("folder_uses", JSON.stringify(uses));
  }

  /** The folders filed into most often (at most `limit`), ties in tree order. Folders never used are left out. */
  topFolders(limit = 9): Folder[] {
    const all = this.folders();
    const order = new Map<string, number>();
    const walk = (parent: string | null) => {
      for (const f of all) if (f.parent === parent && !order.has(f.id)) { order.set(f.id, order.size); walk(f.id); }
    };
    walk(null);
    return all.filter((f) => f.uses > 0).sort((a, b) => b.uses - a.uses || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).slice(0, limit);
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
    if (!name || /^\.+$/.test(name)) throw new FolderError("a folder needs a name");
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
    if (patch.name !== undefined && (!patch.name.trim() || /^\.+$/.test(patch.name.trim()))) throw new FolderError("a folder needs a name");
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
    this.transaction(() => {
      this.db.prepare("UPDATE items SET category = ? WHERE category = ?").run(row.parent ?? "other", id);
      this.db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").run(row.parent, id);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      if (this.folderUses()[id]) this.bumpFolderUse(id, -Infinity);
    });
  }

  /** The reader put this item here; classification won't touch it again. */
  moveItem(itemId: number, folderId: string, actor?: string): boolean {
    if (!this.folderExists(folderId)) throw new FolderError(`no folder ${folderId}`);
    const moved = this.db.prepare("UPDATE items SET category = ?, user_placed = 1, moved_by = ? WHERE id = ?").run(folderId, actor ?? null, itemId).changes > 0;
    if (moved) this.bumpFolderUse(folderId);
    return moved;
  }

  /** Move many items at once, all or nothing. Returns each item's earlier folder so the whole batch can be undone. */
  moveItems(ids: number[], folderId: string, actor?: string): { id: number; category: string; user_placed: number }[] {
    if (!this.folderExists(folderId)) throw new FolderError(`no folder ${folderId}`);
    const before = this.inTransaction(ids, "category, user_placed", (id, before) => {
      this.db.prepare("UPDATE items SET category = ?, user_placed = 1, moved_by = ? WHERE id = ?").run(folderId, actor ?? null, id);
      return { id, category: String(before.category), user_placed: Number(before.user_placed) };
    });
    this.bumpFolderUse(folderId, ids.length);
    return before;
  }

  /** Put items back exactly as an earlier bulk action found them (folder and placement, trash, star). */
  restoreItems(rows: { id: number; category?: string; user_placed?: number; trashed_at?: string | null; favorite?: number }[]): void {
    const ids = rows.map((r) => r.id);
    for (const r of rows) if (r.category !== undefined && !this.folderExists(r.category)) throw new FolderError(`no folder ${r.category}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const undone = new Map<string, number>();
    this.inTransaction(ids, "category", (id, before) => {
      const r = byId.get(id)!;
      if (r.category !== undefined) undone.set(String(before.category), (undone.get(String(before.category)) ?? 0) + 1);
      if (r.category !== undefined) this.db.prepare("UPDATE items SET category = ?, user_placed = ? WHERE id = ?").run(r.category, r.user_placed ?? 0, id);
      if (r.trashed_at !== undefined) this.db.prepare("UPDATE items SET trashed_at = ? WHERE id = ?").run(r.trashed_at, id);
      if (r.favorite !== undefined) this.db.prepare("UPDATE items SET favorite = ? WHERE id = ?").run(r.favorite ? 1 : 0, id);
      return undefined;
    });
    // Undoing a move takes back the count it added to the folder the items were sitting in.
    for (const [folder, n] of undone) this.bumpFolderUse(folder, -n);
  }

  private txDepth = 0;

  /** Run `fn` all or nothing; calls inside it (moveItems, …) join the same transaction through savepoints. */
  transaction<T>(fn: () => T): T {
    const name = `sp${this.txDepth}`;
    this.db.exec(this.txDepth === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? "COMMIT" : `RELEASE ${name}`);
      return out;
    } catch (err) {
      this.txDepth--;
      this.db.exec(this.txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  /** Run `fn` for every id in one transaction; an unknown id rolls the whole batch back. `cols` are read first and passed in. */
  private inTransaction<T>(ids: number[], cols: string, fn: (id: number, before: Record<string, unknown>) => T): T[] {
    const read = this.db.prepare(`SELECT ${cols} FROM items WHERE id = ?`);
    return this.transaction(() => ids.map((id) => {
      const before = read.get(id) as Record<string, unknown> | undefined;
      if (!before) throw new ItemError(`no item ${id}`);
      return fn(id, before);
    }));
  }

  /** The whole folder table as stored, for an undo snapshot. */
  snapshotFolders(): FolderRow[] {
    return this.db.prepare("SELECT id, parent_id AS parent, name, description, position, builtin FROM folders ORDER BY position, id").all() as unknown as FolderRow[];
  }

  /** Put the folder table back exactly as a snapshot found it. Cards left in a folder that no longer exists go to "other". */
  restoreFolders(rows: FolderRow[]): void {
    this.transaction(() => {
      this.db.exec("PRAGMA defer_foreign_keys = ON");
      this.db.exec("DELETE FROM folders");
      const ins = this.db.prepare("INSERT INTO folders (id, parent_id, name, description, position, builtin) VALUES (?, ?, ?, ?, ?, ?)");
      // Parents first, so a foreign key never points at a row that isn't there yet.
      const done = new Set<string>();
      const pending = [...rows];
      while (pending.length) {
        const before = pending.length;
        for (let i = pending.length - 1; i >= 0; i--) {
          const r = pending[i]!;
          if (r.parent && !done.has(r.parent)) continue;
          ins.run(r.id, r.parent, r.name, r.description, r.position, r.builtin);
          done.add(r.id);
          pending.splice(i, 1);
        }
        if (pending.length === before) throw new FolderError("folder snapshot has a loop");
      }
      if (!done.has("other")) this.db.prepare("INSERT INTO folders (id, description, position, builtin) VALUES ('other', 'Anything that fits none of the above', 9999, 1)").run();
      this.db.prepare("UPDATE items SET category = 'other' WHERE category NOT IN (SELECT id FROM folders)").run();
    });
  }

  /** Cards of `ids` that are still waiting for the reader: not filed by hand, not trashed. */
  movableCards(ids: number[]): { id: number; folder: string }[] {
    const read = this.db.prepare("SELECT id, category FROM items WHERE id = ? AND user_placed = 0 AND trashed_at IS NULL");
    return ids.flatMap((id) => {
      const r = read.get(id) as { id: number; category: string } | undefined;
      return r ? [{ id: r.id, folder: r.category }] : [];
    });
  }

  /** Folder and placement of each existing item, for an undo snapshot. */
  itemPlacement(ids: number[]): { id: number; folder: string; user_placed: number }[] {
    const read = this.db.prepare("SELECT id, category, user_placed FROM items WHERE id = ?");
    return ids.flatMap((id) => {
      const r = read.get(id) as { id: number; category: string; user_placed: number } | undefined;
      return r ? [{ id: r.id, folder: r.category, user_placed: r.user_placed }] : [];
    });
  }

  /** Every item (trash included) sitting directly in a folder. */
  categoryItemIds(folder: string): number[] {
    return (this.db.prepare("SELECT id FROM items WHERE category = ?").all(folder) as { id: number }[]).map((r) => r.id);
  }

  /** Folders that hold at least one card the reader filed by hand. */
  placedFolders(): Set<string> {
    return new Set((this.db.prepare("SELECT DISTINCT category FROM items WHERE user_placed = 1").all() as { category: string }[]).map((r) => r.category));
  }

  /** Fold `from` into `into`: its cards and sub-folders go there, the folder goes away, its move count carries over. */
  mergeFolders(from: string, into: string): void {
    if (from === "other") throw new FolderError("“other” can't be merged away");
    if (!this.folderExists(from) || !this.folderExists(into)) throw new FolderError(`no folder ${from} / ${into}`);
    if (from === into || this.descendants(from).includes(into)) throw new FolderError("a folder can't be merged into itself");
    this.transaction(() => {
      this.db.prepare("UPDATE items SET category = ? WHERE category = ?").run(into, from);
      this.db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").run(into, from);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(from);
    });
    const n = this.folderUses()[from] ?? 0;
    if (n) { this.bumpFolderUse(from, -Infinity); this.bumpFolderUse(into, n); }
  }

  /** Is this a shelf that came with driftnet (not one the reader or an AI plan made)? */
  isBuiltinFolder(id: string): boolean {
    return (this.db.prepare("SELECT builtin FROM folders WHERE id = ?").get(id) as { builtin: number } | undefined)?.builtin === 1;
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
    const changed = this.db.prepare("UPDATE items SET note = ? WHERE id = ?").run(text || null, id).changes > 0;
    if (changed) this.reindex(id);
    return changed;
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
    const changed = this.db
      .prepare("UPDATE items SET trashed_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END WHERE id = ? AND (trashed_at IS NOT NULL) <> ?")
      .run(trashed ? 1 : 0, id, trashed ? 1 : 0).changes > 0;
    if (changed) {
      // Announced after the (possibly enclosing) transaction has settled; a rolled-back change is not announced.
      setImmediate(() => {
        try { if (!!this.get(id)?.trashedAt === trashed) this.onTrash?.(id, trashed); } catch { /* a hook must not break the store */ }
      });
    }
    return changed || this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(id) !== undefined;
  }

  /** Called (never awaited) after an item went to the trash or came back. */
  onTrash?: (id: number, trashed: boolean) => void;

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

  /** Mint a token. The only time the plain value exists: keep it out of logs. */
  createAgentToken(input: { name: string; scope: "read" | "write" }): { id: string; name: string; scope: "read" | "write"; token: string } {
    const name = input.name.trim().slice(0, 60);
    if (!name) throw new Error("name is required");
    if (input.scope !== "read" && input.scope !== "write") throw new Error("scope must be read or write");
    const id = randomUUID().slice(0, 8);
    const token = `dn_${randomBytes(24).toString("base64url")}`;
    this.db.prepare("INSERT INTO agent_tokens (id, name, scope, hash) VALUES (?, ?, ?, ?)").run(id, name, input.scope, hashToken(token));
    return { id, name, scope: input.scope, token };
  }

  /** Active tokens, and ones revoked in the last 30 days (they show greyed out); never the hash. */
  listAgentTokens(): AgentToken[] {
    const rows = this.db.prepare("SELECT id, name, scope, created_at, last_used_at, revoked_at FROM agent_tokens WHERE revoked_at IS NULL OR revoked_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days') ORDER BY created_at DESC, rowid DESC").all() as {
      id: string; name: string; scope: "read" | "write"; created_at: string; last_used_at: string | null; revoked_at: string | null;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at }));
  }

  revokeAgentToken(id: string): boolean {
    return this.db.prepare("UPDATE agent_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND revoked_at IS NULL").run(id).changes > 0;
  }

  /** Forget a revoked token. An active one must be revoked first: false then, and for an unknown id. */
  deleteAgentToken(id: string): boolean {
    return this.db.prepare("DELETE FROM agent_tokens WHERE id = ? AND revoked_at IS NOT NULL").run(id).changes > 0;
  }

  /** The active token with this sha256, if any. */
  findAgentToken(hash: string): { id: string; name: string; scope: "read" | "write" } | null {
    const r = this.db.prepare("SELECT id, name, scope FROM agent_tokens WHERE hash = ? AND revoked_at IS NULL").get(hash) as { id: string; name: string; scope: "read" | "write" } | undefined;
    return r ? { id: r.id, name: r.name, scope: r.scope } : null;
  }

  /** Remember when a token was last used, at most once a minute: a write per request would be wasteful. */
  touchAgentToken(id: string): void {
    this.db
      .prepare("UPDATE agent_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 minute'))")
      .run(id);
  }

  /** A one-time code (192 bits, 5 minutes) to pair a device. The plain value exists only in this return. */
  createPairCode(input: { name: string; scope: "read" | "write" }, now = Date.now()): { code: string; expiresAt: string } {
    const name = input.name.trim().slice(0, 56);
    if (!name) throw new Error("name is required");
    if (input.scope !== "read" && input.scope !== "write") throw new Error("scope must be read or write");
    const iso = new Date(now).toISOString();
    this.db.prepare("DELETE FROM pair_codes WHERE expires_at < ? OR used_at IS NOT NULL").run(iso);
    const code = randomBytes(24).toString("base64url");
    const expiresAt = new Date(now + 5 * 60_000).toISOString();
    this.db.prepare("INSERT INTO pair_codes (hash, name, scope, expires_at) VALUES (?, ?, ?, ?)").run(hashToken(code), name, input.scope, expiresAt);
    return { code, expiresAt };
  }

  /** Swap a live code for a device token, once. Null for unknown, used and expired alike. */
  claimPairCode(code: string, now = Date.now()): { id: string; name: string; scope: "read" | "write"; token: string } | null {
    const hash = hashToken(code);
    const iso = new Date(now).toISOString();
    const row = this.db.prepare("SELECT name, scope FROM pair_codes WHERE hash = ? AND used_at IS NULL AND expires_at >= ?").get(hash, iso) as { name: string; scope: "read" | "write" } | undefined;
    if (!row) return null;
    // The conditional update is the lock: of two racing claims only one changes a row.
    if (this.db.prepare("UPDATE pair_codes SET used_at = ? WHERE hash = ? AND used_at IS NULL").run(iso, hash).changes !== 1) return null;
    return this.createAgentToken({ name: `📱 ${row.name}`, scope: row.scope });
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

  deleteState(key: string): void {
    this.db.prepare("DELETE FROM state WHERE key = ?").run(key);
  }

  /**
   * Hand out up to `limit` pending items to an agent and lease them for
   * `leaseMinutes`, so two agents working the queue don't do the same item.
   * Most-shared first, then oldest.
   */
  claimPending(agent: string, limit: number, leaseMinutes = 30, actor?: string): Item[] {
    const rows = this.db
      .prepare(
        `UPDATE items SET claimed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), claimed_by = ?, claimed_actor = ?
         WHERE id IN (
           SELECT id FROM items
           WHERE ${PENDING_SQL}
             AND (claimed_at IS NULL OR claimed_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now', ?))
           ORDER BY share_count DESC, created_at ASC LIMIT ?)
         RETURNING *`,
      )
      .all(agent, actor ?? null, `-${clampInt(leaseMinutes, 0, 1440, 30)} minutes`, clampInt(limit, 1, 20, 5)) as unknown as ItemRow[];
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
    this.reindex(id);
    return toItem(row);
  }

  /** Net votes per item, for hiding items the community voted down. */
  private static readonly NET_VOTES = "(SELECT COALESCE(SUM(vote), 0) FROM feedback f WHERE f.item_id = items.id)";

  /** `out.total` receives how many rows match, ignoring limit/offset (for paging). */
  list(query: ListQuery = {}, out?: { total?: number }): Item[] {
    const where: string[] = [query.view === "trash" ? "trashed_at IS NOT NULL" : "trashed_at IS NULL"];
    const args: (string | number)[] = [];
    if (query.view === "favorites") where.push("favorite = 1");
    if (query.view === "inbox") where.push("user_placed = 0");
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
    const terms = (query.q ?? "").slice(0, 200).split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean).slice(0, 8);
    // Terms of 3+ characters go to the trigram index (substring match, CJK included); shorter ones
    // cannot be looked up there and keep the LIKE scan.
    const ftsTerms = terms.filter((t) => [...t].length >= 3);
    const likeTerms = terms.filter((t) => [...t].length < 3);
    const joinArgs: string[] = [];
    let join = "";
    if (ftsTerms.length) {
      join = "JOIN (SELECT rowid, bm25(item_fts, " + FTS_WEIGHTS.join(", ") + ") AS rank FROM item_fts WHERE item_fts MATCH ?) f ON f.rowid = items.id";
      joinArgs.push(ftsMatchQuery(ftsTerms));
    }
    for (const term of likeTerms) {
      // The reader's note and what people said in chat are searchable too. Summary fields are read
      // one by one: matching the raw JSON would make "tags" or "name" hit every item.
      const f = (path: string) => `json_extract(summary, '$.${path}')`;
      const like = (col: string) => `${col} LIKE ? ESCAPE '\\'`;
      where.push(`(${[
        like("title"), like("url"), like("note"),
        `EXISTS (SELECT 1 FROM shares s WHERE s.item_id = items.id AND ${like("s.note")})`,
        ...["name", "oneLiner", "demo", "why"].map((k) => like(f(k))),
        ...["highlights", "tags", "useCases"].map((k) => `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(summary) THEN summary ELSE '{}' END, '$.${k}') e WHERE ${like("e.value")})`),
      ].join(" OR ")})`);
      const pat = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(...Array<string>(11).fill(pat));
    }
    // The trash lists what was removed last first; elsewhere the best comes first.
    const order = query.view === "trash" ? "trashed_at DESC"
      : query.view === "inbox" ? "created_at DESC, id DESC"
      : query.sort === "newest" ? "created_at DESC, id DESC"
      : query.sort === "shared" ? `share_count DESC, ${WORTH_ORDER} DESC, updated_at DESC`
      : join ? `f.rank, ${WORTH_ORDER} DESC, updated_at DESC`
      : `${WORTH_ORDER} DESC, updated_at DESC`;
    if (out) out.total = (this.db.prepare(`SELECT COUNT(*) AS n FROM items ${join} WHERE ${where.join(" AND ")}`).get(...joinArgs, ...args) as { n: number }).n;
    const sql = `SELECT items.* FROM items ${join} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`;
    args.push(clampInt(query.limit, 1, 500, 50), clampInt(query.offset, 0, 1_000_000, 0));
    return (this.db.prepare(sql).all(...joinArgs, ...args) as unknown as ItemRow[]).map(toItem);
  }

  /** Items shared at least `min` times since `since` (counting share events, not the lifetime total), most first. */
  sharedSince(since: string, min = 2, limit = 10): { id: number; shares: number }[] {
    return this.db
      .prepare("SELECT item_id AS id, COUNT(*) AS shares FROM shares WHERE at >= ? GROUP BY item_id HAVING COUNT(*) >= ? ORDER BY shares DESC, item_id LIMIT ?")
      .all(since, min, limit) as { id: number; shares: number }[];
  }

  /** Cards waiting in the Inbox: not filed by hand, not trashed. */
  inboxCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE user_placed = 0 AND trashed_at IS NULL AND flags NOT LIKE '%injection%' AND ${Store.NET_VOTES} > -2`).get() as { n: number }).n;
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
    suggestions: parseSuggestions(r.suggestions),
    media: parseMedia(r.media),
    placed: r.user_placed === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseMedia(raw: string | null): MediaRef[] {
  if (!raw) return [];
  try { return normalizeMedia(JSON.parse(raw)); } catch { return []; }
}

function parseSuggestions(raw: string | null): Suggestion[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as Suggestion[];
    return Array.isArray(v) ? v.filter((s) => s && typeof s.folder === "string").slice(0, 3) : [];
  } catch { return []; }
}

interface NoteRow { id: number; title: string; body: string; created_at: string; updated_at: string }

function toNote(r: NoteRow): Note {
  return { id: r.id, title: r.title, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at };
}
