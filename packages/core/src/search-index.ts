import type { DatabaseSync } from "node:sqlite";

/**
 * Full-text index over items (one row per item, rowid = items.id).
 *
 * tokenize='trigram' is used rather than unicode61: Chinese/Japanese have no spaces, so a word
 * tokenizer cannot match a substring such as "轉成" inside "把PDF轉成Markdown", while trigrams match any
 * substring of 3+ characters, case-insensitively. Terms shorter than 3 characters cannot be
 * looked up in a trigram index; the store answers those with its LIKE path.
 */
export const FTS_COLUMNS = ["name", "one_liner", "highlights", "tags", "use_cases", "demo", "why", "title", "url", "note", "chat"] as const;

/** bm25 weights, in FTS_COLUMNS order: what the item is called counts far more than a passing chat remark. */
export const FTS_WEIGHTS = [10, 5, 3, 5, 2, 1, 1, 8, 2, 3, 1];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string => (Array.isArray(v) ? v.map(str).filter(Boolean).join("\n") : "");

/** Rebuild one item's index row from the current database contents. */
export function reindexItem(db: DatabaseSync, id: number): void {
  db.prepare("DELETE FROM item_fts WHERE rowid = ?").run(id);
  const row = db.prepare("SELECT title, url, note, summary FROM items WHERE id = ?").get(id) as
    | { title: string; url: string; note: string | null; summary: string | null } | undefined;
  if (!row) return;
  let s: Record<string, unknown> = {};
  try { const p = JSON.parse(row.summary ?? "null"); if (p && typeof p === "object") s = p as Record<string, unknown>; } catch { /* no summary */ }
  // driftnet's own "Mentioned in …" / "Linked from …" bookkeeping is not something anyone said.
  const chat = (db.prepare(
    "SELECT note FROM shares WHERE item_id = ? AND note IS NOT NULL AND note NOT LIKE 'Mentioned in %' AND note NOT LIKE 'Linked from %'",
  ).all(id) as { note: string }[]).map((r) => r.note).join("\n");
  db.prepare(`INSERT INTO item_fts (rowid, ${FTS_COLUMNS.join(", ")}) VALUES (?, ${FTS_COLUMNS.map(() => "?").join(", ")})`).run(
    id, str(s.name), str(s.oneLiner), list(s.highlights), list(s.tags), list(s.useCases), str(s.demo), str(s.why),
    row.title, row.url, row.note ?? "", chat,
  );
}

export function reindexAll(db: DatabaseSync): void {
  db.exec("DELETE FROM item_fts");
  for (const r of db.prepare("SELECT id FROM items").all() as { id: number }[]) reindexItem(db, r.id);
}

/** Quote each term as an FTS5 string (double quotes stripped) and AND them: no user input is ever syntax. */
export function ftsMatchQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
}
