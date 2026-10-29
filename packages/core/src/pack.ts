import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { guard } from "./guard.ts";
import type { Store } from "./store.ts";
import { WORTH, type Kind, type MediaRef, type Worth } from "./types.ts";
import { canonicalize } from "./url.ts";
import { normalizeMedia } from "./media.ts";

/**
 * A folder pack: one folder (with its sub-folders) and the cards in it, as a single JSON file
 * somebody else can pull into their own catalogue. A pack holds what a stranger may read: the
 * summaries and the links. It never holds the reader's notes, chat text, who shared or voted,
 * counters, tokens or keys, internal ids, the trash, or anything the pollution guard flagged.
 */
export const PACK_VERSION = 1;
export const PACK_MAX_ITEMS = 1000;
export const PACK_MAX_BYTES = 2_000_000;

export class PackError extends Error {}

const KINDS: readonly Kind[] = ["repo", "product", "video", "article", "post", "other"];

export interface PackFolder { name: string; description: string; children: PackFolder[] }
export interface PackItem {
  url: string;
  name: string;
  one_liner: string;
  highlights: string[];
  tags: string[];
  kind: Kind;
  worth: Worth;
  /** Sub-folders below the pack's folder, outermost first; empty: directly in it. */
  folder: string[];
  demo?: string;
  why?: string;
  try_it?: string;
  /** Original picture URLs (never proxy paths). */
  media?: { url: string; kind: MediaRef["kind"]; alt: string }[];
}
export interface Pack {
  driftnet_pack: 1;
  name: string;
  description: string;
  author?: string;
  created: string;
  folders: PackFolder;
  items: PackItem[];
}

// ---------- export ----------

export interface BuildOptions {
  name?: string;
  description?: string;
  author?: string;
  /** A folder's display name (built-in folders have none stored). */
  label: (folderId: string) => string;
}

const clip = (s: unknown, n: number): string => (typeof s === "string" ? s.trim().slice(0, n) : "");

/** The pack for a folder and everything below it; throws PackError when it is over the size cap. */
export function buildPack(store: Store, folderId: string, opts: BuildOptions): Pack {
  const all = store.folders();
  const root = all.find((f) => f.id === folderId);
  if (!root) throw new PackError("no such folder");
  const paths = new Map<string, string[]>();
  const tree = (id: string, path: string[]): PackFolder => {
    const f = all.find((x) => x.id === id)!;
    paths.set(id, path);
    return {
      name: opts.label(id), description: f.description,
      children: all.filter((c) => c.parent === id).map((c) => tree(c.id, [...path, opts.label(c.id)])),
    };
  };
  const folders = tree(folderId, []);
  // exportable() already leaves out the trash and anything flagged as an injection.
  const items: PackItem[] = [];
  for (const i of store.exportable()) {
    const path = paths.get(i.category);
    if (!path) continue;
    const s = i.summary;
    const media = (i.media ?? []).map((m) => ({ url: m.url, kind: m.kind, alt: m.alt }));
    items.push({
      url: s?.primaryUrl || i.url,
      name: s?.name || i.title, one_liner: s?.oneLiner ?? "", highlights: s?.highlights ?? [], tags: s?.tags ?? [],
      kind: i.kind, worth: i.worth, folder: path,
      ...(s?.demo ? { demo: s.demo } : {}), ...(s?.why ? { why: s.why } : {}), ...(s?.tryIt ? { try_it: s.tryIt } : {}),
      ...(media.length ? { media } : {}),
    });
    if (items.length > PACK_MAX_ITEMS) throw new PackError(`a pack holds at most ${PACK_MAX_ITEMS} cards; this folder has more`);
  }
  const author = clip(opts.author, 80);
  const pack: Pack = {
    driftnet_pack: PACK_VERSION,
    name: clip(opts.name, 60) || folders.name,
    description: clip(opts.description, 300) || folders.description,
    ...(author ? { author } : {}),
    created: new Date().toISOString(),
    folders, items,
  };
  if (Buffer.byteLength(JSON.stringify(pack)) > PACK_MAX_BYTES) throw new PackError("this folder is too big to share as a pack (2 MB)");
  return pack;
}

