/**
 * Versioned schema migrations, keyed by PRAGMA user_version.
 *
 * To add a feature column/table/index: APPEND one entry to MIGRATIONS (next version number, never edit
 * or reorder an existing one) and put the DDL/backfill in its `up`. Each migration after the first runs
 * in a single transaction together with the user_version bump; a failure rolls back and throws.
 * A database newer than the last entry is refused. Before pending migrations touch an existing
 * non-empty file, a copy is written to `<db>.bak-v<old version>` (once).
 *
 * Migration 1 is the whole 0.7.0 schema and is idempotent, so a pre-versioning database (user_version 0
 * with tables already there) is caught up and stamped by the same code that builds a fresh one.
 */
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { FTS_COLUMNS, reindexAll } from "./search-index.ts";

export interface Migration {
  version: number;
  description: string;
  up(db: DatabaseSync): void;
}

export class MigrationError extends Error {}

const hasColumn = (db: DatabaseSync, table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

function v1(db: DatabaseSync): void {
  db.exec(`
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
    -- One key per agent, so a leaked config is one revoke away and the admin password stays private.
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
      hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      last_used_at TEXT,
      revoked_at TEXT
    );
    -- One-time codes that turn a QR scan into a device token. Only the hash is kept.
    CREATE TABLE IF NOT EXISTS pair_codes (
      hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS items_category ON items(category);
    CREATE INDEX IF NOT EXISTS shares_item ON shares(item_id);
    CREATE INDEX IF NOT EXISTS aliases_item ON aliases(item_id);
    CREATE INDEX IF NOT EXISTS items_source ON items(source);
  `);
  // Links recorded before found_in existed live in share notes; recover them once.
  const done = db.prepare("SELECT value FROM state WHERE key = 'found_in_recovered'").get() as { value: string } | undefined;
  if (done?.value !== "1") {
    db.exec(`
      INSERT OR IGNORE INTO found_in (parent_id, child_id)
      SELECT p.id, s.item_id FROM shares s
      JOIN items p ON p.url = substr(s.note, CASE WHEN s.note LIKE 'Mentioned in %' THEN 14 ELSE 13 END)
      WHERE (s.note LIKE 'Mentioned in %' OR s.note LIKE 'Linked from %') AND p.id <> s.item_id`);
    db.exec("INSERT INTO state (key, value) VALUES ('found_in_recovered', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  }
  // Columns added after the first release.
  for (const [name, type] of [
    ["claimed_at", "TEXT"], ["claimed_by", "TEXT"], ["enriched_by", "TEXT"],
    ["trashed_at", "TEXT"], ["favorite", "INTEGER NOT NULL DEFAULT 0"],
    // 1 once the reader moved the item: nobody re-classifies it after that.
    ["user_placed", "INTEGER NOT NULL DEFAULT 0"],
    // The reader's own words about the item.
    ["note", "TEXT"],
    // Who acted, when known: "admin" or "agent:<token id>".
    ["claimed_actor", "TEXT"], ["moved_by", "TEXT"],
    // The classifier's top folders as JSON [{folder, score}]: what the Inbox offers as one-tap chips.
    ["suggestions", "TEXT"],
    // Candidate pictures as JSON [{url, kind, alt}] (original URLs; the server proxies them).
    ["media", "TEXT"],
  ] as const) {
    if (!hasColumn(db, "items", name)) db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
  }
  // Which folders came from the seed (the reader didn't make them): an AI plan may rename or merge only those.
  if (!hasColumn(db, "folders", "builtin")) {
    db.exec("ALTER TABLE folders ADD COLUMN builtin INTEGER NOT NULL DEFAULT 0");
    // Folders made before the marker existed: a never-renamed shelf is certainly a built-in one.
    db.exec("UPDATE folders SET builtin = 1 WHERE name IS NULL");
  }
}

export const MIGRATIONS: Migration[] = [
  { version: 1, description: "base schema (0.7.0)", up: v1 },
  {
    version: 2,
    description: "full-text search index",
    up(db) {
      db.exec(`CREATE VIRTUAL TABLE item_fts USING fts5(${FTS_COLUMNS.join(", ")}, tokenize='trigram')`);
      reindexAll(db);
    },
  },
  {
    version: 3,
    description: "link health (dead / archived / stale / moved) and repo stars",
    up(db) {
      for (const [name, type] of [["health", "TEXT"], ["health_checked_at", "TEXT"], ["stars", "INTEGER"], ["pushed_at", "TEXT"]] as const) {
        if (!hasColumn(db, "items", name)) db.exec(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
      }
    },
  },
  // (version 4 belongs to the semantic-search branch.)
  {
    version: 5,
    description: "per-card change history (undo / restore)",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS item_history (
        id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL,
        field_set TEXT NOT NULL, before TEXT NOT NULL
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_item_history_item ON item_history (item_id, id)");
    },
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function schemaVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Bring `db` to the newest schema. `path` enables the pre-migration backup (omit or ":memory:" to skip). */
export function migrate(db: DatabaseSync, opts: { path?: string; migrations?: Migration[] } = {}): void {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations[migrations.length - 1]!.version;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new MigrationError(`this database was written by a newer driftnet (schema ${current}); upgrade driftnet (this version knows schema ${latest})`);
  }
  const pending = migrations.filter((m) => m.version > current);
  if (!pending.length) return;

  const { path } = opts;
  const nonEmpty = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number }).n > 0;
  if (path && path !== ":memory:" && nonEmpty) {
    const bak = `${path}.bak-v${current}`;
    if (!existsSync(bak)) db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
  }

  for (const m of pending) {
    db.exec("BEGIN");
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw new MigrationError(`migration ${m.version} (${m.description}) failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
