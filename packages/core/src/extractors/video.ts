import { spawn as nodeSpawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { estimateTokens } from "../digest.ts";
import type { Digest } from "../types.ts";
import { isPublicAddress } from "./net.ts";

/**
 * Video understanding for links whose page says almost nothing: reels, shorts and
 * TikToks usually name the tool only out loud or on screen. Everything runs on
 * local, optional tools (yt-dlp, ffmpeg, tesseract, whisper), cheapest first:
 *
 *   1. captions    yt-dlp, no download: subtitles, auto-captions, title, description
 *   2. on-screen   low-quality download (<= 60 MB, first 3 min), a frame every 2 s, OCR
 *   3. speech      only if still thin: 16 kHz audio -> whisper
 *
 * Shared links are untrusted, so the tools run like the CLI model providers do:
 * no shell (argument arrays), a private temp directory that is always deleted,
 * driftnet's secrets removed from the child environment, a hard timeout per step
 * that kills the whole process group, one video job at a time process-wide, and
 * private/local hosts refused before a URL reaches yt-dlp.
 */

export type VideoMode = "off" | "auto";

export const videoMode = (env: NodeJS.ProcessEnv = process.env): VideoMode =>
  env.DRIFTNET_VIDEO?.trim().toLowerCase() === "off" ? "off" : "auto";

// --- limits ------------------------------------------------------------------------------------

/** Page text below this many tokens (hashtags, mentions and links not counted) is "thin". */
export const THIN_TOKENS = 40;
/** Once page + video text reaches this, later (costlier) steps are skipped. */
export const ENOUGH_TOKENS = 120;
/** Characters of video text appended to the page text, labels included. */
export const SECTIONS_CAP = 6000;
export const MAX_BYTES = 60 * 1024 * 1024;
export const MAX_SECONDS = 180;
export const MAX_FRAMES = 40;
export const FRAME_EVERY_SECONDS = 2;
export const TIMEOUTS = { captions: 60_000, download: 90_000, frames: 30_000, ocr: 90_000, audio: 30_000, speech: 180_000 } as const;

// --- which items -------------------------------------------------------------------------------

const hostIs = (host: string, ...domains: string[]) => domains.some((d) => host === d || host.endsWith(`.${d}`));

/** Known video hosts and the link shapes on them that can be a video. Ordinary articles never match. */
export function isVideoUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (hostIs(host, "youtube.com")) return /^\/(shorts\/[\w-]+|watch|live\/[\w-]+)/.test(path);
  if (host === "youtu.be") return path.length > 1;
  if (hostIs(host, "instagram.com")) return /^\/(?:[\w.]+\/)?(reels?|p|tv)\/[\w-]+/.test(path);
  if (hostIs(host, "facebook.com")) return /^\/(reels?\/|watch|share\/(v|r)\/|.+\/videos\/|video\.php|videos\/)/.test(path);
  if (host === "fb.watch") return true;
  if (hostIs(host, "threads.net", "threads.com")) return /\/post\//.test(path);
  if (hostIs(host, "tiktok.com")) return /^\/(@[^/]+\/video\/|t\/|v\/|embed\/)/.test(path) || host.startsWith("vm.") || host.startsWith("vt.");
  if (hostIs(host, "x.com", "twitter.com")) return /^\/[^/]+\/status\/\d+/.test(path);
  if (hostIs(host, "douyin.com")) return /^\/(video\/|note\/)/.test(path) || host.startsWith("v.");
  if (hostIs(host, "iesdouyin.com")) return /\/video\//.test(path);
  if (hostIs(host, "xiaohongshu.com")) return /^\/(explore\/|discovery\/item\/|user\/profile\/[^/]+\/)/.test(path);
  if (host === "xhslink.com" || host.endsWith(".xhslink.com")) return true;
  return false;
}

