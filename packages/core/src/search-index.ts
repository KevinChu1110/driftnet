import type { DatabaseSync } from "node:sqlite";
import { categoryLabel, LOCALES, messages } from "./i18n.ts";

/**
 * Full-text index over items (one row per item, rowid = items.id).
 *
 * tokenize='trigram' is used rather than unicode61: Chinese/Japanese have no spaces, so a word
 * tokenizer cannot match a substring such as "轉成" inside "把PDF轉成Markdown", while trigrams match any
 * substring of 3+ characters, case-insensitively. Terms shorter than 3 characters cannot be
 * looked up in a trigram index; the store answers those with its LIKE path.
 *
 * `folder` holds the names along the card's folder path (a renamed or reader-made folder by its own
 * name, a built-in one by its label in every language); `worth` holds "must-see 必看" for must-see cards.
 */
export const FTS_COLUMNS = ["name", "one_liner", "highlights", "tags", "use_cases", "demo", "why", "title", "url", "note", "chat", "folder", "worth"] as const;

/** bm25 weights, in FTS_COLUMNS order: what the item is called counts far more than a passing chat remark or the shelf it sits on. */
export const FTS_WEIGHTS = [10, 5, 3, 5, 2, 1, 1, 8, 2, 3, 1, 2, 1];

/**
 * A word-level twin of the index (unicode61, contentless: words only, no stored text), read through
 * `item_words_vocab` (fts5vocab) as the vocabulary a misspelt search term is corrected against.
 */
export const WORDS_DDL = [
  "CREATE VIRTUAL TABLE item_words USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')",
  "CREATE VIRTUAL TABLE item_words_vocab USING fts5vocab(item_words, 'row')",
];

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): string => (Array.isArray(v) ? v.map(str).filter(Boolean).join("\n") : "");
const uniq = (xs: string[]) => xs.filter((x, i) => x && xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);

/** What a folder is called: its own name once the reader named it, else the built-in label in every language. */
export function folderNames(id: string, name: string | null): string[] {
  return name ? [name] : uniq(LOCALES.map((l) => categoryLabel(id, l)));
}

/** The names along a folder's path, root first ("" for a folder that doesn't exist). */
export function folderPathText(db: DatabaseSync, id: string): string {
  const read = db.prepare("SELECT parent_id AS parent, name FROM folders WHERE id = ?");
  const names: string[][] = [];
  const seen = new Set<string>();
  for (let cur: string | null = id; cur && !seen.has(cur); ) {
    seen.add(cur);
    const r = read.get(cur) as { parent: string | null; name: string | null } | undefined;
    if (!r) break;
    names.unshift(folderNames(cur, r.name));
    cur = r.parent;
  }
  return names.flat().join("\n");
}

export function worthText(worth: string): string {
  return worth === "must-see" ? uniq(["must-see", ...LOCALES.map((l) => messages(l).rich.worthName["must-see"])]).join("\n") : "";
}

/**
 * A write to an index table. FTS5 stores its own pages (and the contentless table its tombstones) under
 * rowids above 2^53, which then become the connection's last-insert rowid: node:sqlite would throw "too
 * large to be represented as a JavaScript number" on this run and on the next plain statement that runs.
 * So this run reads it as a BigInt, and a one-row temp table puts the last-insert rowid back to 0.
 */
const resets = new WeakMap<DatabaseSync, { run(): unknown }>();
function write(db: DatabaseSync, sql: string) {
  const st = db.prepare(sql);
  st.setReadBigInts(true);
  let reset = resets.get(db);
  if (!reset) {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS dn_rowid_reset (x)");
    reset = db.prepare("INSERT OR REPLACE INTO temp.dn_rowid_reset (rowid) VALUES (0)");
    resets.set(db, reset);
  }
  const r = reset;
  return { run: (...args: (string | number | null)[]) => { st.run(...args); r.run(); } };
}

/** Take an item out of both indexes (it was deleted). */
export function unindexItem(db: DatabaseSync, id: number): void {
  write(db, "DELETE FROM item_fts WHERE rowid = ?").run(id);
  write(db, "DELETE FROM item_words WHERE rowid = ?").run(id);
}

