import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import {
  SECTIONS_CAP, THIN_TOKENS, TIMEOUTS, assertPublicVideoUrl, composeSections, dedupeLines, defaultSpawn, enrichFromVideo,
  isThin, isVideoUrl, parseSubtitles, resetVideoCaches, scrubbedEnv, videoTools, wantsVideo,
  type RunOptions, type RunResult, type SpawnFn, type VideoTools,
} from "../src/extractors/video.ts";
import type { Digest } from "../src/types.ts";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const publicHost = async () => ["93.184.216.34"];
const TOOLS: VideoTools = { ytdlp: "/t/yt-dlp", ffmpeg: "/t/ffmpeg", tesseract: "/t/tesseract", whisper: { bin: "/t/whisper", kind: "openai" } };
const REEL = "https://instagram.com/reel/Cabc123/";
const digest = (over: Partial<Digest> = {}): Digest => ({ url: REEL, kind: "post", title: "instagram.com", text: "", outlinks: [], meta: {}, ...over });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

interface Call { bin: string; args: string[]; opts: RunOptions }
interface Script {
  captions?: string; info?: Record<string, unknown>; video?: boolean; ocr?: string[]; speech?: string;
  /** Step name whose call never finishes in time. */
  timeoutOn?: "captions" | "download" | "frames" | "ocr" | "speech";
  tmpDirs?: string[];
}