/** A file name that is safe in a Content-Disposition header (plain ASCII) and on every file system. */
export function packFileName(name: string): string {
  const base = name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || "folder"}.driftnet-pack.json`;
}

/** The full Content-Disposition value: the ASCII name for old clients, the real name (any script) as filename*. */
export function packDisposition(name: string): string {
  const real = `${name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|\s]+/g, " ").trim().slice(0, 60) || "folder"}.driftnet-pack.json`;
  return `attachment; filename="${packFileName(name)}"; filename*=UTF-8''${encodeURIComponent(real).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

// ---------- signed links ----------

/**
 * A signed link opens one pack and nothing else, without the share key (like a media path opens one picture).
 * The secret is made once and kept in the catalogue's own state.
 */
function secretOf(store: Store): string {
  let s = store.getState("pack_secret");
  if (!s) { s = randomBytes(32).toString("base64url"); store.setState("pack_secret", s); }
  return s;
}
const sign = (store: Store, folderId: string) => createHmac("sha256", secretOf(store)).update(`pack/${folderId}`).digest("base64url").slice(0, 27);
export const signPack = sign;
export function packSigOk(store: Store, folderId: string, sig: string | null): boolean {
  if (!sig) return false;
  const want = Buffer.from(sign(store, folderId)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ---------- import: parse and validate ----------

export interface ParsedPack {
  pack: Pack;
  /** Cards left out: not a valid link, flagged by the guard, over a field limit that makes no sense. */
  skipped: number;
}

export const isPackJson = (data: unknown): boolean =>
  !!data && typeof data === "object" && !Array.isArray(data) && "driftnet_pack" in (data as object);

function texts(s: unknown, n: number, flags: string[]): string {
  const g = guard(clip(s, n));
  flags.push(...g.flags.filter((f) => f === "injection"));
  return g.text.trim();
}
function list(v: unknown, count: number, n: number, flags: string[]): string[] {
  return Array.isArray(v) ? v.map((x) => texts(x, n, flags)).filter(Boolean).slice(0, count) : [];
}

function folderTree(raw: unknown, depth: number, budget: { n: number }, flags: string[]): PackFolder {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = texts(o.name, 60, flags);
  if (!name) throw new PackError("a folder in the pack has no name");
  const children: PackFolder[] = [];
  if (Array.isArray(o.children) && depth < 6) {
    for (const c of o.children) {
      if (++budget.n > 200) throw new PackError("the pack has too many folders");
      children.push(folderTree(c, depth + 1, budget, flags));
    }
  }
  return { name, description: texts(o.description, 300, flags), children };
}

/**
 * Read a pack from its JSON text (or an already-parsed object), checking every field. Throws PackError when
 * the whole thing is unusable; a single bad card is left out and counted instead.
 */
export function parsePack(src: string | unknown): ParsedPack {
  let data: unknown = src;
  if (typeof src === "string") {
    if (Buffer.byteLength(src) > PACK_MAX_BYTES) throw new PackError("this pack is over 2 MB");
    try { data = JSON.parse(src); } catch { throw new PackError("not a driftnet pack: the file is not valid JSON"); }
  }
  if (!isPackJson(data)) throw new PackError("not a driftnet pack");
  const o = data as Record<string, unknown>;
  if (o.driftnet_pack !== PACK_VERSION) throw new PackError(`unsupported pack version ${String(o.driftnet_pack)}`);
  if (!Array.isArray(o.items)) throw new PackError("the pack has no items list");
  if (o.items.length > PACK_MAX_ITEMS) throw new PackError(`a pack holds at most ${PACK_MAX_ITEMS} cards`);

  // Text that is addressed to a model refuses the whole pack when it sits in the pack's own header or folder names.
  const headerFlags: string[] = [];
  const tree = folderTree(o.folders ?? { name: o.name }, 0, { n: 0 }, headerFlags);
  const name = texts(o.name, 60, headerFlags) || tree.name;
  const description = texts(o.description, 300, headerFlags) || tree.description;
  const author = texts(o.author, 80, headerFlags);
  if (headerFlags.length) throw new PackError("the pack's name or folders contain text that looks like instructions to an AI; refusing it");
  const created = typeof o.created === "string" && !Number.isNaN(Date.parse(o.created)) ? new Date(o.created).toISOString() : new Date(0).toISOString();

  const items: PackItem[] = [];
  let skipped = 0;
  for (const raw of o.items) {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const url = typeof r.url === "string" && r.url.length <= 2000 && /^https?:\/\//i.test(r.url.trim()) ? canonicalize(r.url.trim()) : null;
    const flags: string[] = [];
    const itemName = texts(r.name, 200, flags);
    if (!url || !itemName) { skipped++; continue; }
    const folderPath = Array.isArray(r.folder) ? r.folder.map((x) => texts(x, 60, flags)).filter(Boolean).slice(0, 8) : [];
    const item: PackItem = {
      url, name: itemName,
      one_liner: texts(r.one_liner, 400, flags),
      highlights: list(r.highlights, 8, 300, flags),
      tags: list(r.tags, 10, 40, flags),
      kind: KINDS.includes(r.kind as Kind) ? (r.kind as Kind) : "other",
      worth: WORTH.includes(r.worth as Worth) ? (r.worth as Worth) : "normal",
      folder: folderPath,
    };
    const demo = texts(r.demo, 600, flags), why = texts(r.why, 600, flags), tryIt = texts(r.try_it, 600, flags);
    if (demo) item.demo = demo;
    if (why) item.why = why;
    if (tryIt) item.try_it = tryIt;
    const media = normalizeMedia(r.media).map((m) => ({ url: m.url, kind: m.kind, alt: texts(m.alt, 200, flags) }));
    if (media.length) item.media = media;
    // One flagged text field drops the whole card.
    if (flags.length) { skipped++; continue; }
    items.push(item);
  }
  return { pack: { driftnet_pack: PACK_VERSION, name, description, ...(author ? { author } : {}), created, folders: tree, items }, skipped };
}
