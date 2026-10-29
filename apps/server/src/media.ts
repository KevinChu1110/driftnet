import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { safeFetch } from "@driftnet/core";

/**
 * Picture proxy: the page never hotlinks a third-party image. Bytes come through
 * the SSRF-safe fetcher, are checked (type, size, magic bytes) and cached on disk.
 * SVG is refused on purpose: it can carry script.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_UPSTREAM = 4; // simultaneous upstream fetches, across all callers
const QUEUE_WAIT_MS = 10_000;
const FAIL_TTL_MS = 10 * 60_000;
const TOUCH_AFTER_MS = 24 * 3600_000;
const EVICT_TO = 0.9; // evict down to this share of the cap, so the next image doesn't trigger another sweep
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export class MediaError extends Error {
  constructor(readonly status: 404 | 502 | 503, message: string) { super(message); }
}

export interface MediaFile { bytes: Buffer; type: string }

/** What the bytes really are, whatever the server claimed. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp" && /^avi[fs]$/.test(b.subarray(8, 12).toString("latin1"))) return "image/avif";
  return null;
}

export function blockedHost(url: string, blockList: string | undefined): boolean {
  const host = URL.canParse(url) ? new URL(url).hostname.toLowerCase() : "";
  return (blockList ?? "").split(/[\s,]+/).map((d) => d.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean)
    .some((d) => host === d || host.endsWith(`.${d}`));
}

const inflight = new Map<string, Promise<MediaFile>>();
/** URLs that failed lately, by cache path: answered 502 at once instead of hitting the upstream again. */
const failed = new Map<string, { until: number; message: string }>();

let active = 0;
const waiting: (() => void)[] = [];
/** Take one of the upstream slots, or give up (503) after QUEUE_WAIT_MS in the queue. */
async function acquire(): Promise<void> {
  if (active < MAX_UPSTREAM) { active++; return; }
  await new Promise<void>((resolve, reject) => {
    const wake = () => { clearTimeout(timer); resolve(); }; // the releaser passes its slot on
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(wake), 1);
      reject(new MediaError(503, "too many pictures loading, try again shortly"));
    }, QUEUE_WAIT_MS);
    waiting.push(wake);
  });
}
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };

async function fetchLimited(url: string): Promise<MediaFile> {
  await acquire();
  try { return await fetchImage(url); } finally { release(); }
}

/** The image behind `url`: from the disk cache, or fetched once (concurrent requests share one fetch). */
export async function loadMedia(dir: string, url: string, opts: { blockDomains?: string; capBytes?: number } = {}): Promise<MediaFile> {
  if (!/^https?:\/\//i.test(url)) throw new MediaError(502, "not an http(s) link");
  if (blockedHost(url, opts.blockDomains)) throw new MediaError(502, "host is blocked in your settings");
  const key = createHash("sha256").update(url).digest("hex");
  const file = join(dir, key);
  try {
    const bytes = await readFile(file);
    const type = sniffImage(bytes);
    if (type) {
      // Keeps eviction order roughly right without a write on every hit.
      try {
        const { mtimeMs } = await stat(file);
        if (Date.now() - mtimeMs > TOUCH_AFTER_MS) { const now = new Date(); await utimes(file, now, now); }
      } catch { /* eviction order only */ }
      return { bytes, type };
    }
  } catch { /* not cached */ }
  const bad = failed.get(file);
  if (bad) {
    if (bad.until > Date.now()) throw new MediaError(502, bad.message);
    failed.delete(file);
  }
  let work = inflight.get(key);
  if (!work) {
    work = fetchLimited(url).then((m) => {
      store(dir, file, m.bytes, opts.capBytes ?? cacheCap());
      return m;
    }).catch((err) => {
      if (err instanceof MediaError && err.status === 502) {
        if (failed.size > 1000) for (const [k, v] of failed) if (v.until <= Date.now()) failed.delete(k);
        failed.set(file, { until: Date.now() + FAIL_TTL_MS, message: err.message });
      }
      throw err;
    }).finally(() => inflight.delete(key));
    inflight.set(key, work);
  }
  return work;
}

const cacheCap = () => Math.max(1, Number(process.env.DRIFTNET_MEDIA_CACHE_MB) || 300) * 1024 * 1024;

async function fetchImage(url: string): Promise<MediaFile> {
  let res: Response;
  try {
    res = await safeFetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; driftnet/0.1)", accept: "image/png,image/jpeg,image/gif,image/webp,image/avif" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MediaError(502, (err as Error).message);
  }
  const reject = async (msg: string): Promise<never> => { await res.body?.cancel().catch(() => {}); throw new MediaError(502, msg); };
  if (res.status !== 200) return reject(`upstream answered ${res.status}`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ALLOWED.has(type)) return reject(`not an accepted image type (${type || "none"})`);
  if (Number(res.headers.get("content-length")) > MAX_IMAGE_BYTES) return reject("image is too large");
  // Fill one buffer as the chunks arrive (sized from content-length when it is honest) instead of concatenating at the end.
  const declared = Number(res.headers.get("content-length"));
  let buf = Buffer.allocUnsafe(declared > 0 && declared <= MAX_IMAGE_BYTES ? declared : 64 * 1024);
  let size = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_IMAGE_BYTES) { await reader.cancel(); throw new MediaError(502, "image is too large"); }
      if (size + value.byteLength > buf.length) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_IMAGE_BYTES, Math.max(buf.length * 2, size + value.byteLength)));
        buf.copy(grown, 0, 0, size);
        buf = grown;
      }
      buf.set(value, size);
      size += value.byteLength;
    }
  } catch (err) {
    throw err instanceof MediaError ? err : new MediaError(502, (err as Error).message);
  }
  const bytes = buf.subarray(0, size);
  const real = sniffImage(bytes);
  if (!real) throw new MediaError(502, "the bytes are not an image");
  return { bytes, type: real };
}

/** Bytes in each cache folder: counted once from disk, then kept up to date, so a new picture doesn't rescan the folder. */
const cacheTotals = new Map<string, number>();

/** Write atomically, then (only once over the cap) drop the oldest files until the folder is down to ~90% of it. */
function store(dir: string, file: string, bytes: Buffer, cap: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
    const known = cacheTotals.get(dir);
    let total = known === undefined ? scan(dir).reduce((n, x) => n + x.size, 0) : known + bytes.length;
    if (total > cap) {
      const files = scan(dir);
      total = files.reduce((n, x) => n + x.size, 0);
      const target = cap * EVICT_TO;
      for (const x of files.sort((a, b) => a.mtime - b.mtime)) {
        if (total <= target) break;
        if (join(dir, x.f) === file) continue;
        try { unlinkSync(join(dir, x.f)); total -= x.size; } catch { /* already gone */ }
      }
    }
    cacheTotals.set(dir, total);
  } catch (err) {
    console.warn(`[driftnet] media cache: ${(err as Error).message}`); // serving still works without the cache
  }
}

const pick = (s: { size: number; mtimeMs: number }) => ({ size: s.size, mtime: s.mtimeMs });
const scan = (dir: string) => readdirSync(dir).filter((f) => !f.endsWith(".tmp")).map((f) => ({ f, ...pick(statSync(join(dir, f))) }));
