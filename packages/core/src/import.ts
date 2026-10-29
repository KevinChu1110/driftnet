import { isIP } from "node:net";
import { isPublicAddress } from "./extractors/net.ts";
import { isPackJson, parsePack, type PackFolder, type PackItem, type ParsedPack } from "./pack.ts";
import type { Pipeline } from "./pipeline.ts";
import { FolderError, type Store } from "./store.ts";
import { canonicalize, extractUrls } from "./url.ts";

/**
 * Bring bookmarks in from other tools. Small hand-written parsers, no dependencies:
 * a browser's bookmarks file (Netscape HTML), Pocket (HTML or CSV), Raindrop (CSV),
 * a JSON list like the one `GET /api/items` returns, or any text with links in it.
 */
export type ImportFormat = "html" | "pocket" | "raindrop" | "json" | "text" | "pack";
export const IMPORT_FORMATS: readonly ImportFormat[] = ["html", "pocket", "raindrop", "json", "text", "pack"];
/** Most links one import takes; the rest are left out and reported. */
export const IMPORT_CAP = 5000;

export interface ImportEntry {
  url: string;
  title?: string;
  note?: string;
  /** The bookmark folders it sat in, outermost first. */
  folderPath?: string[];
  /** ISO time the bookmark was made (read from the file; the catalogue stamps its own). */
  addedAt?: string;
  /** A card from a folder pack: already summarised, so it is stored as given and no model is called. */
  pack?: PackItem;
}

// ---------- small helpers ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const text = (html: string) => decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
const clean = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s.trim() : undefined);

/** Seconds (or milliseconds) since 1970, or any date string → ISO; undefined if it isn't a date. */
function isoTime(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  let d: Date;
  if (typeof v === "number" || /^\d{9,13}$/.test(String(v).trim())) {
    const n = Number(v);
    d = new Date(n < 1e11 ? n * 1000 : n);
  } else d = new Date(String(v));
  return Number.isNaN(d.getTime()) || d.getFullYear() < 1990 || d.getFullYear() > 2100 ? undefined : d.toISOString();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

/** The browser's own top-level folders say nothing about where the reader put a bookmark. */
const ROOT_FOLDER = /^(bookmarks( bar| menu| toolbar)?|favorites( bar)?|other bookmarks|mobile bookmarks|書籤列|書籤選單|書籤工具列|其他書籤|我的最愛)$/i;

// ---------- Netscape bookmarks / Pocket HTML ----------

export function parseHtml(html: string): ImportEntry[] {
  const out: ImportEntry[] = [];
  const stack: (string | null)[] = [];
  let pending: string | null = null;
  let last: ImportEntry | undefined;
  const re = /<(\/?)(dl|ul|h3|a|dd)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const close = m[1] === "/";
    const tag = m[2]!.toLowerCase();
    if (tag === "dl" || tag === "ul") {
      if (close) stack.pop();
      else { stack.push(pending); pending = null; }
    } else if (tag === "h3") {
      if (close) continue;
      const end = html.slice(re.lastIndex).search(/<\/h3>/i);
      const name = text(html.slice(re.lastIndex, end < 0 ? re.lastIndex : re.lastIndex + end));
      pending = name || null;
    } else if (tag === "a") {
      if (close) continue;
      const a = attrs(m[3]!);
      const end = html.slice(re.lastIndex).search(/<\/a>/i);
      const title = text(html.slice(re.lastIndex, end < 0 ? re.lastIndex : re.lastIndex + end));
      if (!a.href) continue;
      const folders = stack.filter((f): f is string => !!f);
      if (folders.length && ROOT_FOLDER.test(folders[0]!)) folders.shift();
      last = {
        url: a.href,
        ...(title ? { title } : {}),
        ...(folders.length ? { folderPath: folders } : {}),
        ...(isoTime(a.add_date ?? a.time_added) ? { addedAt: isoTime(a.add_date ?? a.time_added)! } : {}),
      };
      out.push(last);
    } else if (tag === "dd" && !close && last) {
      // Netscape: the description of the bookmark just above.
      const rest = html.slice(re.lastIndex);
      const end = rest.search(/<(dt|\/dl|dd|h3)\b/i);
      const note = text(end < 0 ? rest : rest.slice(0, end));
      if (note) last.note = note;
    }
  }
  return out;
}