/** A fake yt-dlp / ffmpeg / tesseract / whisper that writes the files the real ones would. */
function fake(script: Script): { spawn: SpawnFn; calls: Call[] } {
  const calls: Call[] = [];
  let ocrN = 0;
  const spawn: SpawnFn = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    script.tmpDirs?.push(opts.cwd);
    const timedOut = (step: string): RunResult | undefined => (script.timeoutOn === step ? { code: null, stdout: "", stderr: "", timedOut: true } : undefined);
    if (bin.endsWith("yt-dlp")) {
      if (args.includes("--skip-download")) {
        const t = timedOut("captions");
        if (t) return t;
        if (script.info) writeFileSync(join(opts.cwd, "meta.info.json"), JSON.stringify(script.info));
        if (script.captions) writeFileSync(join(opts.cwd, "meta.en.vtt"), script.captions);
        return script.info || script.captions ? ok() : { code: 1, stdout: "", stderr: "unsupported", timedOut: false };
      }
      const t = timedOut("download");
      if (t) return t;
      if (script.video) writeFileSync(join(opts.cwd, "video.mp4"), "x");
      return ok();
    }
    if (bin.endsWith("ffmpeg")) {
      if (args.some((a) => a.endsWith("f%03d.png"))) {
        const t = timedOut("frames");
        if (t) return t;
        const dir = args[args.length - 1]!.replace(/\/f%03d\.png$/, "");
        for (let i = 1; i <= (script.ocr?.length ?? 0); i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.png`), "x");
        return ok();
      }
      return ok();
    }
    if (bin.endsWith("tesseract")) {
      if (args[0] === "--list-langs") return ok("List of available languages (3):\neng\nchi_tra\nosd\n");
      const t = timedOut("ocr");
      if (t) return t;
      return ok(script.ocr?.[ocrN++] ?? "");
    }
    if (bin.endsWith("whisper")) {
      const t = timedOut("speech");
      if (t) return t;
      writeFileSync(join(opts.cwd, "audio.txt"), script.speech ?? "");
      return ok();
    }
    return { code: 127, stdout: "", stderr: "", timedOut: false };
  };
  return { spawn, calls };
}

const run = (d: Digest, script: Script, extra: { tools?: VideoTools; env?: NodeJS.ProcessEnv } = {}) => {
  const f = fake(script);
  const tmpRoot = mkdtempSync(join(tmpdir(), "dn-video-test-"));
  return enrichFromVideo(d, { tools: extra.tools ?? TOOLS, spawn: f.spawn, tmpRoot, resolveHost: publicHost, env: extra.env ?? {} })
    .then((r) => ({ ...r, calls: f.calls, tmpRoot }));
};

beforeEach(() => resetVideoCaches());

test("which links count as video: known hosts and shapes only", () => {
  for (const u of [
    "https://youtube.com/shorts/abc123XYZ_-", "https://youtube.com/watch?v=abcdefghijk", "https://instagram.com/reel/C1/", "https://www.instagram.com/p/C1/",
    "https://facebook.com/reel/123", "https://facebook.com/watch?v=1", "https://facebook.com/share/v/AbC/", "https://fb.watch/xyz/",
    "https://threads.net/@a/post/C1", "https://tiktok.com/@a/video/123", "https://vm.tiktok.com/ZM1/", "https://x.com/a/status/123",
    "https://douyin.com/video/123", "https://xiaohongshu.com/explore/abc", "https://xhslink.com/a/b",
  ]) assert.equal(isVideoUrl(u), true, u);
  for (const u of ["https://example.com/reel/1", "https://github.com/a/b", "https://instagram.com/someone/", "https://x.com/someone", "https://youtube.com/@channel", "ftp://tiktok.com/@a/video/1", "not a url"]) {
    assert.equal(isVideoUrl(u), false, u);
  }
});

test("thin threshold ignores hashtags, mentions and links", () => {
  assert.equal(isThin(""), true);
  assert.equal(isThin("#ai #tools #reels @someone https://example.com/a"), true);
  assert.equal(isThin(words(THIN_TOKENS * 4)), false);
  assert.equal(isThin("這個工具可以讓你用一句話產生整個網站，而且完全免費，不需要寫任何程式碼，還能直接部署到雲端主機"), false);
});

test("only thin video/post items on video hosts are read; DRIFTNET_VIDEO=off never", () => {
  assert.equal(wantsVideo(digest(), {}), true);
  assert.equal(wantsVideo(digest({ kind: "video" }), {}), true);
  assert.equal(wantsVideo(digest({ text: words(200) }), {}), false);
  assert.equal(wantsVideo(digest({ kind: "article" }), {}), false);
  assert.equal(wantsVideo(digest({ kind: "repo", url: "https://github.com/a/b" }), {}), false);
  assert.equal(wantsVideo(digest({ kind: "product", url: "https://example.com/blog/post" }), {}), false);
  assert.equal(wantsVideo(digest(), { DRIFTNET_VIDEO: "off" }), false);
  assert.equal(wantsVideo(digest(), { DRIFTNET_VIDEO: "auto" }), true);
});

test("tools: found on PATH, overridable, none when off", () => {
  const dir = mkdtempSync(join(tmpdir(), "dn-video-path-"));
  for (const n of ["yt-dlp", "whisper-cli"]) writeFileSync(join(dir, n), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "ffmpeg"), "not executable", { mode: 0o644 });
  const t = videoTools({ PATH: dir });
  assert.equal(t.ytdlp, join(dir, "yt-dlp"));
  assert.equal(t.ffmpeg, undefined);
  assert.deepEqual(t.whisper, { bin: join(dir, "whisper-cli"), kind: "cpp" });
  assert.equal(videoTools({ PATH: dir, DRIFTNET_FFMPEG: "/opt/ff" }).ffmpeg, "/opt/ff");
  assert.deepEqual(videoTools({ PATH: dir, DRIFTNET_VIDEO: "off" }), {});
});

test("subtitle parsing drops timing, tags and scrolling repeats", () => {
  const vtt = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000 align:start\nHello <c.color>there</c>\n\n00:00:02.000 --> 00:00:04.000\nHello there\nthis is Cursor\n\n00:00:04.000 --> 00:00:05.000\nthis is Cursor\n";
  assert.equal(parseSubtitles(vtt), "Hello there this is Cursor");
});

test("OCR dedupe: repeated, partial and junk lines go; the fuller read stays", () => {
  const out = dedupeLines([
    "Install with npm\n~~ // ::\nTRY IT FREE\n",
    "install with npm\nTRY IT FREE\nTry it fr\n",
    "Install with npm i -g cursor-agent\n\nok\n",
    "你好 世界工具\n",
  ]);
  assert.deepEqual(out, ["Install with npm i -g cursor-agent", "TRY IT FREE", "你好 世界工具"]);
});

test("sections are labelled and the whole stays within the cap", () => {
  const text = composeSections([{ label: "captions", text: "a".repeat(5000) }, { label: "on-screen text", text: "b".repeat(5000) }, { label: "speech", text: "c" }]);
  assert.ok(text.length <= SECTIONS_CAP, String(text.length));
  assert.ok(text.startsWith("[captions]\n"));
  assert.ok(text.includes("[on-screen text]\n"));
  assert.ok(!text.includes("[speech]"), "no room left: dropped whole, not cut mid-label");
  assert.equal(composeSections([{ label: "speech", text: "  " }]), "");
});

test("captions are enough: no download, no OCR, no whisper", async () => {
  const r = await run(digest(), { info: { title: "Cursor agent demo", description: "" }, captions: `WEBVTT\n\n00:00:00.000 --> 00:00:09.000\n${words(150)}\n` });
  assert.match(r.digest.text, /^\[captions\]\nword0 /);
  assert.deepEqual(r.flags, ["video-read", "video-captions"]);
  assert.equal(r.digest.title, "Cursor agent demo", "an untitled page takes the video's title");
  assert.deepEqual(r.calls.map((c) => c.bin), ["/t/yt-dlp"]);
});

test("thin captions: OCR runs, then speech; steps and sections recorded in order", async () => {
  const r = await run(digest(), {
    info: { title: "x", description: "" }, captions: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n", video: true,
    ocr: ["Cursor", "Cursor\nnpm i -g cursor-agent"], speech: "This tool is called Cursor agent and it edits your repo from the terminal.",
  });
  assert.deepEqual(r.flags, ["video-read", "video-captions", "video-ocr", "video-speech"]);
  const parts = r.digest.text.split(/\n\n(?=\[)/);
  assert.deepEqual(parts.map((p) => p.split("\n")[0]), ["[captions]", "[on-screen text]", "[speech]"]);
  assert.ok(r.digest.text.includes("npm i -g cursor-agent"));
});

test("plenty of on-screen text skips speech", async () => {
  const r = await run(digest(), { info: {}, video: true, ocr: [Array.from({ length: 30 }, (_, i) => `Feature number ${i} of the tool`).join("\n")], speech: "never read" });
  assert.deepEqual(r.flags, ["video-read", "video-ocr"]);
  assert.ok(!r.calls.some((c) => c.bin.endsWith("whisper")));
});

test("commands are argument arrays: URL after --, size/length/quality caps, per-step timeouts, scrubbed env", async () => {
  const hostile = "https://instagram.com/reel/C1/?x=$(touch /tmp/pwn);`id`&y=1 2";
  const secrets = { DRIFTNET_TOKEN: "s3cret", TYPESAFE_API_KEY: "k", SLACK_BOT_TOKEN: "x", ANTHROPIC_API_KEY: "a", PATH: "/usr/bin", HOME: "/home/u" };
  const f = fake({ info: {}, video: true, ocr: ["Some words here"], speech: "spoken words about a tool and what it does for you every day" });
  const tmpRoot = mkdtempSync(join(tmpdir(), "dn-video-test-"));
  await enrichFromVideo(digest({ url: hostile }), { tools: TOOLS, spawn: f.spawn, tmpRoot, resolveHost: publicHost, env: { ...secrets } });
  const [captions, download, ffFrames, , ocr, ffAudio, whisper] = f.calls;
  for (const c of f.calls) {
    assert.ok(Array.isArray(c.args));
    for (const k of ["DRIFTNET_TOKEN", "TYPESAFE_API_KEY", "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY"]) assert.equal(c.opts.env[k], undefined, `${c.bin} leaks ${k}`);
    assert.equal(c.opts.env.HOME, "/home/u");
    assert.ok(c.opts.cwd.startsWith(tmpRoot), "runs inside the private temp dir");
  }
  assert.equal(captions!.args.at(-2), "--");
  assert.equal(captions!.args.at(-1), hostile, "the URL is one argument, untouched");
  assert.ok(captions!.args.includes("--skip-download") && captions!.args.includes("--ignore-config") && captions!.args.includes("--no-playlist"));
  assert.equal(captions!.opts.timeoutMs, TIMEOUTS.captions);
  assert.equal(download!.opts.timeoutMs, TIMEOUTS.download);
  assert.equal(download!.args[download!.args.indexOf("--max-filesize") + 1], String(60 * 1024 * 1024));
  assert.equal(download!.args[download!.args.indexOf("--download-sections") + 1], "*0-180");
  assert.equal(download!.args[download!.args.indexOf("-f") + 1], "worst[height>=360]/worst");
  assert.equal(ffFrames!.args[ffFrames!.args.indexOf("-frames:v") + 1], "40");
  assert.ok(ffFrames!.args.some((a) => a.startsWith("fps=1/2,scale=")));
  assert.equal(ocr!.args[ocr!.args.indexOf("-l") + 1], "eng+chi_tra", "only installed languages");
  assert.equal(ffAudio!.args.slice(ffAudio!.args.indexOf("-ac"), ffAudio!.args.indexOf("-ac") + 4).join(" "), "-ac 1 -ar 16000");
  assert.equal(whisper!.opts.timeoutMs, TIMEOUTS.speech);
  assert.ok(whisper!.opts.env.PATH!.startsWith("/t:"), "whisper finds ffmpeg next to the configured one");
});

test("the temp dir is deleted after success, on a timeout, on a crash and when nothing works", async () => {
  const left = (root: string) => readdirSync(root);
  const ok1 = await run(digest(), { info: {}, video: true, ocr: ["Some words here"], speech: "spoken words" });
  assert.deepEqual(left(ok1.tmpRoot), []);
  for (const step of ["captions", "download", "frames", "ocr", "speech"] as const) {
    const r = await run(digest(), { info: { title: "t" }, captions: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n", video: true, ocr: ["Words one two"], timeoutOn: step });
    assert.deepEqual(left(r.tmpRoot), [], `timeout in ${step}`);
  }
  const tmpRoot = mkdtempSync(join(tmpdir(), "dn-video-test-"));
  const dirs: string[] = [];
  const boom: SpawnFn = async (_b, _a, o) => { dirs.push(o.cwd); throw new Error("spawn exploded"); };
  const r = await enrichFromVideo(digest(), { tools: TOOLS, spawn: boom, tmpRoot, resolveHost: publicHost, env: {} });
  assert.equal(r.digest.text, "");
  assert.deepEqual(r.flags, []);
  assert.equal(dirs.length, 1);
  assert.equal(existsSync(dirs[0]!), false);
  const none = await run(digest(), {});
  assert.deepEqual(none.flags, []);
  assert.deepEqual(left(none.tmpRoot), []);
});

test("a timed-out download stops the pipeline: nothing downstream runs on a half file", async () => {
  const r = await run(digest(), { info: { title: "t" }, video: true, ocr: ["a b c"], timeoutOn: "download" });
  assert.ok(!r.calls.some((c) => c.bin.endsWith("ffmpeg") || c.bin.endsWith("tesseract") || c.bin.endsWith("whisper")));
  assert.deepEqual(r.flags, []);
});

test("private and local video links are refused before yt-dlp sees them", async () => {
  const f = fake({ info: {} });
  const resolveHost = async (h: string) => (h === "evil.example" ? ["127.0.0.1"] : ["8.8.8.8"]);
  for (const url of ["https://127.0.0.1/reel/C1/", "https://[::1]/reel/C1/", "https://169.254.169.254/p/x", "https://evil.example/anything"]) {
    await assert.rejects(assertPublicVideoUrl(url, { env: {}, resolveHost }), /private|local/, url);
  }
  await assert.rejects(assertPublicVideoUrl("file:///etc/passwd", { env: {} }), /not read/);
  await assert.rejects(assertPublicVideoUrl("https://nx.example/", { env: {}, resolveHost: async () => [] }), /did not resolve/);
  await assertPublicVideoUrl("https://instagram.com/reel/C1/", { env: {}, resolveHost });
  await assertPublicVideoUrl("https://127.0.0.1/", { env: { DRIFTNET_ALLOW_PRIVATE_URLS: "1" } });
  // And through the entry point: a host that resolves to loopback never reaches the tools.
  const tmpRoot = mkdtempSync(join(tmpdir(), "dn-video-test-"));
  const r = await enrichFromVideo(digest({ url: "https://instagram.com/reel/C1/" }), { tools: TOOLS, spawn: f.spawn, tmpRoot, resolveHost: async () => ["10.0.0.5"], env: {} });
  assert.equal(r.digest.text, "");
  assert.equal(f.calls.length, 0);
});

test("one video job at a time, process-wide", async () => {
  let active = 0;
  let peak = 0;
  const spawn: SpawnFn = async (bin, args, o) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 10));
    active--;
    if (args.includes("--skip-download")) writeFileSync(join(o.cwd, "meta.info.json"), JSON.stringify({ title: "t", description: words(50) }));
    return ok();
  };
  const tmpRoot = mkdtempSync(join(tmpdir(), "dn-video-test-"));
  const results = await Promise.all([1, 2, 3, 4].map((i) =>
    enrichFromVideo(digest({ url: `https://instagram.com/reel/C${i}/` }), { tools: { ytdlp: "/t/yt-dlp" }, spawn, tmpRoot, resolveHost: publicHost, env: {} })));
  assert.equal(peak, 1);
  assert.ok(results.every((r) => r.digest.text.includes("[description]")));
});

test("no yt-dlp, or an ordinary article: the digest comes back untouched and nothing runs", async () => {
  const d = digest();
  const a = await run(d, {}, { tools: { ffmpeg: "/t/ffmpeg" } });
  assert.equal(a.digest, d);
  assert.equal(a.calls.length, 0);
  const article = digest({ kind: "article", url: "https://example.com/post" });
  const b = await run(article, { info: {} });
  assert.equal(b.digest, article);
  assert.equal(b.calls.length, 0);
});

test("scrubbedEnv drops driftnet secrets and vendor keys, keeps the rest", () => {
  const e = scrubbedEnv({ DRIFTNET_TOKEN: "a", DRIFTNET_LLM_API_KEY: "b", GITHUB_TOKEN: "c", OPENAI_API_KEY: "d", LINE_CHANNEL_SECRET: "e", PATH: "/bin", HOME: "/h", LANG: "C" });
  assert.deepEqual(Object.keys(e).sort(), ["HOME", "LANG", "PATH"]);
});

test("the real runner: no shell, kills the process group on timeout, reports timedOut", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dn-video-run-"));
  const echo = await defaultSpawn("/bin/echo", ["$(whoami) `id` ; &&"], { cwd: dir, env: {}, timeoutMs: 5000 });
  assert.equal(echo.stdout.trim(), "$(whoami) `id` ; &&");
  const started = Date.now();
  const slow = await defaultSpawn("/bin/sh", ["-c", "sleep 30 & sleep 30"], { cwd: dir, env: { PATH: "/bin:/usr/bin" }, timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 3000);
  const missing = await defaultSpawn("/nonexistent/tool", [], { cwd: dir, env: {}, timeoutMs: 1000 });
  assert.equal(missing.code, null);
});

// Optional: DRIFTNET_VIDEO_IT=1 DRIFTNET_VIDEO_IT_URL=<public short> pnpm test — needs yt-dlp, ffmpeg, tesseract, whisper.
test("integration: a real short, end to end", { skip: process.env.DRIFTNET_VIDEO_IT !== "1" }, async () => {
  const env = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };
  const tools = videoTools(env);
  assert.ok(tools.ytdlp && tools.ffmpeg, "yt-dlp and ffmpeg are required for this test");
  const url = process.env.DRIFTNET_VIDEO_IT_URL ?? "https://youtube.com/shorts/aqz-KE-bpKQ";
  // Force the later steps by pretending there is nothing else to read.
  const r = await enrichFromVideo(digest({ url, kind: "video", title: url }), { tools, env, tmpRoot: mkdtempSync(join(tmpdir(), "dn-video-it-")) });
  console.log(`[video-it] flags=${r.flags.join(",")} title=${r.digest.title}\n${r.digest.text.slice(0, 1200)}`);
  assert.ok(r.digest.text.length > 0, "some text came out of the video");
  assert.ok(r.flags.includes("video-read"));
});
