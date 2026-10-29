import { chmodSync, closeSync, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw, deflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { parseEnv } from "node:util";
import { SCHEMA_LATEST, defaultDbPath, migrate, schemaVersion } from "@driftnet/core";
import { SETTINGS, isSecretSetting, serialize } from "./settings.ts";

/**
 * One-click backup and restore.
 *
 * A backup is a zip of exactly three files: driftnet.db (a consistent snapshot made with
 * VACUUM INTO into a private temp folder; the live file is never copied), settings.env
 * (every secret removed unless asked) and manifest.json. A restore never touches the live
 * database: the zip is validated, the database is staged as `<db>.restore-pending`, and the
 * swap happens at the next start (applyPendingRestore, called before the store opens).
 */

export class BackupError extends Error {}
/** The upload itself is over the cap (HTTP 413), as opposed to something wrong inside the zip (400). */
export class TooBig extends BackupError {}

export const BACKUP_FORMAT = "driftnet-backup";
export const RESTORE_MAX_BYTES = 200 * 1024 * 1024;
/** Decompressed size caps: a small zip must not be able to fill the disk. */
const DB_MAX_BYTES = 1024 * 1024 * 1024;
const TEXT_MAX_BYTES = 256 * 1024;
const ALLOWED = new Set(["manifest.json", "driftnet.db", "settings.env"]);
const SQLITE_MAGIC = "SQLite format 3\0";

export interface Manifest {
  format: typeof BACKUP_FORMAT;
  driftnet: string;
  schema: number;
  created: string;
  items: number;
  secrets: boolean;
}

/** The database file this process uses (the same rule as createDriftnet). */
export const dbPathOf = (env: NodeJS.ProcessEnv): string => env.DRIFTNET_DB ?? defaultDbPath(env);

const quote = (path: string) => path.replace(/'/g, "''");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** A private (0700) work folder next to the database: same disk as the data, never world-readable, always removed by the caller. */
export function workDir(dbPath: string, prefix: string): string {
  if (dbPath === ":memory:") throw new BackupError("this driftnet keeps its data in memory; there is no file to back up or restore");
  const parent = dirname(dbPath);
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `.${prefix}-`));
}
export const removeDir = (dir: string) => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

// ── Snapshot ──────────────────────────────────────────────────────────────────

/** VACUUM INTO a new file: consistent even while the server writes (WAL), and never a copy of the live file. */
export function snapshotTo(dbPath: string, dest: string): void {
  if (dbPath === ":memory:" || !existsSync(dbPath)) throw new BackupError("there is no database file to back up");
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    src.exec(`VACUUM INTO '${quote(dest)}'`);
  } finally {
    src.close();
  }
  chmodSync(dest, 0o600);
}

/** Objects a restored database may contain beyond plain tables: only the ones our own schema creates. */
function knownCode(): Set<string> {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    return new Set((db.prepare("SELECT type || ':' || name AS k FROM sqlite_master WHERE type IN ('trigger','view')").all() as { k: string }[]).map((r) => r.k));
  } finally {
    db.close();
  }
}

/**
 * Is this file a driftnet database we can run? Header, integrity, our tables, a schema
 * no newer than this code, and no trigger or view that our own schema does not create
 * (a backup is someone else's file: it must not carry code that runs inside our database).
 */
export function inspectDb(file: string): { schema: number; items: number } {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    if (head.toString("latin1") !== SQLITE_MAGIC) throw new BackupError("driftnet.db is not a SQLite database");
  } finally {
    closeSync(fd);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new BackupError("driftnet.db could not be opened");
  }
  try {
    db.exec("PRAGMA trusted_schema = OFF");
    const check = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (check.length !== 1 || check[0]!.integrity_check !== "ok") throw new BackupError("the database in this backup is damaged (integrity check failed)");
    const schema = schemaVersion(db);
    if (schema > SCHEMA_LATEST) throw new BackupError(`this backup was made by a newer driftnet (schema ${schema}); upgrade driftnet first (this version knows schema ${SCHEMA_LATEST})`);
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name));
    if (!tables.has("items") || !tables.has("state")) throw new BackupError("this database is not a driftnet database");
    const known = knownCode();
    for (const r of db.prepare("SELECT type || ':' || name AS k FROM sqlite_master WHERE type IN ('trigger','view')").all() as { k: string }[]) {
      if (!known.has(r.k)) throw new BackupError(`the database holds code driftnet did not create (${r.k.split(":")[0]}); refusing it`);
    }
    return { schema, items: (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n };
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("the database in this backup could not be read");
  } finally {
    db.close();
  }
}