/** Rebuild one item's index row from the current database contents. `folders` caches path texts across calls. */
export function reindexItem(db: DatabaseSync, id: number, folders?: Map<string, string>): void {
  unindexItem(db, id);
  const row = db.prepare("SELECT title, url, note, summary, category, worth FROM items WHERE id = ?").get(id) as
    | { title: string; url: string; note: string | null; summary: string | null; category: string; worth: string } | undefined;
  if (!row) return;
  let s: Record<string, unknown> = {};
  try { const p = JSON.parse(row.summary ?? "null"); if (p && typeof p === "object") s = p as Record<string, unknown>; } catch { /* no summary */ }
  // driftnet's own "Mentioned in …" / "Linked from …" bookkeeping is not something anyone said.
  const chat = (db.prepare(
    "SELECT note FROM shares WHERE item_id = ? AND note IS NOT NULL AND note NOT LIKE 'Mentioned in %' AND note NOT LIKE 'Linked from %'",
  ).all(id) as { note: string }[]).map((r) => r.note).join("\n");
  let folder = folders?.get(row.category);
  if (folder === undefined) { folder = folderPathText(db, row.category); folders?.set(row.category, folder); }
  const text = [str(s.name), str(s.oneLiner), list(s.highlights), list(s.tags), list(s.useCases), str(s.demo), str(s.why), row.title, row.url, row.note ?? "", chat];
  write(db, `INSERT INTO item_fts (rowid, ${FTS_COLUMNS.join(", ")}) VALUES (?, ${FTS_COLUMNS.map(() => "?").join(", ")})`).run(
    id, ...text, folder, worthText(row.worth),
  );
  // The URL is left out of the vocabulary: "https", "www" and path slugs are not words to correct towards.
  write(db, "INSERT INTO item_words (rowid, body) VALUES (?, ?)").run(id, text.filter((_, i) => i !== 8).join("\n"));
}

export function reindexAll(db: DatabaseSync): void {
  db.exec("DELETE FROM item_fts");
  db.exec("INSERT INTO item_words (item_words) VALUES ('delete-all')");
  const folders = new Map<string, string>();
  for (const r of db.prepare("SELECT id FROM items").all() as { id: number }[]) reindexItem(db, r.id, folders);
}

/**
 * Bring the folder column up to date for every card directly in `folderIds` (after a rename, a move of
 * the folder, a merge): one UPDATE per folder, the caller's transaction around all of them.
 */
export function refreshFolderText(db: DatabaseSync, folderIds: Iterable<string>): void {
  const up = write(db, "UPDATE item_fts SET folder = ? WHERE rowid IN (SELECT id FROM items WHERE category = ?) AND folder IS NOT ?");
  for (const id of new Set(folderIds)) { const text = folderPathText(db, id); up.run(text, id, text); }
}

/** Bring the folder column up to date for these cards (after they were moved). */
export function refreshItemFolders(db: DatabaseSync, itemIds: Iterable<number>): void {
  const cat = db.prepare("SELECT category FROM items WHERE id = ?");
  const up = write(db, "UPDATE item_fts SET folder = ? WHERE rowid = ? AND folder IS NOT ?");
  const texts = new Map<string, string>();
  for (const id of itemIds) {
    const c = (cat.get(id) as { category: string } | undefined)?.category;
    if (c === undefined) continue;
    if (!texts.has(c)) texts.set(c, folderPathText(db, c));
    up.run(texts.get(c)!, id, texts.get(c)!);
  }
}

/** Quote each term as an FTS5 string (double quotes stripped) and AND them: no user input is ever syntax. */
export function ftsMatchQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" AND ");
}

// ── Typo tolerance ─────────────────────────────────────────────────────────

/** Only words in Latin letters and digits are corrected; CJK (and anything else) is left exactly as typed. */
const FUZZABLE = /^[\p{Script=Latin}\p{Nd}]{4,40}$/u;
/** Rows read from the vocabulary per prefix: bounds the work however large the catalogue grows. */
const VOCAB_SCAN = 5000;

/** Optimal-string-alignment distance (a swap of two neighbours counts 1), or max + 1 once it can't stay within `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
      cur.push(d);
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The closest known word to a misspelt `term` (edit distance 1; 2 for terms of 8+ characters), or null.
 * Candidates are words of the catalogue that start with the term's first or second letter (so a slip
 * anywhere but the very first letter is caught, and a swap of the first two too), plus `extra` words
 * (folder names). Among the closest, the word on the most cards wins.
 */
export function correctTerm(db: DatabaseSync, term: string, extra: Iterable<string> = []): string | null {
  const t = term.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  if (!FUZZABLE.test(t)) return null;
  const max = t.length >= 8 ? 2 : 1;
  const scan = db.prepare(`SELECT term, doc FROM item_words_vocab WHERE term >= ? AND term < ? AND length(term) BETWEEN ? AND ? LIMIT ${VOCAB_SCAN}`);
  const seen = new Map<string, number>();
  for (const c of new Set([t[0]!, t[1]!])) {
    const next = String.fromCodePoint(c.codePointAt(0)! + 1);
    for (const r of scan.all(c, next, t.length - max, t.length + max) as { term: string; doc: number }[]) seen.set(r.term, r.doc);
  }
  for (const w of extra) { const k = w.toLowerCase(); if (!seen.has(k)) seen.set(k, 1); }
  let best: string | null = null;
  let bestD = max + 1;
  let bestN = 0;
  for (const [w, n] of seen) {
    if (w === t || !FUZZABLE.test(w)) continue;
    const d = editDistance(t, w, max);
    if (d < bestD || (d === bestD && d <= max && n > bestN)) { best = w; bestD = d; bestN = n; }
  }
  return bestD <= max ? best : null;
}
