import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { LATEST_VERSION, migrate, MigrationError, schemaVersion } from "../src/migrations.ts";
import { Store } from "../src/store.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "dn-mig-")), "sub", "d.db");
const version = (path: string) => { const d = new DatabaseSync(path); try { return schemaVersion(d); } finally { d.close(); } };

// The 0.7.0 store, before any column was added later: what an old database looks like on disk.
const OLD_SCHEMA = `
  CREATE TABLE items (id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL,
    worth TEXT NOT NULL, is_ai_tool REAL NOT NULL, summary TEXT, judge_engine TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', share_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
  CREATE TABLE aliases (url TEXT PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE);
  CREATE TABLE shares (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, platform TEXT NOT NULL,
    chat_id TEXT NOT NULL, user_id TEXT, note TEXT, at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')));
  CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE folders (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES folders(id), name TEXT, description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0);
  INSERT INTO folders (id, name) VALUES ('news', NULL), ('mine', 'My shelf');
  INSERT INTO items (url, title, kind, category, worth, is_ai_tool, judge_engine, summary) VALUES
    ('https://old.test/a', 'Old tool', 'repo', 'news', 'normal', 1, 'jev', '{"name":"Old tool","oneLiner":"把 PDF 轉成 Markdown","highlights":[],"useCases":[],"tags":["pdf"]}'),
    ('https://old.test/b', 'Another', 'repo', 'news', 'low', 0, 'jev', NULL);
  INSERT INTO shares (item_id, platform, chat_id, note) VALUES (1, 'tg', 'c', 'great for scans'), (2, 'tg', 'c', 'Mentioned in https://old.test/a');
`;

test("a fresh database ends at the latest version", () => {
  const path = tmp();
  new Store(path);
  assert.equal(version(path), LATEST_VERSION);
  assert.ok(LATEST_VERSION >= 2);
  assert.equal(existsSync(`${path}.bak-v0`), false, "an empty file needs no backup");
});

test("a pre-versioning database is caught up and stamped without losing data, after a backup", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "dn-old-")), "old.db");
  const raw = new DatabaseSync(dir);
  raw.exec(OLD_SCHEMA);
  assert.equal(schemaVersion(raw), 0);
  raw.close();

  const store = new Store(dir);
  assert.equal(version(dir), LATEST_VERSION);
  assert.equal(existsSync(`${dir}.bak-v0`), true);
  const bak = new DatabaseSync(`${dir}.bak-v0`);
  assert.equal((bak.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n, 2);
  assert.equal(schemaVersion(bak), 0, "the backup is the untouched old database");
  bak.close();

  assert.equal(store.get(1)!.title, "Old tool");
  assert.equal(store.itemCount(), 2);
  assert.equal(store.folders().find((f) => f.id === "news")!.builtin, true);
  assert.equal(store.folders().find((f) => f.id === "mine")!.builtin, false);
  assert.equal(store.setNote(1, "hello"), true, "columns added after 0.7.0 exist now");
  assert.deepEqual(store.list({ q: "scans" }).map((i) => i.id), [1], "old rows are searchable after the backfill");
  // Second open: nothing pending, nothing changes.
  new Store(dir);
  assert.equal(version(dir), LATEST_VERSION);
});

test("migration 6 rebuilds a v5 search index with folder names, must-see and the word vocabulary", () => {
  const path = tmp();
  const s = new Store(path);
  s.seedFolders({ "coding-agent": "c", other: "o" });
  const judgement = { isAiTool: 1, category: "coding-agent", kind: "repo" as const, worth: "must-see" as const, engine: "jev" as const, confidence: 1 };
  const id = s.upsert({ url: "https://m6.test/a", aliases: [], title: "Aider", judgement, flags: [], source: "s",
    summary: { name: "Aider", oneLiner: "design helper in the terminal", highlights: [], useCases: [], tags: [], primaryUrl: "https://m6.test/a" } }).id;
  // What a 0.11 (schema 5) database holds: the 11-column index and no word table.
  const raw = new DatabaseSync(path);
  raw.exec(`DROP TABLE item_fts; DROP TABLE item_words_vocab; DROP TABLE item_words;
    CREATE VIRTUAL TABLE item_fts USING fts5(name, one_liner, highlights, tags, use_cases, demo, why, title, url, note, chat, tokenize='trigram');
    INSERT INTO item_fts (rowid, name, one_liner, title) VALUES (${id}, 'Aider', 'design helper in the terminal', 'Aider');
    PRAGMA user_version = 5`);
  raw.close();

  const store = new Store(path);
  assert.equal(version(path), LATEST_VERSION);
  assert.equal(existsSync(`${path}.bak-v5`), true, "backed up before the index is rebuilt");
  assert.deepEqual(store.list({ q: "aider" }).map((i) => i.id), [id], "existing rows are still found");
  assert.deepEqual(store.list({ q: "coding agents" }).map((i) => i.id), [id], "by the folder's label");
  assert.deepEqual(store.list({ q: "寫程式" }).map((i) => i.id), [id], "by its zh-TW label");
  assert.deepEqual(store.list({ q: "必看" }).map((i) => i.id), [id]);
  const out: { corrected?: string } = {};
  assert.deepEqual(store.list({ q: "desgin" }, out).map((i) => i.id), [id], "the vocabulary is filled");
  assert.equal(out.corrected, "design");
});

test("a database from a newer driftnet is refused", () => {
  const path = tmp();
  new Store(path);
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
  raw.close();
  assert.throws(() => new Store(path), /newer driftnet \(schema \d+\); upgrade driftnet/);
});

test("a failing migration rolls back, leaves the version, and reports clearly", () => {
  const path = tmp();
  new Store(path);
  const db = new DatabaseSync(path);
  const before = schemaVersion(db);
  const migrations = [
    { version: before, description: "known", up() {} },
    { version: before + 1, description: "boom", up(d: DatabaseSync) { d.exec("CREATE TABLE half_done (x)"); throw new Error("bad data"); } },
  ];
  assert.throws(() => migrate(db, { path, migrations }), (e: unknown) => e instanceof MigrationError && /migration \d+ \(boom\) failed and was rolled back: bad data/.test(e.message));
  assert.equal(schemaVersion(db), before);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get(), undefined);
  assert.equal(existsSync(`${path}.bak-v${before}`), true);
  db.close();
});

test("later migrations apply in order inside their own transaction", () => {
  const db = new DatabaseSync(":memory:");
  const seen: number[] = [];
  const migrations = [1, 2, 3].map((version) => ({ version, description: `m${version}`, up(d: DatabaseSync) { seen.push(version); d.exec(`CREATE TABLE t${version} (x)`); } }));
  migrate(db, { migrations });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(schemaVersion(db), 3);
  migrate(db, { migrations });
  assert.deepEqual(seen, [1, 2, 3], "already applied: nothing re-runs");
});