// ── settings.env ──────────────────────────────────────────────────────────────

/**
 * The settings file for a backup. Default: only keys the settings page knows, minus every
 * secret (flagged ones, and anything named like a key, token, secret, password or credential),
 * so chat-bot tokens and the share key never leave. `secrets` keeps the file as it is.
 */
export function settingsForBackup(file: string, secrets: boolean): string {
  if (!existsSync(file)) return "";
  const raw = readFileSync(file, "utf8");
  if (secrets) return raw;
  let parsed: Record<string, string | undefined> = {};
  try { parsed = parseEnv(raw); } catch { return ""; }
  const known = new Set(SETTINGS.map((s) => s.key));
  const lines = Object.entries(parsed)
    .filter(([k, v]) => v !== undefined && known.has(k) && !isSecretSetting(k) && !v.includes("`"))
    .map(([k, v]) => `${k}=${serialize(v!)}`);
  return lines.length ? `# driftnet settings (secrets removed)\n${lines.join("\n")}\n` : "";
}

// ── Writing a zip (streamed, deflated) ────────────────────────────────────────

type Source = { name: string; data: Buffer } | { name: string; file: string };

function u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

/**
 * Yields the zip piece by piece: a file is read, deflated and written through, never held whole.
 * Sizes follow each entry in a data descriptor, and the central directory at the end has them all.
 */
export async function* zipStream(sources: Source[], now = new Date()): AsyncGenerator<Buffer> {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const central: Buffer[] = [];
  let offset = 0;
  const emit = (b: Buffer) => { offset += b.length; return b; };
  for (const s of sources) {
    const name = Buffer.from(s.name, "utf8");
    const start = offset;
    yield emit(Buffer.concat([u32(0x04034b50), u16(20), u16(0x0808), u16(8), u16(time), u16(date), u32(0), u32(0), u32(0), u16(name.length), u16(0), name]));
    let crc = 0, usize = 0, csize = 0;
    if ("data" in s) {
      crc = crc32(s.data); usize = s.data.length;
      const z = deflateRawSync(s.data);
      csize = z.length;
      yield emit(z);
    } else {
      const deflate = createDeflateRaw();
      const src = createReadStream(s.file);
      src.on("data", (c) => { crc = crc32(c as Buffer, crc); usize += (c as Buffer).length; });
      src.on("error", (e) => deflate.destroy(e));
      src.pipe(deflate);
      for await (const chunk of deflate) { csize += (chunk as Buffer).length; yield emit(chunk as Buffer); }
    }
    if (usize > 0xfffffffe || csize > 0xfffffffe || offset > 0xfffffffe) throw new BackupError("backup is larger than a plain zip can hold (4 GB)");
    yield emit(Buffer.concat([u32(0x08074b50), u32(crc), u32(csize), u32(usize)]));
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(8), u16(time), u16(date), u32(crc), u32(csize), u32(usize),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(start), name,
    ]));
  }
  const dir = Buffer.concat(central);
  yield Buffer.concat([dir, u32(0x06054b50), u16(0), u16(0), u16(sources.length), u16(sources.length), u32(dir.length), u32(offset), u16(0)]);
}

export interface BackupOptions { dbPath: string; envFile: string; version: string; secrets: boolean; now?: Date }
export interface BuiltBackup { manifest: Manifest; stream: () => AsyncGenerator<Buffer>; cleanup: () => void }

/** Snapshot now, stream later; `cleanup` removes the temp folder and must always be called. */
export function buildBackup(o: BackupOptions): BuiltBackup {
  const dir = workDir(o.dbPath, "backup");
  try {
    const snap = join(dir, "driftnet.db");
    snapshotTo(o.dbPath, snap);
    const { schema, items } = inspectCounts(snap);
    const manifest: Manifest = { format: BACKUP_FORMAT, driftnet: o.version, schema, created: (o.now ?? new Date()).toISOString(), items, secrets: o.secrets };
    const sources: Source[] = [
      { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n") },
      { name: "settings.env", data: Buffer.from(settingsForBackup(o.envFile, o.secrets)) },
      { name: "driftnet.db", file: snap },
    ];
    return { manifest, stream: () => zipStream(sources, o.now), cleanup: () => removeDir(dir) };
  } catch (err) {
    removeDir(dir);
    throw err;
  }
}

function inspectCounts(file: string): { schema: number; items: number } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return { schema: schemaVersion(db), items: (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n };
  } finally {
    db.close();
  }
}

