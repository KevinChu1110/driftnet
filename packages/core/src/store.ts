import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { normalizeMedia } from "./media.ts";
import type { Health, Item, Judgement, Kind, MediaRef, ShareContext, Suggestion, Summary, Worth } from "./types.ts";
import { migrate } from "./migrations.ts";
import { correctTerm, folderNames, ftsMatchQuery, FTS_WEIGHTS, refreshFolderText, refreshItemFolders, reindexItem, unindexItem } from "./search-index.ts";
import { VectorIndex, type Hit } from "./vectors.ts";
import { categoryLabel, LOCALES } from "./i18n.ts";
import { guard } from "./guard.ts";

interface ItemRow {
  id: number; url: string; title: string; kind: string; category: string; worth: string;
  is_ai_tool: number; summary: string | null; judge_engine: string; enriched_by: string | null;
  trashed_at: string | null; favorite: number; note: string | null; user_placed: number; suggestions: string | null; media: string | null;
  flags: string; source: string; share_count: number; created_at: string; updated_at: string;
  health: string | null; health_checked_at: string | null; stars: number | null; pushed_at: string | null;
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
/** A history version that cannot be shown or applied; `status` is the HTTP code the route answers with. */
export class HistoryError extends ItemError {
  constructor(message: string, readonly status: 404 | 409 | 422) { super(message); }
}

/** The card fields a change can touch, grouped the way the reader thinks of them. */
const HISTORY_GROUPS = {
  note: ["note"], summary: ["summary"], title: ["title"], folder: ["category", "user_placed"],
  favorite: ["favorite"], trashed: ["trashed_at"],
} as const;
type HistoryField = keyof typeof HISTORY_GROUPS;
export const HISTORY_KEEP = 20;
export const HISTORY_DAYS = 180;
export interface HistoryEntry { v: number; at: string; actor: string; fields: HistoryField[]; before: Record<string, unknown> }

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
  /** Only items whose last link check found one of these. */
  health?: Health[];
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
  /**
   * The query's embedding, computed beforehand (it is async; list is not). With it, a text search fuses
   * the keyword rank and the vector rank (reciprocal-rank fusion) instead of keywords alone. Ignored for
   * the trash, the inbox and explicit sorts, and when no vectors are stored.
   */
  semantic?: { vec: Float32Array; floor?: number };
  /**
   * When a text search matches nothing, retry once with each misspelt word (4+ Latin letters, matching
   * nothing on its own) replaced by the closest word in the catalogue; `out.corrected` then says what was
   * searched instead. Default true. CJK terms are never changed.
   */
  fuzzy?: boolean;
}

/** RRF constant (Cormack et al.): flattens the head of each ranking so neither one dominates. */
const RRF_K = 60;
/** At most this many vector-only candidates join a text search: it bounds the result set however low the floor is. */
const SEMANTIC_MAX = 50;
export const DEFAULT_FLOOR = 0.35;

