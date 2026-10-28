import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeFetch } from "@driftnet/core";

/**
 * Picture proxy: the page never hotlinks a third-party image. Bytes come through
 * the SSRF-safe fetcher, are checked (type, size, magic bytes) and cached on disk.
 * SVG is refused on purpose: it can carry script.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

export class MediaError extends Error {
  constructor(readonly status: 404 | 502, message: string) { super(message); }
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

/** The image behind `url`: from the disk cache, or fetched once (concurrent requests share one fetch). */
export function loadMedia(dir: string, url: string, opts: { blockDomains?: string; capBytes?: number } = {}): Promise<MediaFile> {
  if (!/^https?:\/\//i.test(url)) return Promise.reject(new MediaError(502, "not an http(s) link"));
  if (blockedHost(url, opts.blockDomains)) return Promise.reject(new MediaError(502, "host is blocked in your settings"));
  const key = createHash("sha256").update(url).digest("hex");
  const file = join(dir, key);
  try {
    const bytes = readFileSync(file);
    const type = sniffImage(bytes);
    if (type) {
      const now = new Date();
      try { utimesSync(file, now, now); } catch { /* eviction order only */ }
      return Promise.resolve({ bytes, type });
    }
  } catch { /* not cached */ }
  let work = inflight.get(key);
  if (!work) {
    work = fetchImage(url).then((m) => {
      store(dir, file, m.bytes, opts.capBytes ?? cacheCap());
      return m;
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
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) { await reader.cancel(); throw new MediaError(502, "image is too large"); }
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    throw err instanceof MediaError ? err : new MediaError(502, (err as Error).message);
  }
  const bytes = Buffer.concat(chunks);
  const real = sniffImage(bytes);
  if (!real) throw new MediaError(502, "the bytes are not an image");
  return { bytes, type: real };
}

/** Write atomically, then drop the oldest files until the folder fits the cap. */
function store(dir: string, file: string, bytes: Buffer, cap: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, file);
    const files = readdirSync(dir).filter((f) => !f.endsWith(".tmp")).map((f) => ({ f, ...pick(statSync(join(dir, f))) }));
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total <= cap) break;
      if (join(dir, x.f) === file) continue;
      try { unlinkSync(join(dir, x.f)); total -= x.size; } catch { /* already gone */ }
    }
  } catch (err) {
    console.warn(`[driftnet] media cache: ${(err as Error).message}`); // serving still works without the cache
  }
}

const pick = (s: { size: number; mtimeMs: number }) => ({ size: s.size, mtime: s.mtimeMs });