/** Write a whole backup to a file (the CLI, with the server down or up). */
export async function writeBackupFile(o: BackupOptions, out: string): Promise<Manifest> {
  const b = buildBackup(o);
  try {
    await pipeline(b.stream, createWriteStream(out, { mode: 0o600 }));
    chmodSync(out, 0o600);
    return b.manifest;
  } finally {
    b.cleanup();
  }
}

// ── Reading a zip, defensively ────────────────────────────────────────────────

interface ZEntry { name: string; method: number; crc: number; csize: number; usize: number; offset: number }

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  if (len && readSync(fd, b, 0, len, pos) !== len) throw new BackupError("this is not a valid zip file");
  return b;
}

/** The central directory, checked: three known names at most, no folders, no paths, nothing encrypted or zip64. */
export function listZip(file: string): ZEntry[] {
  const size = statSync(file).size;
  if (size < 22) throw new BackupError("this is not a driftnet backup (not a zip file)");
  const fd = openSync(file, "r");
  try {
    const tailLen = Math.min(size, 22 + 0xffff);
    const tail = readAt(fd, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new BackupError("this is not a driftnet backup (not a zip file)");
    const count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (tail.readUInt16LE(e + 4) !== 0 || tail.readUInt16LE(e + 6) !== 0 || tail.readUInt16LE(e + 8) !== count) throw new BackupError("multi-part zips are not supported");
    if (count === 0 || count > ALLOWED.size) throw new BackupError("a driftnet backup holds exactly manifest.json, driftnet.db and settings.env");
    if (cdOff + cdSize > size || cdSize > 64 * 1024) throw new BackupError("this is not a valid zip file");
    const cd = readAt(fd, cdOff, cdSize);
    const out: ZEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new BackupError("this is not a valid zip file");
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), offset = cd.readUInt32LE(p + 42);
      if (p + 46 + nl > cd.length) throw new BackupError("this is not a valid zip file");
      const name = cd.subarray(p + 46, p + 46 + nl).toString("utf8");
      p += 46 + nl + xl + cl;
      // Names first: a traversal attempt gets the clearest message.
      if (/(^|[\\/])\.\.([\\/]|$)/.test(name) || /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name) || name.includes("\0")) throw new BackupError(`unsafe path in the zip: ${JSON.stringify(name.slice(0, 60))}`);
      if (!ALLOWED.has(name)) throw new BackupError(`unexpected file in the backup: ${JSON.stringify(name.slice(0, 60))}`);
      if (out.some((x) => x.name === name)) throw new BackupError(`${name} appears twice in the zip`);
      if (flags & 1) throw new BackupError("encrypted zips are not supported");
      if (method !== 0 && method !== 8) throw new BackupError("unsupported compression in the zip");
      if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new BackupError("zip64 files are not supported");
      out.push({ name, method, crc, csize, usize, offset });
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

/** Unpack one entry to `dest`, never writing more than it declared (or `max`), and check its CRC. */
async function extract(file: string, e: ZEntry, dest: string, max: number): Promise<void> {
  if (e.usize > max) throw new BackupError(`${e.name} is larger than a driftnet backup can be`);
  const fd = openSync(file, "r");
  let start: number;
  try {
    const h = readAt(fd, e.offset, 30);
    if (h.readUInt32LE(0) !== 0x04034b50) throw new BackupError("this is not a valid zip file");
    const nl = h.readUInt16LE(26), xl = h.readUInt16LE(28);
    if (readAt(fd, e.offset + 30, nl).toString("utf8") !== e.name) throw new BackupError("this is not a valid zip file");
    start = e.offset + 30 + nl + xl;
  } finally {
    closeSync(fd);
  }
  if (e.csize === 0) {
    if (e.usize !== 0 || e.crc !== 0) throw new BackupError(`${e.name} in the zip is damaged`);
    writeFileSync(dest, "", { mode: 0o600 });
    return;
  }
  if (start + e.csize > statSync(file).size) throw new BackupError("this is not a valid zip file");
  let n = 0, crc = 0;
  const guard = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > e.usize) return cb(new BackupError(`${e.name} is bigger than the zip says`));
      crc = crc32(chunk, crc);
      cb(null, chunk);
    },
  });
  try {
    const src = createReadStream(file, { start, end: start + e.csize - 1 });
    if (e.method === 8) await pipeline(src, createInflateRaw(), guard, createWriteStream(dest, { mode: 0o600 }));
    else await pipeline(src, guard, createWriteStream(dest, { mode: 0o600 }));
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(`${e.name} in the zip is damaged`);
  }
  if (n !== e.usize || (crc >>> 0) !== e.crc) throw new BackupError(`${e.name} in the zip is damaged (checksum mismatch)`);
}