// ---------- CSV ----------

/** RFC 4180-ish: quoted fields may hold commas, doubled quotes and line breaks; CRLF or LF; a leading BOM is ignored. */
export function parseCsv(src: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = src.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** Pocket (title,url,time_added,tags,status) and Raindrop (id,title,note,excerpt,url,folder,tags,created,…): columns are found by name. */
export function parseCsvBookmarks(src: string): ImportEntry[] {
  const [head, ...rows] = parseCsv(src);
  if (!head) return [];
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const iUrl = col("url", "link", "href");
  if (iUrl < 0) return [];
  const iTitle = col("title", "name");
  const iNote = col("note", "notes");
  const iFolder = col("folder", "collection");
  const iTime = col("time_added", "created", "date", "added");
  const out: ImportEntry[] = [];
  for (const r of rows) {
    const url = clean(r[iUrl]);
    if (!url) continue;
    const title = iTitle >= 0 ? clean(r[iTitle]) : undefined;
    const note = iNote >= 0 ? clean(r[iNote]) : undefined;
    const folder = iFolder >= 0 ? clean(r[iFolder]) : undefined;
    const at = iTime >= 0 ? isoTime(r[iTime]?.trim()) : undefined;
    out.push({ url, ...(title ? { title } : {}), ...(note ? { note } : {}), ...(folder ? { folderPath: [folder] } : {}), ...(at ? { addedAt: at } : {}) });
  }
  return out;
}

// ---------- JSON ----------

/** A list of objects, or `{ items: [...] }`: the shape the items API and exports use. A folder is `folderPath: []`, or `folder` / `path` as "A › B" or "A/B". */
export function parseJson(src: string): ImportEntry[] {
  let data: unknown;
  try { data = JSON.parse(src); } catch { return []; }
  const list = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : [];
  const out: ImportEntry[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const url = clean(o.url);
    if (!url) continue;
    const summary = o.summary && typeof o.summary === "object" ? (o.summary as { name?: unknown }) : undefined;
    const title = clean(o.title) ?? clean(summary?.name);
    const note = clean(o.note);
    const fp = Array.isArray(o.folderPath) ? o.folderPath.map(clean).filter((x): x is string => !!x)
      : (clean(o.folder) ?? clean(o.path))?.split(/\s*[›/>]\s*/).filter(Boolean) ?? [];
    const at = isoTime(o.addedAt ?? o.createdAt ?? o.created_at ?? o.added);
    out.push({ url, ...(title ? { title } : {}), ...(note ? { note } : {}), ...(fp.length ? { folderPath: fp } : {}), ...(at ? { addedAt: at } : {}) });
  }
  return out;
}

// ---------- plain text / Markdown ----------

export function parseText(src: string): ImportEntry[] {
  const titles = new Map<string, string>();
  for (const m of src.matchAll(/\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = canonicalize(m[2]!);
    if (url && !titles.has(url)) titles.set(url, m[1]!.trim());
  }
  return extractUrls(src).map((url) => ({ url, ...(titles.has(url) ? { title: titles.get(url)! } : {}) }));
}

// ---------- detection and the front door ----------

export function detectFormat(src: string): ImportFormat {
  const head = src.replace(/^﻿/, "").trimStart();
  if (/^[[{]/.test(head)) {
    try { return isPackJson(JSON.parse(head)) ? "pack" : "json"; } catch { /* maybe text that starts with a bracket */ }
  }
  if (/<(dt|a)\b[^>]*>/i.test(head.slice(0, 200_000)) && /<a\b[^>]*\bhref\s*=/i.test(head)) return /\btime_added\s*=/i.test(head) ? "pocket" : "html";
  const first = head.split(/\r?\n/, 1)[0]!.toLowerCase().split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  if (first.length > 1 && first.includes("url")) return first.includes("time_added") ? "pocket" : "raindrop";
  return "text";
}

export function parseImport(content: string, format: ImportFormat | "auto" = "auto"): { format: ImportFormat; entries: ImportEntry[]; pack?: ParsedPack } {
  const f = format === "auto" ? detectFormat(content) : format;
  if (f === "pack") {
    const pack = parsePack(content);
    return { format: f, pack, entries: pack.pack.items.map((p) => ({ url: p.url, title: p.name, folderPath: p.folder, pack: p })) };
  }
  const entries = f === "json" ? parseJson(content)
    : f === "html" ? parseHtml(content)
    : f === "text" ? parseText(content)
    // Pocket and Raindrop each come as CSV or (Pocket) HTML.
    : /<a\b[^>]*\bhref\s*=/i.test(content) ? parseHtml(content) : parseCsvBookmarks(content);
  return { format: f, entries };
}

// ---------- plan and run ----------

export interface ImportPlan {
  /** Links to ingest: canonical, unique, new to the catalogue. */
  entries: (ImportEntry & { url: string })[];
  /** Repeats inside the file, and links the catalogue already has. */
  duplicates: number;
  /** Not http(s), not a link, private or local addresses, or over the cap. */
  skipped: number;
  capped: boolean;
}

function privateHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return isIP(host) !== 0 && !isPublicAddress(host);
}

export function planImport(store: Pick<Store, "findByUrl">, parsed: ImportEntry[], cap = IMPORT_CAP): ImportPlan {
  const seen = new Set<string>();
  const entries: ImportPlan["entries"] = [];
  let duplicates = 0, skipped = 0, capped = false;
  for (const e of parsed) {
    const url = canonicalize(e.url);
    if (!url || privateHost(url)) { skipped++; continue; }
    if (seen.has(url)) { duplicates++; continue; }
    seen.add(url);
    if (store.findByUrl(url)) { duplicates++; continue; }
    if (entries.length >= cap) { skipped++; capped = true; continue; }
    entries.push({ ...e, url });
  }
  return { entries, duplicates, skipped, capped };
}

export interface ImportProgress {
  total: number;
  done: number;
  added: number;
  already: number;
  failed: number;
  /** The first 10 failures, as "url: reason". */
  errors: string[];
}

export const IMPORT_FOLDER = "Imported";

/** Finds or makes IMPORT_FOLDER › A › B, reusing a folder of that name under the same parent. */
export function importFolder(store: Store, path: string[]): string {
  let parent: string | null = null;
  for (const raw of [IMPORT_FOLDER, ...path]) {
    const name = raw.trim().slice(0, 60);
    if (!name || /^\.+$/.test(name)) continue;
    const found = store.folders().find((f) => (f.parent ?? null) === parent && f.name?.toLowerCase() === name.toLowerCase());
    try {
      parent = found?.id ?? store.createFolder({ name, parent }).id;
    } catch (err) {
      // A name the folder tree refuses (it clashes with a built-in shelf): file under what we have so far.
      if (!(err instanceof FolderError)) throw err;
      break;
    }
  }
  return parent ?? "other";
}

/** Ingest every entry two at a time. A link whose page can't be fetched still becomes an item; only a throw counts as failed. */
export async function runImport(
  dn: { pipeline: Pick<Pipeline, "ingest">; store: Store },
  entries: ImportEntry[],
  opts: { folders?: "keep" | "none" } = {},
  progress: ImportProgress = { total: entries.length, done: 0, added: 0, already: 0, failed: 0, errors: [] },
): Promise<ImportProgress> {
  const keep = opts.folders === "keep";
  const folderIds = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < entries.length; i = next++) {
      const e = entries[i]!;
      try {
        const note = [e.title, e.note].filter(Boolean).join(" — ").slice(0, 600);
        const r = await dn.pipeline.ingest(e.url, { platform: "import", chatId: "import", ...(note ? { note } : {}) });
        if (r.cached) progress.already++; else progress.added++;
        if (keep && e.folderPath?.length) {
          const key = e.folderPath.join("\u0000");
          let id = folderIds.get(key);
          if (!id) { id = importFolder(dn.store, e.folderPath); folderIds.set(key, id); }
          // The reader's own placement: automatic sorting leaves it alone.
          dn.store.moveItems([r.item.id], id, "import");
        }
      } catch (err) {
        progress.failed++;
        if (progress.errors.length < 10) progress.errors.push(`${e.url}: ${(err as Error).message}`.slice(0, 300));
      }
      progress.done++;
    }
  };
  await Promise.all([worker(), worker()]);
  return progress;
}

// ---------- folder packs ----------

/** Finds or makes a folder of this name under `parent` (case-insensitive), so importing a pack twice reuses its folders. */
function findOrMake(store: Store, parent: string | null, name: string, description: string): string | null {
  const found = store.folders().find((f) => (f.parent ?? null) === parent && f.name?.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  try {
    return store.createFolder({ name, description, parent }).id;
  } catch (err) {
    // A name the tree refuses (it clashes with a built-in shelf, e.g. "Other"): keep what we have so far.
    if (!(err instanceof FolderError)) throw err;
    return null;
  }
}

/**
 * Take a pack in: the folder tree under a top-level folder named after the pack (existing folders of the
 * same name are reused), the cards stored exactly as the pack summarised them. No page is fetched and no
 * model is called. A link the catalogue already has keeps its own summary; it is only filed into the pack's
 * folder if it was never filed anywhere by hand. Importing the same pack again changes nothing.
 */
export function runPackImport(store: Store, parsed: ParsedPack, progress: ImportProgress): ImportProgress {
  const { pack } = parsed;
  const ids = new Map<string, string>();
  const root = findOrMake(store, null, pack.name, pack.description) ?? "other";
  const walk = (f: PackFolder, parent: string, path: string[]) => {
    for (const c of f.children) {
      const id = findOrMake(store, parent, c.name, c.description) ?? parent;
      ids.set([...path, c.name].join("\u0000"), id);
      walk(c, id, [...path, c.name]);
    }
  };
  ids.set("", root);
  walk(pack.folders, root, []);
  const folderFor = (path: string[]): string => {
    // A path the tree doesn't list (hand-edited pack): make the folders it needs.
    let id = root;
    for (let i = 0; i < path.length; i++) {
      const key = path.slice(0, i + 1).join("\u0000");
      let next = ids.get(key);
      if (!next) { next = findOrMake(store, id, path[i]!, "") ?? id; ids.set(key, next); }
      id = next;
    }
    return id;
  };
  store.transaction(() => {
    for (const p of pack.items) {
      progress.done++;
      try {
        const url = canonicalize(p.url);
        if (!url || privateHost(url)) { progress.failed++; continue; }
        const folder = folderFor(p.folder);
        const existing = store.findByUrl(url);
        if (existing) {
          progress.already++;
          if (!existing.placed && !existing.trashedAt) store.moveItems([existing.id], folder, "pack");
          continue;
        }
        const hasSummary = !!(p.one_liner || p.highlights.length);
        const item = store.upsert({
          url, aliases: [], title: p.name,
          judgement: { isAiTool: 0.5, category: folder, kind: p.kind, worth: p.worth, engine: "pack", confidence: 1 },
          summary: hasSummary ? {
            name: p.name, oneLiner: p.one_liner, highlights: p.highlights, useCases: [], tags: p.tags,
            ...(p.demo ? { demo: p.demo } : {}), ...(p.why ? { why: p.why } : {}), ...(p.try_it ? { tryIt: p.try_it } : {}),
          } : null,
          flags: [], source: "pack",
          ...(p.media?.length ? { media: p.media } : {}),
        });
        store.moveItems([item.id], folder, "pack");
        progress.added++;
      } catch (err) {
        progress.failed++;
        if (progress.errors.length < 10) progress.errors.push(`${p.url}: ${(err as Error).message}`.slice(0, 300));
      }
    }
  });
  return progress;
}