/** Untrusted numbers (query strings, JSON bodies) → an integer in range, never NaN. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

const WORTH_ORDER = "CASE worth WHEN 'skip' THEN 0 WHEN 'low' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";

export class Store {
  private readonly db: DatabaseSync;
  /** Item embeddings for semantic search (empty and unused unless an embedder is configured). */
  readonly vectors: VectorIndex;
  /** Called after an item's searchable text changed; semantic search queues the item for embedding. */
  onIndexed?: (id: number) => void;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA trusted_schema = OFF"); // a trigger or view in a foreign file may not call risky functions
    migrate(this.db, { path });
    // Once per start: forget what is older than the retention (per-card pruning keeps the rest short).
    this.db.prepare("DELETE FROM item_history WHERE at < ?").run(new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString());
    this.vectors = new VectorIndex(this.db);
  }

  // ── History ──────────────────────────────────────────────────────────────

  /**
   * Remember what a change replaced: one INSERT of only the changed groups' old values, then trim this
   * card to its newest 20 versions and the last 180 days (index-only, same transaction as the change).
   * Nothing is written when nothing differs.
   */
  private log(id: number, actor: string | undefined, before: Record<string, unknown>, after: Record<string, unknown>): void {
    const fields: HistoryField[] = [];
    const old: Record<string, unknown> = {};
    for (const [group, cols] of Object.entries(HISTORY_GROUPS) as [HistoryField, readonly string[]][]) {
      if (!cols.every((c) => c in before && c in after)) continue;
      if (cols.every((c) => (before[c] ?? null) === (after[c] ?? null))) continue;
      fields.push(group);
      for (const c of cols) old[c] = before[c] ?? null;
    }
    if (!fields.length) return;
    const now = new Date();
    this.db.prepare("INSERT INTO item_history (item_id, at, actor, field_set, before) VALUES (?, ?, ?, ?, ?)")
      .run(id, now.toISOString(), actor || "system", fields.join(","), JSON.stringify(old));
    this.db.prepare(
      `DELETE FROM item_history WHERE item_id = ? AND (at < ? OR id NOT IN (SELECT id FROM item_history WHERE item_id = ? ORDER BY id DESC LIMIT ${HISTORY_KEEP}))`,
    ).run(id, new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString(), id);
  }

  /** A card's saved versions, newest first (at most 20). `v` is what {@link restoreVersion} takes. */
  history(id: number): HistoryEntry[] {
    return (this.db.prepare("SELECT id, at, actor, field_set, before FROM item_history WHERE item_id = ? ORDER BY id DESC LIMIT ?")
      .all(id, HISTORY_KEEP) as { id: number; at: string; actor: string; field_set: string; before: string }[])
      .map((r) => ({ v: r.id, at: r.at, actor: r.actor, fields: r.field_set.split(",") as HistoryField[], before: JSON.parse(r.before) as Record<string, unknown> }));
  }

  /** Forget every saved version of one card (the card itself is untouched). Returns how many were removed. */
  forgetHistory(id: number): number {
    return Number(this.db.prepare("DELETE FROM item_history WHERE item_id = ?").run(id).changes);
  }

  /**
   * Put a card's earlier values back as one new change (itself recorded, so it can be undone).
   * Goes through the same limits as a normal write: note length, the injection guard on summary text,
   * folders that still exist. A trashed card only takes a version that brings it back.
   */
  restoreVersion(id: number, v: number, actor?: string): Item {
    const ver = this.db.prepare("SELECT before FROM item_history WHERE id = ? AND item_id = ?").get(v, id) as { before: string } | undefined;
    if (!ver) throw new HistoryError(`no version ${v} for item ${id}`, 404);
    const b = JSON.parse(ver.before) as Record<string, unknown>;
    const cur = this.db.prepare("SELECT title, summary, category, user_placed, note, favorite, trashed_at FROM items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!cur) throw new HistoryError(`no item ${id}`, 404);
    if (cur.trashed_at && !("trashed_at" in b && b.trashed_at === null)) throw new HistoryError("this card is in the trash; restore it from the trash first", 409);

    const patch: Record<string, unknown> = {};
    if ("note" in b) patch.note = typeof b.note === "string" ? b.note.trim().slice(0, 5000) || null : null;
    if ("title" in b) patch.title = String(b.title ?? "").slice(0, 300);
    if ("summary" in b) {
      if (b.summary !== null) {
        let ok = false;
        try { const o = JSON.parse(String(b.summary)); ok = !!o && typeof o === "object" && !Array.isArray(o) && typeof o.name === "string"; } catch { /* not JSON */ }
        if (!ok) throw new HistoryError("that version's summary is not valid", 422);
        const g = guard(String(b.summary));
        if (g.flags.length) throw new HistoryError(`Rejected: ${g.flags.join(", ")} in the summary.`, 422);
      }
      patch.summary = b.summary ?? null;
    }
    if ("category" in b) {
      if (!this.folderExists(String(b.category))) throw new HistoryError(`the folder ${String(b.category)} no longer exists`, 409);
      patch.category = String(b.category);
      patch.user_placed = Number(b.user_placed ?? 0) ? 1 : 0;
    }
    if ("favorite" in b) patch.favorite = Number(b.favorite) ? 1 : 0;
    if ("trashed_at" in b) patch.trashed_at = b.trashed_at === null ? null : String(b.trashed_at);

    this.transaction(() => {
      const cols = Object.keys(patch);
      const row = this.db.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? RETURNING title, summary, category, user_placed, note, favorite, trashed_at`)
        .get(...(cols.map((c) => patch[c]) as (string | number | null)[]), id) as Record<string, unknown>;
      this.log(id, actor, cur, row);
      if (patch.note !== undefined || patch.summary !== undefined || patch.title !== undefined) this.reindex(id);
      else if (patch.category !== undefined) refreshItemFolders(this.db, [id]);
    });
    if ("trashed_at" in patch && (patch.trashed_at === null) !== (cur.trashed_at === null)) {
      const trashed = patch.trashed_at !== null;
      setImmediate(() => { try { if (!!this.get(id)?.trashedAt === trashed) this.onTrash?.(id, trashed); } catch { /* a hook must not break the store */ } });
    }
    return this.get(id)!;
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
    /** Repo facts the extractor already fetched: stars, last push, archived (stored as health 'archived'). */
    repo?: RepoFacts;
  }, actor = "system"): Item {
    return this.transaction(() => this.upsertRow(input, actor));
  }

  private upsertRow(input: Parameters<Store["upsert"]>[0], actor: string): Item {
    const { judgement: j } = input;
    // An existing card is overwritten by the ON CONFLICT branch: remember what it replaces.
    const old = this.db.prepare("SELECT id, title, summary, category, user_placed FROM items WHERE url = ?").get(input.url) as Record<string, unknown> | undefined;
    const row = this.db
      .prepare(
        `INSERT INTO items (url, title, kind, category, worth, is_ai_tool, summary, judge_engine, flags, source, suggestions, media, stars, pushed_at, health, health_checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           title = excluded.title, kind = excluded.kind, category = excluded.category, worth = excluded.worth,
           is_ai_tool = excluded.is_ai_tool, summary = excluded.summary, judge_engine = excluded.judge_engine,
           flags = excluded.flags, source = excluded.source, suggestions = COALESCE(excluded.suggestions, suggestions), media = COALESCE(excluded.media, media),
           stars = COALESCE(excluded.stars, stars), pushed_at = COALESCE(excluded.pushed_at, pushed_at),
           health = COALESCE(excluded.health, health), health_checked_at = COALESCE(excluded.health_checked_at, health_checked_at),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         RETURNING *`,
      )
      .get(
        input.url, input.title, j.kind, j.category, j.worth, j.isAiTool,
        input.summary ? JSON.stringify(input.summary) : null, j.engine, input.flags.join(","), input.source,
        input.suggestions?.length ? JSON.stringify(input.suggestions) : null,
        input.media?.length ? JSON.stringify(input.media) : null,
        ...repoArgs(input.repo),
      ) as unknown as ItemRow;
    const alias = this.db.prepare("INSERT OR IGNORE INTO aliases (url, item_id) VALUES (?, ?)");
    for (const a of input.aliases) if (a !== input.url) alias.run(a, row.id);
    if (old) this.log(row.id, actor, old, row as unknown as Record<string, unknown>);
    this.reindex(row.id);
    return toItem(row);
  }

  /**
   * Overwrite what a fresh fetch decides (content, summary, judgement), keep what the
   * reader owns: shares, note, favorite, trash state, and a folder they placed.
   */
  refreshItem(id: number, input: {
    title: string; judgement: Judgement; summary: Summary | null; flags: string[]; source: string; suggestions?: Suggestion[]; media?: MediaRef[]; repo?: RepoFacts;
  }): Item | null {
    return this.transaction(() => this.refreshRow(id, input));
  }

  private refreshRow(id: number, input: Parameters<Store["refreshItem"]>[1]): Item | null {
    const j = input.judgement;
    // No new summary (no model, it failed, source distrusted): the old summary and what came with it stay; only metadata moves.
    const old = this.db.prepare("SELECT id, title, summary, category, user_placed FROM items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    const keep = !input.summary && old?.summary ? 1 : 0;
    const row = this.db
      .prepare(
        `UPDATE items SET title = CASE WHEN ? THEN title ELSE ? END, kind = ?,
           category = CASE WHEN user_placed = 1 OR ? THEN category ELSE ? END,
           worth = CASE WHEN ? THEN worth ELSE ? END, is_ai_tool = CASE WHEN ? THEN is_ai_tool ELSE ? END,
           summary = COALESCE(?, summary), judge_engine = CASE WHEN ? THEN judge_engine ELSE ? END,
           flags = ?, source = ?, suggestions = CASE WHEN ? THEN suggestions ELSE ? END, media = COALESCE(?, media),
           stars = COALESCE(?, stars), pushed_at = COALESCE(?, pushed_at),
           health = COALESCE(?, health), health_checked_at = COALESCE(?, health_checked_at),
           enriched_by = CASE WHEN ? THEN enriched_by ELSE NULL END,
           claimed_at = CASE WHEN ? THEN claimed_at ELSE NULL END, claimed_by = CASE WHEN ? THEN claimed_by ELSE NULL END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? RETURNING *`,
      )
      .get(
        keep, input.title, j.kind, keep, j.category, keep, j.worth, keep, j.isAiTool,
        input.summary ? JSON.stringify(input.summary) : null, keep, j.engine,
        input.flags.join(","), input.source, keep, input.suggestions?.length ? JSON.stringify(input.suggestions) : null,
        input.media?.length ? JSON.stringify(input.media) : null,
        ...repoArgs(input.repo), keep, keep, keep, id,
      ) as unknown as ItemRow | undefined;
    if (row && old) this.log(id, "system:refresh", old, row as unknown as Record<string, unknown>);
    if (row) this.reindex(row.id);
    return row ? toItem(row) : null;
  }

  /** Rebuild one item's search row; every writer of an indexed field (title, summary, note, share notes) calls this. */
  private reindex(id: number): void {
    reindexItem(this.db, id);
    try { this.onIndexed?.(id); } catch { /* a hook must not break the store */ }
  }

  /** Replace an item's pictures (empty list keeps what is there: a page that is down must not wipe them). */
  setMedia(id: number, media: MediaRef[]): Item | null {
    if (!media.length) return this.get(id);
    const row = this.db.prepare("UPDATE items SET media = ? WHERE id = ? RETURNING *").get(JSON.stringify(media), id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Record a link check. `health` null leaves the state as it was (inconclusive); stars/pushedAt only overwrite when given. */
  setHealth(id: number, r: { health?: Health | null; stars?: number | null; pushedAt?: string | null; checkedAt?: string }): Item | null {
    const row = this.db.prepare(
      `UPDATE items SET health = COALESCE(?, health), health_checked_at = ?, stars = COALESCE(?, stars), pushed_at = COALESCE(?, pushed_at)
       WHERE id = ? RETURNING *`,
    ).get(r.health ?? null, r.checkedAt ?? new Date().toISOString(), r.stars ?? null, r.pushedAt ?? null, id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Items whose link was never checked or last checked before `olderThan` (ISO), never-checked and oldest first. Trash is skipped. */
  healthDue(limit: number, olderThan: string): Item[] {
    return (this.db.prepare(
      `SELECT * FROM items WHERE trashed_at IS NULL AND (health_checked_at IS NULL OR health_checked_at < ?)
       ORDER BY health_checked_at IS NOT NULL, health_checked_at, id LIMIT ?`,
    ).all(olderThan, clampInt(limit, 1, 500, 20)) as unknown as ItemRow[]).map(toItem);
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
    this.transaction(() => {
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
      // A new name or place changes the folder path of every card below it, which search matches.
      if (patch.name !== undefined || patch.parent !== undefined) refreshFolderText(this.db, this.descendants(id));
    });
    return this.folders().find((f) => f.id === id)!;
  }

  /** Items and sub-folders move up one level ("other" if there is no parent). "other" itself stays. */
  deleteFolder(id: string): void {
    if (id === "other") throw new FolderError("“other” catches everything unsorted and can't be deleted");
    const row = this.db.prepare("SELECT parent_id AS parent FROM folders WHERE id = ?").get(id) as { parent: string | null } | undefined;
    if (!row) throw new FolderError(`no folder ${id}`);
    this.transaction(() => {
      const below = this.descendants(id).slice(1);
      this.db.prepare("UPDATE items SET category = ? WHERE category = ?").run(row.parent ?? "other", id);
      this.db.prepare("UPDATE folders SET parent_id = ? WHERE parent_id = ?").run(row.parent, id);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
      refreshFolderText(this.db, [...below, row.parent ?? "other"]);
      if (this.folderUses()[id]) this.bumpFolderUse(id, -Infinity);
    });
  }

  /** The reader put this item here; classification won't touch it again. */
  moveItem(itemId: number, folderId: string, actor?: string): boolean {
    if (!this.folderExists(folderId)) throw new FolderError(`no folder ${folderId}`);
    const moved = this.transaction(() => {
      const old = this.db.prepare("SELECT category, user_placed FROM items WHERE id = ?").get(itemId) as Record<string, unknown> | undefined;
      const did = this.db.prepare("UPDATE items SET category = ?, user_placed = 1, moved_by = ? WHERE id = ?").run(folderId, actor ?? null, itemId).changes > 0;
      if (did) { this.log(itemId, actor, old!, { category: folderId, user_placed: 1 }); refreshItemFolders(this.db, [itemId]); }
      return did;
    });
    if (moved) this.bumpFolderUse(folderId);
    return moved;
  }

  /** Move many items at once, all or nothing. Returns each item's earlier folder so the whole batch can be undone. */
  moveItems(ids: number[], folderId: string, actor?: string): { id: number; category: string; user_placed: number }[] {
    if (!this.folderExists(folderId)) throw new FolderError(`no folder ${folderId}`);
    const before = this.inTransaction(ids, "category, user_placed", (id, before) => {
      this.db.prepare("UPDATE items SET category = ?, user_placed = 1, moved_by = ? WHERE id = ?").run(folderId, actor ?? null, id);
      this.log(id, actor, before, { category: folderId, user_placed: 1 });
      refreshItemFolders(this.db, [id]);
      return { id, category: String(before.category), user_placed: Number(before.user_placed) };
    });
    this.bumpFolderUse(folderId, ids.length);
    return before;
  }

  /** Put items back exactly as an earlier bulk action found them (folder and placement, trash, star). */
  restoreItems(rows: { id: number; category?: string; user_placed?: number; trashed_at?: string | null; favorite?: number }[], actor = "system"): void {
    const ids = rows.map((r) => r.id);
    for (const r of rows) if (r.category !== undefined && !this.folderExists(r.category)) throw new FolderError(`no folder ${r.category}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const undone = new Map<string, number>();
    this.inTransaction(ids, "category, user_placed, trashed_at, favorite", (id, before) => {
      const r = byId.get(id)!;
      const after = { category: r.category ?? before.category, user_placed: r.category !== undefined ? (r.user_placed ?? 0) : before.user_placed,
        trashed_at: r.trashed_at !== undefined ? r.trashed_at : before.trashed_at, favorite: r.favorite !== undefined ? (r.favorite ? 1 : 0) : before.favorite };
      this.log(id, actor, before, after);
      if (r.category !== undefined) undone.set(String(before.category), (undone.get(String(before.category)) ?? 0) + 1);
      if (r.category !== undefined) {
        this.db.prepare("UPDATE items SET category = ?, user_placed = ? WHERE id = ?").run(r.category, r.user_placed ?? 0, id);
        refreshItemFolders(this.db, [id]);
      }
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
      refreshFolderText(this.db, (this.db.prepare("SELECT id FROM folders").all() as { id: string }[]).map((f) => f.id));
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
      refreshFolderText(this.db, this.descendants(into));
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
  setNote(id: number, note: string, actor?: string): boolean {
    const text = note.trim().slice(0, 5000);
    return this.transaction(() => {
      const old = this.db.prepare("SELECT note FROM items WHERE id = ?").get(id) as { note: string | null } | undefined;
      const changed = this.db.prepare("UPDATE items SET note = ? WHERE id = ?").run(text || null, id).changes > 0;
      if (changed) { this.log(id, actor, old!, { note: text || null }); this.reindex(id); }
      return changed;
    });
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
  setTrashed(id: number, trashed: boolean, actor?: string): boolean {
    const changed = this.transaction(() => {
      const old = this.db.prepare("SELECT trashed_at FROM items WHERE id = ?").get(id) as { trashed_at: string | null } | undefined;
      const did = this.db
        .prepare("UPDATE items SET trashed_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END WHERE id = ? AND (trashed_at IS NOT NULL) <> ?")
        .run(trashed ? 1 : 0, id, trashed ? 1 : 0).changes > 0;
      if (did) this.log(id, actor, old!, { trashed_at: trashed ? "now" : null });
      return did;
    });
    if (changed) {
      // Announced after the (possibly enclosing) transaction has settled; a rolled-back change is not announced.
      setImmediate(() => {
        try { if (!!this.get(id)?.trashedAt === trashed) this.onTrash?.(id, trashed); } catch { /* a hook must not break the store */ }
      });
    }
    return changed || this.db.prepare("SELECT 1 FROM items WHERE id = ?").get(id) !== undefined;
  }

  /**
   * Replace a card's tag list (the reader's or an agent's correction of the summary). At most 8 tags, each
   * trimmed, lower-cased, 1-40 characters without control characters, duplicates dropped; [] clears them.
   * Null when there is no such item. Needs a summary to hold the tags.
   */
  setTags(id: number, tags: string[], actor?: string): Item | null {
    if (!Array.isArray(tags) || tags.length > 8) throw new ItemError("at most 8 tags");
    const clean: string[] = [];
    for (const raw of tags) {
      const t = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (!t || [...t].length > 40) throw new ItemError("each tag must be 1-40 characters");
      if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(t)) throw new ItemError("tags cannot contain control characters");
      if (guard(t).flags.length) throw new ItemError("tag rejected");
      if (!clean.includes(t)) clean.push(t);
    }
    const out = this.transaction(() => {
      const old = this.db.prepare("SELECT summary FROM items WHERE id = ?").get(id) as { summary: string | null } | undefined;
      if (!old) return false;
      let s: Record<string, unknown> | null = null;
      try { const p = JSON.parse(old.summary ?? "null"); if (p && typeof p === "object" && !Array.isArray(p)) s = p as Record<string, unknown>; } catch { /* no usable summary */ }
      if (!s) throw new ItemError("no summary yet");
      const next = JSON.stringify({ ...s, tags: clean });
      this.db.prepare("UPDATE items SET summary = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?").run(next, id);
      this.log(id, actor, old, { summary: next });
      this.reindex(id);
      return true;
    });
    return out ? this.get(id) : null;
  }

  /**
   * Delete a trashed card for good, with everything keyed by it, in one transaction. Only a card already in the
   * trash qualifies. False when there is no such item. (Cached pictures are keyed by URL and age out on their own.)
   */
  purgeItem(id: number, _actor?: string): boolean {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT trashed_at FROM items WHERE id = ?").get(id) as { trashed_at: string | null } | undefined;
      if (!row) return false;
      if (!row.trashed_at) throw new ItemError("move it to the trash first");
      this.dropItem(id);
      return true;
    });
  }

  /** Delete every trashed card ({@link purgeItem} for each, all or nothing). Returns how many went. */
  purgeTrash(): number {
    return this.transaction(() => {
      const ids = (this.db.prepare("SELECT id FROM items WHERE trashed_at IS NOT NULL").all() as { id: number }[]).map((r) => r.id);
      for (const id of ids) this.dropItem(id);
      return ids.length;
    });
  }

  private dropItem(id: number): void {
    for (const sql of [
      "DELETE FROM aliases WHERE item_id = ?", "DELETE FROM shares WHERE item_id = ?", "DELETE FROM feedback WHERE item_id = ?",
      "DELETE FROM found_in WHERE parent_id = ? OR child_id = ?", "DELETE FROM item_history WHERE item_id = ?", "DELETE FROM items WHERE id = ?",
    ]) this.db.prepare(sql).run(...(sql.includes("OR") ? [id, id] : [id]));
    unindexItem(this.db, id);
    this.vectors.remove(id);
  }

  /** Called (never awaited) after an item went to the trash or came back. */
  onTrash?: (id: number, trashed: boolean) => void;

  setFavorite(id: number, favorite: boolean, actor?: string): boolean {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT favorite FROM items WHERE id = ?").get(id) as { favorite: number } | undefined;
      const changed = this.db.prepare("UPDATE items SET favorite = ? WHERE id = ?").run(favorite ? 1 : 0, id).changes > 0;
      if (changed) this.log(id, actor, old!, { favorite: favorite ? 1 : 0 });
      return changed;
    });
  }

  /** Bulk {@link setTrashed}, all or nothing. Returns each item's earlier trash time for undo. */
  setTrashedMany(ids: number[], trashed: boolean, actor?: string): { id: number; trashed_at: string | null }[] {
    return this.inTransaction(ids, "trashed_at", (id, before) => {
      this.setTrashed(id, trashed, actor);
      return { id, trashed_at: (before.trashed_at as string | null) ?? null };
    });
  }

  /** Bulk {@link setFavorite}, all or nothing. Returns each item's earlier star for undo. */
  setFavoriteMany(ids: number[], favorite: boolean, actor?: string): { id: number; favorite: number }[] {
    return this.inTransaction(ids, "favorite", (id, before) => {
      this.setFavorite(id, favorite, actor);
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
    return this.transaction(() => this.enrichRow(id, summary, by, classify));
  }

  private enrichRow(id: number, summary: Summary, by: string, classify?: { category?: string; worth?: Worth }): Item {
    const old = this.db.prepare("SELECT id, title, summary, category, user_placed FROM items WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    const row = this.db
      .prepare(
        `UPDATE items SET summary = ?, title = ?, enriched_by = ?, claimed_at = NULL, claimed_by = NULL,
           category = CASE WHEN user_placed = 1 THEN category ELSE COALESCE(?, category) END, worth = COALESCE(?, worth),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? RETURNING *`,
      )
      .get(JSON.stringify(summary), summary.name, by, classify?.category ?? null, classify?.worth ?? null, id) as unknown as ItemRow;
    if (old) this.log(id, by, old, row as unknown as Record<string, unknown>);
    this.reindex(id);
    return toItem(row);
  }

  /** Net votes per item, for hiding items the community voted down. */
  private static readonly NET_VOTES = "(SELECT COALESCE(SUM(vote), 0) FROM feedback f WHERE f.item_id = items.id)";

  /**
   * `out.total` receives how many rows match, ignoring limit/offset (for paging); `out.corrected` the
   * query actually searched when the typed one matched nothing and a spelling correction did.
   */
  list(query: ListQuery = {}, out?: { total?: number; corrected?: string }): Item[] {
    const items = this.listOnce(query, out);
    if (items.length || query.fuzzy === false || !query.q?.trim()) return items;
    // An empty page past the end is not "nothing matched".
    if (out ? out.total : query.offset && this.listOnce({ ...query, offset: 0, limit: 1 }).length) return items;
    const corrected = this.correctQuery(query.q);
    if (!corrected) return items;
    const counted: { total?: number } = {};
    const again = this.listOnce({ ...query, q: corrected }, counted);
    if (!counted.total) return items;
    if (out) { out.total = counted.total; out.corrected = corrected; }
    return again;
  }

  /**
   * `q` with every misspelt word swapped for its closest catalogue word, or null when nothing changed.
   * A word is misspelt when it matches no card on its own; short, CJK and non-Latin words are left alone.
   */
  private correctQuery(q: string): string | null {
    if (/^\s*#\d{1,9}\s*$/.test(q)) return null;
    const terms = q.slice(0, 200).split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean).slice(0, 8);
    const hits = this.db.prepare("SELECT 1 FROM item_fts WHERE item_fts MATCH ? LIMIT 1");
    let folderWords: string[] | undefined;
    let changed = false;
    const out = terms.map((t) => {
      if ([...t].length < 4 || hits.get(ftsMatchQuery([t]))) return t;
      folderWords ??= this.folderWords();
      const c = correctTerm(this.db, t, folderWords);
      if (c) changed = true;
      return c ?? t;
    });
    return changed ? out.join(" ") : null;
  }

  /** Every word of every folder name (labels in all languages for built-in ones): part of the vocabulary. */
  private folderWords(): string[] {
    const rows = this.db.prepare("SELECT id, name FROM folders").all() as { id: string; name: string | null }[];
    return [...new Set(rows.flatMap((r) => folderNames(r.id, r.name).join(" ").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []))];
  }

  private listOnce(query: ListQuery, out?: { total?: number }): Item[] {
    const where: string[] = [query.view === "trash" ? "trashed_at IS NOT NULL" : "trashed_at IS NULL"];
    const args: (string | number)[] = [];
    if (query.view === "favorites") where.push("favorite = 1");
    if (query.view === "inbox") where.push("user_placed = 0");
    if (query.health?.length) {
      where.push(`health IN (${query.health.map(() => "?").join(",")})`);
      args.push(...query.health);
    }
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
    // "#47" is a card number, as printed on every card and used in notes.
    const byId = /^#(\d{1,9})$/.exec((query.q ?? "").trim());
    if (byId) { where.push("items.id = ?"); args.push(Number(byId[1])); }
    const terms = byId ? [] : (query.q ?? "").slice(0, 200).split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean).slice(0, 8);
    // Terms of 3+ characters go to the trigram index (substring match, CJK included); shorter ones
    // cannot be looked up there and keep the LIKE scan.
    const ftsTerms = terms.filter((t) => [...t].length >= 3);
    const likeTerms = terms.filter((t) => [...t].length < 3);
    const joinArgs: string[] = [];
    let join = "";
    const baseWhere = where.length;
    const baseArgs = args.length;
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
        // The folder path and "must-see" live only in the index row ("必看" is too short for the trigrams).
        `EXISTS (SELECT 1 FROM item_fts x WHERE x.rowid = items.id AND (${like("x.folder")} OR ${like("x.worth")}))`,
      ].join(" OR ")})`);
      const pat = `%${term.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(...Array<string>(13).fill(pat));
    }
    // The trash lists what was removed last first; elsewhere the best comes first.
    const order = query.view === "trash" ? "trashed_at DESC"
      : query.view === "inbox" ? "created_at DESC, id DESC"
      : query.sort === "newest" ? "created_at DESC, id DESC"
      : query.sort === "shared" ? `share_count DESC, ${WORTH_ORDER} DESC, updated_at DESC`
      : join ? `f.rank, ${WORTH_ORDER} DESC, updated_at DESC`
      : `${WORTH_ORDER} DESC, updated_at DESC`;
    const sem = query.semantic;
    if (sem && terms.length && this.vectors.count() > 0 && (!query.sort || query.sort === "best") && (!query.view || query.view === "all" || query.view === "favorites")) {
      return this.hybrid(sem, { join, joinArgs, where, args, baseWhere, baseArgs, order }, query, out);
    }
    if (out) out.total = (this.db.prepare(`SELECT COUNT(*) AS n FROM items ${join} WHERE ${where.join(" AND ")}`).get(...joinArgs, ...args) as { n: number }).n;
    const sql = `SELECT items.* FROM items ${join} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`;
    args.push(clampInt(query.limit, 1, 500, 50), clampInt(query.offset, 0, 1_000_000, 0));
    return (this.db.prepare(sql).all(...joinArgs, ...args) as unknown as ItemRow[]).map(toItem);
  }

  /**
   * Keyword rank + vector rank, fused. Every filter still applies (the vector side only considers items
   * the filters allow), and the page and total are cut from the fused list, so X-Total-Count is its length.
   */
  private hybrid(
    sem: { vec: Float32Array; floor?: number },
    q: { join: string; joinArgs: string[]; where: string[]; args: (string | number)[]; baseWhere: number; baseArgs: number; order: string },
    query: ListQuery, out?: { total?: number },
  ): Item[] {
    const lex = (this.db.prepare(`SELECT items.id FROM items ${q.join} WHERE ${q.where.join(" AND ")} ORDER BY ${q.order}`)
      .all(...q.joinArgs, ...q.args) as { id: number }[]).map((r) => r.id);
    const near = this.nearestAllowed(sem.vec, sem.floor ?? DEFAULT_FLOOR, SEMANTIC_MAX, q.where.slice(0, q.baseWhere).join(" AND "), q.args.slice(0, q.baseArgs));
    const score = new Map<number, number>();
    const lexRank = new Map<number, number>();
    lex.forEach((id, i) => { lexRank.set(id, i); score.set(id, 1 / (RRF_K + i + 1)); });
    near.forEach((h, i) => score.set(h.id, (score.get(h.id) ?? 0) + 1 / (RRF_K + i + 1)));
    const merged = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || (lexRank.get(a) ?? 1e9) - (lexRank.get(b) ?? 1e9) || a - b);
    if (out) out.total = merged.length;
    const page = merged.slice(clampInt(query.offset, 0, 1_000_000, 0)).slice(0, clampInt(query.limit, 1, 500, 50));
    if (!page.length) return [];
    const rows = this.db.prepare(`SELECT * FROM items WHERE id IN (${page.map(() => "?").join(",")})`).all(...page) as unknown as ItemRow[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return page.map((id) => byId.get(id)!).map(toItem);
  }

  /**
   * The `want` nearest items that also pass `filter` (SQL over items, with `args`). The scan keeps only a
   * few times `want` candidates and one query checks them, instead of loading every allowed id; when the
   * filter throws too many away it widens the scan, so the result is the same as filtering first.
   */
  private nearestAllowed(vec: Float32Array, floor: number, want: number, filter: string, args: (string | number)[], exclude?: number): Hit[] {
    const total = this.vectors.count();
    for (let k = want * 4; ; k *= 4) {
      const near = this.vectors.nearest(vec, exclude === undefined ? { floor, max: k } : { floor, max: k, exclude });
      const ok = new Set<number>();
      for (let i = 0; i < near.length; i += 500) { // chunks stay under SQLite's variable limit
        const part = near.slice(i, i + 500).map((h) => h.id);
        for (const r of this.db.prepare(`SELECT id FROM items WHERE id IN (${part.map(() => "?").join(",")}) AND ${filter}`).all(...part, ...args) as { id: number }[]) ok.add(r.id);
      }
      const kept = near.filter((h) => ok.has(h.id));
      if (kept.length >= want || near.length < k || k >= total) return kept.slice(0, want);
    }
  }

  /**
   * Cards like this one, as {id, name}: nearest by vector when vectors exist, topped up (or replaced)
   * by shared tags and name words. Never the card itself, trashed, down-voted or injection-flagged ones.
   */
  related(id: number, limit = 5, floor = DEFAULT_FLOOR + 0.15): { id: number; name: string }[] {
    const clean = `trashed_at IS NULL AND flags NOT LIKE '%injection%' AND ${Store.NET_VOTES} > -2`;
    const picked: number[] = [];
    const vec = this.vectors.count() > 0 ? this.vectors.vectorOf(id) : undefined;
    if (vec) {
      picked.push(...this.nearestAllowed(vec, floor, limit, clean, [], id).map((h) => h.id));
    }
    if (picked.length < limit) {
      for (const c of this.relatedByWords(id, clean)) if (picked.length < limit && !picked.includes(c)) picked.push(c);
    }
    if (!picked.length) return [];
    const rows = this.db.prepare(`SELECT id, title, json_extract(CASE WHEN json_valid(summary) THEN summary ELSE '{}' END, '$.name') AS name FROM items WHERE id IN (${picked.map(() => "?").join(",")})`)
      .all(...picked) as { id: number; title: string; name: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return picked.map((pid) => byId.get(pid)!).map((r) => ({ id: r.id, name: r.name || r.title }));
  }

  /** The no-vector fallback: a shared tag is worth 1, a shared word of the name 2; at least 2 to count. */
  private relatedByWords(id: number, clean: string): number[] {
    const item = this.get(id);
    if (!item) return [];
    const tags = [...new Set((item.summary?.tags ?? []).map((t) => t.replace(/"/g, "").trim()).filter((t) => [...t].length >= 3))].slice(0, 8);
    const name = item.summary?.name ?? item.title;
    const words = [...new Set(name.split(/[\s\-_/:.,()]+/).map((w) => w.replace(/"/g, "")).filter((w) => [...w].length >= 3))].slice(0, 3);
    const score = new Map<number, number>();
    const find = (col: string, term: string, weight: number) => {
      for (const r of this.db.prepare("SELECT rowid FROM item_fts WHERE item_fts MATCH ? LIMIT 500").all(`${col} : ${ftsMatchQuery([term])}`) as { rowid: number }[]) {
        if (r.rowid !== id) score.set(r.rowid, (score.get(r.rowid) ?? 0) + weight);
      }
    };
    for (const t of tags) find("tags", t, 1);
    for (const w of words) find("name", w, 2);
    const cands = [...score].filter(([, v]) => v >= 2).map(([k]) => k);
    if (!cands.length) return [];
    const ok = new Set((this.db.prepare(`SELECT id FROM items WHERE id IN (${cands.map(() => "?").join(",")}) AND ${clean}`).all(...cands) as { id: number }[]).map((r) => r.id));
    return cands.filter((c) => ok.has(c)).sort((a, b) => score.get(b)! - score.get(a)! || a - b);
  }

  /** Items shared at least `min` times since `since` (counting share events, not the lifetime total), most first. */
  sharedSince(since: string, min = 2, limit = 10): { id: number; shares: number }[] {
    return this.db
      .prepare("SELECT item_id AS id, COUNT(*) AS shares FROM shares WHERE at >= ? GROUP BY item_id HAVING COUNT(*) >= ? ORDER BY shares DESC, item_id LIMIT ?")
      .all(since, min, limit) as { id: number; shares: number }[];
  }

  /** Cards the link check marked dead, archived or stale (the "Needs review" view). */
  reviewCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM items WHERE health IN ('dead','archived','stale') AND trashed_at IS NULL AND flags NOT LIKE '%injection%' AND ${Store.NET_VOTES} > -2`).get() as { n: number }).n;
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
/** What a repo extractor already knows at ingest time. */
export interface RepoFacts { stars?: number; pushedAt?: string; archived?: boolean }

/** Bind values for (stars, pushed_at, health, health_checked_at) in that order. */
function repoArgs(r?: RepoFacts): (string | number | null)[] {
  return [
    r?.stars ?? null, r?.pushedAt ?? null,
    r?.archived ? "archived" : null, r?.archived ? new Date().toISOString() : null,
  ];
}

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
    health: (r.health as Health | null) ?? null,
    healthCheckedAt: r.health_checked_at ?? null,
    stars: r.stars ?? null,
    pushedAt: r.pushed_at ?? null,
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