export interface Checked { manifest: Manifest; db: string; settings: string; schema: number; items: number }

/** Validate a backup zip, unpacking into `dir`. Throws BackupError with a plain reason; nothing outside `dir` is touched. */
export async function checkBackupZip(zipFile: string, dir: string): Promise<Checked> {
  const entries = listZip(zipFile);
  const get = (n: string) => entries.find((e) => e.name === n);
  const [m, d, s] = [get("manifest.json"), get("driftnet.db"), get("settings.env")];
  if (!m || !d) throw new BackupError("this is not a driftnet backup (manifest.json or driftnet.db is missing)");
  const mf = join(dir, "manifest.json"), db = join(dir, "driftnet.db"), sf = join(dir, "settings.env");
  await extract(zipFile, m, mf, TEXT_MAX_BYTES);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
  } catch {
    throw new BackupError("manifest.json is not valid JSON");
  }
  if (manifest?.format !== BACKUP_FORMAT || !Number.isInteger(manifest.schema) || typeof manifest.driftnet !== "string") throw new BackupError("this is not a driftnet backup (the manifest does not say so)");
  if (manifest.schema > SCHEMA_LATEST) throw new BackupError(`this backup was made by a newer driftnet (schema ${manifest.schema}); upgrade driftnet first (this version knows schema ${SCHEMA_LATEST})`);
  await extract(zipFile, d, db, DB_MAX_BYTES);
  const { schema, items } = inspectDb(db);
  if (schema !== manifest.schema) throw new BackupError("the manifest does not match the database");
  let settings = "";
  if (s) { await extract(zipFile, s, sf, TEXT_MAX_BYTES); settings = readFileSync(sf, "utf8"); }
  return { manifest, db, settings, schema, items };
}

// ── Restore: stage now, swap at the next start ────────────────────────────────

export const pendingPath = (dbPath: string) => `${dbPath}.restore-pending`;
export const restorePending = (dbPath: string) => existsSync(pendingPath(dbPath));

/** Validate the zip and stage its database as `<db>.restore-pending`. Nothing live changes. */
export async function stageRestore(zipFile: string, dbPath: string): Promise<Checked> {
  if (dbPath === ":memory:") throw new BackupError("this driftnet keeps its data in memory; there is nothing to restore into");
  const dir = workDir(dbPath, "restore");
  try {
    const checked = await checkBackupZip(zipFile, dir);
    const target = pendingPath(dbPath);
    renameSync(checked.db, `${target}.part`);
    renameSync(`${target}.part`, target); // atomic: a half-written pending file is never seen at start
    chmodSync(target, 0o600);
    return checked;
  } finally {
    removeDir(dir);
  }
}

/**
 * Call before the store opens. If a staged restore exists and still validates, keep the
 * current database as `<db>.before-restore-<timestamp>` and move the staged one into place.
 * A staged file that fails validation is set aside (`.restore-rejected-…`) and the start goes on.
 */
export function applyPendingRestore(dbPath: string, log: (m: string) => void = console.log): { before?: string } | null {
  const pending = pendingPath(dbPath);
  if (dbPath === ":memory:" || !existsSync(pending)) return null;
  const ts = stamp();
  try {
    inspectDb(pending);
  } catch (err) {
    const aside = `${dbPath}.restore-rejected-${ts}`;
    renameSync(pending, aside);
    log(`[restore] the staged restore was not valid (${(err as Error).message}); kept as ${aside}, starting with the current database`);
    return null;
  }
  let before: string | undefined;
  if (existsSync(dbPath)) {
    before = `${dbPath}.before-restore-${ts}`;
    try {
      const live = new DatabaseSync(dbPath, { readOnly: true });
      try { live.exec(`VACUUM INTO '${quote(before)}'`); } finally { live.close(); }
      chmodSync(before, 0o600);
    } catch {
      // The live file can't be read as a database: keep its bytes as they are (with their WAL) instead.
      for (const sfx of ["", "-wal", "-shm"]) if (existsSync(dbPath + sfx)) copyFileSync(dbPath + sfx, before + sfx);
    }
    for (const sfx of ["-wal", "-shm", ""]) if (existsSync(dbPath + sfx)) unlinkSync(dbPath + sfx);
  }
  renameSync(pending, dbPath);
  log(`[restore] restored the database from a backup${before ? `; the previous one is kept as ${before}` : ""}`);
  return before ? { before } : {};
}

/** Used by the CLI to read a backup's secrets-free settings for display. */
export const settingKeys = (text: string): string[] => { try { return Object.keys(parseEnv(text)); } catch { return []; } };