/** Hashtags, mentions and links carry no meaning for "is there anything to summarise?". */
export function substance(text: string): string {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/[#@][\p{L}\p{N}_]+/gu, " ").replace(/\s+/g, " ").trim();
}

export const isThin = (text: string): boolean => estimateTokens(substance(text)) < THIN_TOKENS;

/** The decision, without any I/O: should this digest be read from its video? */
export function wantsVideo(digest: Pick<Digest, "kind" | "url" | "text">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (videoMode(env) === "off") return false;
  if (digest.kind !== "video" && digest.kind !== "post") return false;
  return isVideoUrl(digest.url) && isThin(digest.text);
}

// --- tools -------------------------------------------------------------------------------------

export interface VideoTools {
  ytdlp?: string;
  ffmpeg?: string;
  tesseract?: string;
  whisper?: { bin: string; kind: "openai" | "cpp" };
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, name);
    try {
      accessSync(full, constants.X_OK);
      if (statSync(full).isFile()) return full;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Tools found on PATH, or named by DRIFTNET_YTDLP / _FFMPEG / _TESSERACT / _WHISPER. Nothing runs here. */
export function videoTools(env: NodeJS.ProcessEnv = process.env): VideoTools {
  if (videoMode(env) === "off") return {};
  const pick = (override: string | undefined, ...names: string[]): string | undefined => {
    const o = override?.trim();
    if (o) return o;
    for (const n of names) {
      const found = onPath(n, env);
      if (found) return found;
    }
    return undefined;
  };
  const whisperOverride = env.DRIFTNET_WHISPER?.trim();
  const whisperBin = pick(whisperOverride, "whisper", "whisper-cli");
  const tools: VideoTools = {};
  const ytdlp = pick(env.DRIFTNET_YTDLP, "yt-dlp");
  const ffmpeg = pick(env.DRIFTNET_FFMPEG, "ffmpeg");
  const tesseract = pick(env.DRIFTNET_TESSERACT, "tesseract");
  if (ytdlp) tools.ytdlp = ytdlp;
  if (ffmpeg) tools.ffmpeg = ffmpeg;
  if (tesseract) tools.tesseract = tesseract;
  if (whisperBin) tools.whisper = { bin: whisperBin, kind: /whisper-cli|whisper-cpp/.test(whisperBin) ? "cpp" : "openai" };
  return tools;
}

/** "yt-dlp, ffmpeg, tesseract" (or "none"), for a startup line. */
export function describeVideoTools(tools: VideoTools): string {
  const names = [tools.ytdlp && "yt-dlp", tools.ffmpeg && "ffmpeg", tools.tesseract && "tesseract", tools.whisper && "whisper"].filter(Boolean);
  return names.length ? names.join(", ") : "none";
}

// --- running processes -------------------------------------------------------------------------

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
/** Injectable so tests never start a real process. Must resolve (not reject) on timeout, with `timedOut`. */
export type SpawnFn = (bin: string, args: string[], opts: RunOptions) => Promise<RunResult>;

/** No shell, own process group: a timeout kills yt-dlp's ffmpeg and whisper's workers too. */
export const defaultSpawn: SpawnFn = (bin, args, opts) =>
  new Promise((resolve) => {
    const child = nodeSpawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.stdout.on("data", (d) => { if (stdout.length < 2_000_000) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 100_000) stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      child.kill("SIGKILL");
      // 'close' may never come if a grandchild keeps the pipes open.
      setTimeout(() => finish(null), 500).unref();
    }, opts.timeoutMs);
    child.on("error", (err) => {
      stderr += (err as NodeJS.ErrnoException).code === "ENOENT" ? `${bin} not found` : String(err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });

function killTree(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** driftnet's secrets and vendor API keys never reach a tool that handles a stranger's link. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const drop = /^(DRIFTNET_|TYPESAFE_|TELEGRAM_|DISCORD_|LINE_|SLACK_|GITHUB_TOKEN$|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_API_KEY$)/;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.test(k)));
}

// --- text helpers ------------------------------------------------------------------------------

/** WebVTT / SRT -> plain lines. Auto-captions repeat each line as they scroll; consecutive repeats are dropped. */
export function parseSubtitles(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .trim();
    if (!t || /^WEBVTT/.test(t) || /^(Kind|Language|NOTE|STYLE):?/.test(t) || /-->/.test(t) || /^\d+$/.test(t)) continue;
    if (out[out.length - 1] === t || out.slice(-3).includes(t)) continue;
    out.push(t);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** OCR output from many near-identical frames -> each distinct line once, junk removed. */
export function dedupeLines(chunks: string[]): string[] {
  const kept: { text: string; key: string }[] = [];
  for (const chunk of chunks) {
    for (const raw of chunk.split(/\r?\n/)) {
      const text = raw.replace(/\s+/g, " ").trim();
      const key = norm(text);
      const cjk = (text.match(/[㐀-鿿぀-ヿ]/g) ?? []).length;
      if (key.length < 3 && cjk < 2) continue;
      // Mostly symbols: OCR noise from a texture, not text.
      const wordish = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (wordish / text.length < 0.5) continue;
      // The same line, or one that is a (partial) read of a longer line we have, or the reverse.
      const dup = kept.findIndex((k) => k.key === key || (key.length >= 6 && k.key.includes(key)) || (k.key.length >= 6 && key.includes(k.key)));
      if (dup >= 0) {
        if (key.length > kept[dup]!.key.length) kept[dup] = { text, key };
        continue;
      }
      kept.push({ text, key });
    }
  }
  return kept.map((k) => k.text);
}

export interface Section {
  label: string;
  text: string;
}

/** Labelled sections, each cut to what is left of the cap; the whole stays within `cap` characters. */
export function composeSections(sections: Section[], cap = SECTIONS_CAP): string {
  const parts: string[] = [];
  let used = 0;
  for (const s of sections) {
    const text = s.text.trim();
    if (!text) continue;
    const head = `[${s.label}]\n`;
    const sep = parts.length ? 2 : 0;
    const room = cap - used - sep - head.length;
    if (room < 20) break;
    const body = text.length > room ? text.slice(0, room - 1).trimEnd() + "…" : text;
    parts.push(head + body);
    used += sep + head.length + body.length;
  }
  return parts.join("\n\n");
}

// --- one process at a time ---------------------------------------------------------------------

class Gate {
  private active = false;
  private readonly waiting: (() => void)[] = [];
  async run<R>(fn: () => Promise<R>): Promise<R> {
    if (this.active) await new Promise<void>((r) => this.waiting.push(r));
    this.active = true;
    try {
      return await fn();
    } finally {
      this.active = false;
      this.waiting.shift()?.();
    }
  }
}
/** At most one video job in the whole process: a burst of reels queues instead of taking the machine down. */
const gate = new Gate();

// --- the job -----------------------------------------------------------------------------------

export interface VideoDeps {
  tools?: VideoTools;
  spawn?: SpawnFn;
  env?: NodeJS.ProcessEnv;
  /** Where the private temp dir is created. */
  tmpRoot?: string;
  /** Host name -> addresses. Tests answer from a fake. */
  resolveHost?: (host: string) => Promise<string[]>;
}

export class VideoRefused extends Error {}

/** Refuse private/local targets before a URL is handed to yt-dlp (which does its own networking). */
export async function assertPublicVideoUrl(url: string, deps: Pick<VideoDeps, "env" | "resolveHost"> = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (!URL.canParse(url)) throw new VideoRefused("not a URL");
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new VideoRefused(`${u.protocol} links are not read`);
  if (env.DRIFTNET_ALLOW_PRIVATE_URLS === "1") return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new VideoRefused(`${host} is a private or local address`);
    return;
  }
  const resolveHost = deps.resolveHost ?? (async (h: string) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address));
  const addresses = await resolveHost(host).catch(() => [] as string[]);
  if (!addresses.length) throw new VideoRefused(`${host} did not resolve`);
  if (!addresses.every(isPublicAddress)) throw new VideoRefused(`${host} resolves to a private or local address`);
}

export interface VideoReading {
  sections: Section[];
  /** Which steps produced text: "captions", "ocr", "speech". */
  steps: string[];
  title?: string;
}

/** Exact languages plus each video's own auto-caption language; never the machine-translated "zh-Hans-en" kind (slow, and YouTube answers 429). */
const SUB_LANGS = "en,.*-orig,zh-Hant,zh-Hans,zh-TW,zh-CN,zh,ja,ko,es,fr,de,pt,id,th,vi";
const FILTER_SCALE = `fps=1/${FRAME_EVERY_SECONDS},scale='min(960,iw)':-2`;

/** Runs the steps for one video inside `dir`. Exposed for tests; use `enrichFromVideo` in the pipeline. */
export async function readVideo(url: string, page: string, dir: string, deps: Required<Pick<VideoDeps, "spawn" | "tools" | "env">>): Promise<VideoReading> {
  const { spawn, tools } = deps;
  const env = scrubbedEnv(deps.env);
  const reading: VideoReading = { sections: [], steps: [] };
  const ytdlp = tools.ytdlp;
  if (!ytdlp) return reading;
  const ffArgs = tools.ffmpeg ? ["--ffmpeg-location", tools.ffmpeg] : [];
  const have = () => estimateTokens(substance(page)) + reading.sections.reduce((n, s) => n + estimateTokens(s.text), 0);
  const base = ["--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", "--socket-timeout", "15", "--retries", "1"];

  // 1. captions, title, description: no download.
  const meta = await spawn(ytdlp, [
    ...base, "--ignore-errors", "--skip-download", "--write-info-json", "--write-subs", "--write-auto-subs",
    "--sub-langs", SUB_LANGS, "--sub-format", "vtt/srt/best", "-o", join(dir, "meta.%(ext)s"), "--", url,
  ], { cwd: dir, env, timeoutMs: TIMEOUTS.captions });
  const infoPath = join(dir, "meta.info.json");
  let info: { title?: unknown; description?: unknown } | undefined;
  try {
    info = JSON.parse(readFileSync(infoPath, "utf8"));
  } catch {
    // no info: yt-dlp could not read this link
  }
  if (!info && !meta.timedOut && meta.code !== 0) return reading;
  const title = typeof info?.title === "string" ? info.title.trim() : "";
  const description = typeof info?.description === "string" ? info.description.trim() : "";
  if (title) reading.title = title;
  const pageKey = norm(page);
  if (description && estimateTokens(substance(description)) >= 5 && !(pageKey && pageKey.includes(norm(description).slice(0, 40)))) {
    reading.sections.push({ label: "description", text: description });
  }
  const subFiles = readdirSync(dir).filter((f) => /^meta\..+\.(vtt|srt)$/.test(f)).sort((a, b) => Number(/-orig\./.test(b)) - Number(/-orig\./.test(a)) || a.localeCompare(b));
  if (subFiles.length) {
    const captions = parseSubtitles(readFileSync(join(dir, subFiles[0]!), "utf8"));
    if (captions) {
      reading.sections.push({ label: "captions", text: captions.slice(0, 4000) });
      reading.steps.push("captions");
    }
  }
  if (have() >= ENOUGH_TOKENS || !tools.ffmpeg) return reading;
  if (!tools.tesseract && !tools.whisper) return reading;

  // 2. the video itself, lowest quality that is still legible (>= 360p when offered), capped in size and length.
  await spawn(ytdlp, [
    ...base, ...ffArgs, "-f", "worst[height>=360]/worst", "--max-filesize", String(MAX_BYTES),
    "--download-sections", `*0-${MAX_SECONDS}`, "-o", join(dir, "video.%(ext)s"), "--", url,
  ], { cwd: dir, env, timeoutMs: TIMEOUTS.download });
  const video = readdirSync(dir).map((f) => join(dir, f)).find((f) => /\/video\.[^/]+$/.test(f) && !/\.(part|ytdl|json)$/.test(f));
  if (!video || statSync(video).size > MAX_BYTES) return reading;

  if (tools.tesseract) {
    const ocr = await onScreenText(video, dir, deps, env, () => have());
    if (ocr) {
      reading.sections.push({ label: "on-screen text", text: ocr });
      reading.steps.push("ocr");
    }
  }
  if (have() >= ENOUGH_TOKENS || !tools.whisper) return reading;

  // 3. speech, only when everything cheaper left the item thin.
  const speech = await transcribe(video, dir, deps, env);
  if (speech) {
    reading.sections.push({ label: "speech", text: speech });
    reading.steps.push("speech");
  }
  return reading;
}

let langCache = new Map<string, string>();
/** eng + chi_tra + chi_sim, whichever tesseract has installed. */
async function ocrLanguages(bin: string, spawn: SpawnFn, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const cached = langCache.get(bin);
  if (cached !== undefined) return cached || undefined;
  const r = await spawn(bin, ["--list-langs"], { cwd, env, timeoutMs: 10_000 });
  const installed = new Set(r.stdout.split(/\r?\n/).map((l) => l.trim()));
  const langs = ["eng", "chi_tra", "chi_sim"].filter((l) => installed.has(l)).join("+");
  langCache.set(bin, langs);
  return langs || undefined;
}
/** Tests only. */
export const resetVideoCaches = (): void => { langCache = new Map(); };

type Ctx = Required<Pick<VideoDeps, "spawn" | "tools" | "env">>;

/** ~1 frame every 2 s (max 40, scaled down) -> tesseract, repeated lines dropped. */
async function onScreenText(video: string, dir: string, ctx: Ctx, env: NodeJS.ProcessEnv, have: () => number): Promise<string> {
  const { spawn, tools } = ctx;
  const framesDir = join(dir, "frames");
  mkdirSync(framesDir);
  await spawn(tools.ffmpeg!, [
    "-nostdin", "-v", "error", "-t", String(MAX_SECONDS), "-i", video,
    "-vf", FILTER_SCALE, "-frames:v", String(MAX_FRAMES), join(framesDir, "f%03d.png"),
  ], { cwd: dir, env, timeoutMs: TIMEOUTS.frames });
  const frames = readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort().slice(0, MAX_FRAMES);
  if (!frames.length) return "";
  const langs = await ocrLanguages(tools.tesseract!, spawn, dir, env);
  const deadline = Date.now() + TIMEOUTS.ocr;
  const chunks: string[] = [];
  for (const f of frames) {
    const left = deadline - Date.now();
    if (left < 1000) break;
    const r = await spawn(tools.tesseract!, [join(framesDir, f), "stdout", "--psm", "11", ...(langs ? ["-l", langs] : [])], { cwd: dir, env, timeoutMs: left });
    if (r.timedOut) break;
    if (r.code === 0 && r.stdout.trim()) chunks.push(r.stdout);
    // Enough text already: the remaining frames would only repeat it.
    if (have() + estimateTokens(dedupeLines(chunks).join("\n")) >= ENOUGH_TOKENS) break;
  }
  return dedupeLines(chunks).join("\n");
}

/** First 3 minutes -> 16 kHz mono wav -> whisper (openai-whisper CLI, or whisper.cpp with DRIFTNET_WHISPER_MODEL), language auto. */
async function transcribe(video: string, dir: string, ctx: Ctx, env: NodeJS.ProcessEnv): Promise<string> {
  const { spawn, tools } = ctx;
  const wav = join(dir, "audio.wav");
  const ff = await spawn(tools.ffmpeg!, [
    "-nostdin", "-v", "error", "-t", String(MAX_SECONDS), "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav,
  ], { cwd: dir, env, timeoutMs: TIMEOUTS.audio });
  if (ff.code !== 0) return "";
  const w = tools.whisper!;
  // openai-whisper decodes through the ffmpeg on its PATH.
  const wenv = { ...env, PATH: [dirname(tools.ffmpeg!), env.PATH].filter((p) => p && p !== ".").join(delimiter) };
  const model = ctx.env.DRIFTNET_WHISPER_MODEL?.trim();
  if (w.kind === "cpp") {
    if (!model) return "";
    const r = await spawn(w.bin, ["-m", model, "-f", wav, "-l", "auto", "-nt", "-np"], { cwd: dir, env: wenv, timeoutMs: TIMEOUTS.speech });
    return r.code === 0 ? r.stdout.replace(/\s+/g, " ").trim() : "";
  }
  const r = await spawn(w.bin, [wav, "--model", model || "base", "--output_format", "txt", "--output_dir", dir, "--fp16", "False", "--verbose", "False"], {
    cwd: dir, env: wenv, timeoutMs: TIMEOUTS.speech,
  });
  if (r.code !== 0) {
    // A broken install (missing library, no model) should be visible, not silently "no speech".
    if (!r.timedOut) console.warn(`[driftnet] whisper exited ${r.code}: ${r.stderr.trim().split("\n").pop()?.slice(0, 200) ?? ""}`);
    return "";
  }
  try {
    return readFileSync(join(dir, "audio.txt"), "utf8").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

export interface VideoEnrichment {
  digest: Digest;
  /** Item flags to add: "video-read" plus one per step that produced text ("video-captions", "video-ocr", "video-speech"). */
  flags: string[];
}

/**
 * Adds "[captions]", "[on-screen text]" and "[speech]" sections to a thin video digest.
 * Never throws: a missing tool, a refused host or a failing step leaves the digest as it was.
 * The result still goes through the pollution guard like any page text.
 */
export async function enrichFromVideo(digest: Digest, deps: VideoDeps = {}): Promise<VideoEnrichment> {
  const env = deps.env ?? process.env;
  const none = { digest, flags: [] as string[] };
  if (!wantsVideo(digest, env)) return none;
  const tools = deps.tools ?? videoTools(env);
  if (!tools.ytdlp) return none;
  try {
    await assertPublicVideoUrl(digest.url, { env, ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}) });
  } catch (err) {
    console.warn(`[driftnet] video skipped for ${digest.url}: ${(err as Error).message}`);
    return none;
  }
  const spawn = deps.spawn ?? defaultSpawn;
  return gate.run(async () => {
    const dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), "driftnet-video-"));
    try {
      const reading = await readVideo(digest.url, digest.text, dir, { spawn, tools, env });
      const extra = composeSections(reading.sections);
      if (!extra) return none;
      const text = digest.text.trim() ? `${digest.text.trim()}\n\n${extra}` : extra;
      // A page that only knew its own address gets the video's title.
      const untitled = !digest.title || digest.title === digest.url || (URL.canParse(digest.url) && digest.title === new URL(digest.url).hostname);
      return {
        digest: { ...digest, text, title: untitled && reading.title ? reading.title : digest.title },
        flags: reading.steps.length ? ["video-read", ...reading.steps.map((s) => `video-${s}`)] : [],
      };
    } catch (err) {
      console.warn(`[driftnet] video read failed for ${digest.url}: ${(err as Error).message}`);
      return none;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
