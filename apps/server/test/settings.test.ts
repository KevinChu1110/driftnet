import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Settings, SettingsError } from "../src/settings.ts";

function setup(file = "") {
  const home = mkdtempSync(join(tmpdir(), "driftnet-settings-"));
  if (file) writeFileSync(join(home, ".env"), file);
  const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: home, ...parseEnv(file), DRIFTNET_LLM_MODEL_FROM_SHELL: "x" };
  return { env, home, settings: new Settings(env, new Set(["DRIFTNET_PUBLIC_URL"])) };
}

test("saving rewrites only the changed lines, keeps comments, and round-trips tricky text", () => {
  const { env, home, settings } = setup("# my settings\nPORT=9000\nDRIFTNET_LLM_MODEL=old\nDRIFTNET_SUMMARY_RULES=`a\nb`\n");
  const rules = 'Say whether it\'s "free".\nMention # of stars';
  assert.deepEqual(settings.update({ DRIFTNET_LLM_MODEL: "gpt-5-mini", DRIFTNET_SUMMARY_RULES: rules, DRIFTNET_REPLY: "off" }).sort(),
    ["DRIFTNET_LLM_MODEL", "DRIFTNET_REPLY", "DRIFTNET_SUMMARY_RULES"]);
  const file = readFileSync(join(home, ".env"), "utf8");
  assert.match(file, /^# my settings\nPORT=9000\nDRIFTNET_LLM_MODEL=gpt-5-mini\n/);
  assert.equal(parseEnv(file).DRIFTNET_SUMMARY_RULES, rules);
  assert.equal(parseEnv(file).DRIFTNET_REPLY, "off");
  assert.equal(env.DRIFTNET_LLM_MODEL, "gpt-5-mini", "the running process sees it at once");
  assert.equal(statSync(join(home, ".env")).mode & 0o777, 0o600, "keys live here: owner only");
  settings.update({ DRIFTNET_LLM_MODEL: null });
  assert.equal(parseEnv(readFileSync(join(home, ".env"), "utf8")).DRIFTNET_LLM_MODEL, undefined);
  assert.equal(env.DRIFTNET_LLM_MODEL, undefined);
});

test("secrets are never shown, and an empty secret keeps the old one", () => {
  const { env, settings } = setup("DRIFTNET_LLM_API_KEY=sk-secret\n");
  const key = settings.view().settings.find((s) => s.key === "DRIFTNET_LLM_API_KEY")!;
  assert.equal(key.value, undefined);
  assert.equal(key.set, true);
  assert.deepEqual(settings.update({ DRIFTNET_LLM_API_KEY: "" }), []);
  assert.equal(env.DRIFTNET_LLM_API_KEY, "sk-secret");
  assert.ok(!JSON.stringify(settings.view()).includes("sk-secret"));
});

test("refused: unknown keys, environment-owned keys, bad choices, line breaks, backticks", () => {
  const { settings } = setup();
  for (const bad of [
    { DRIFTNET_TOKEN: "x" }, { PORT: "1" }, { DRIFTNET_PUBLIC_URL: "https://x.test" }, { DRIFTNET_REPLY: "loud" },
    { DRIFTNET_LLM_MODEL: "a\nb" }, { DRIFTNET_SUMMARY_RULES: "`rm`" }, { DRIFTNET_LLM_BASE_URL: "file:///etc" }, { DRIFTNET_LLM_MODEL: 5 },
  ]) assert.throws(() => settings.update(bad), SettingsError, JSON.stringify(bad));
});

test("a video tool setting must be the full path of that tool, not any program", () => {
  const { settings } = setup();
  settings.update({ DRIFTNET_YTDLP: "/opt/homebrew/bin/yt-dlp", DRIFTNET_WHISPER: "/usr/local/bin/whisper-cli", DRIFTNET_FFMPEG: "C:\\tools\\ffmpeg.exe", DRIFTNET_TESSERACT: "" });
  for (const bad of [
    { DRIFTNET_YTDLP: "/bin/sh" }, { DRIFTNET_YTDLP: "yt-dlp" }, { DRIFTNET_TESSERACT: "/usr/bin/python3" },
    { DRIFTNET_FFMPEG: "/tmp/ffmpeg/../../bin/sh" }, { DRIFTNET_WHISPER: "/usr/bin/env" }, { DRIFTNET_YTDLP: "/opt/yt-dlp/" },
  ]) assert.throws(() => settings.update(bad), SettingsError, JSON.stringify(bad));
  // The cookies setting is a file path (any name), never the cookies themselves.
  settings.update({ DRIFTNET_YTDLP_COOKIES: "/Users/me/cookies.txt" });
  settings.update({ DRIFTNET_YTDLP_COOKIES: "C:\\Users\\me\\yt.cookies" });
  settings.update({ DRIFTNET_YTDLP_COOKIES: "" });
  settings.update({ DRIFTNET_YTDLP_IMPERSONATE: "chrome" });
  settings.update({ DRIFTNET_YTDLP_IMPERSONATE: "chrome-136:macos" });
  settings.update({ DRIFTNET_YTDLP_IMPERSONATE: "" });
  for (const bad of [{ DRIFTNET_YTDLP_IMPERSONATE: "--cookies /etc/passwd" }, { DRIFTNET_YTDLP_IMPERSONATE: "chrome;rm" }, { DRIFTNET_YTDLP_IMPERSONATE: "-chrome" }]) {
    assert.throws(() => settings.update(bad), SettingsError, JSON.stringify(bad));
  }
  for (const bad of [{ DRIFTNET_YTDLP_COOKIES: "cookies.txt" }, { DRIFTNET_YTDLP_COOKIES: "/tmp/" }, { DRIFTNET_YTDLP_COOKIES: "# Netscape HTTP Cookie File\n.x.com\tTRUE" }]) {
    assert.throws(() => settings.update(bad), SettingsError, JSON.stringify(bad));
  }
});

test("the webhook URL is masked like a key and must be http(s)", () => {
  const { settings } = setup();
  settings.update({ DRIFTNET_WEBHOOK_URL: "https://n8n.example/hook/abc123", DRIFTNET_WEBHOOK_SECRET: "s" });
  const row = settings.view().settings.find((s) => s.key === "DRIFTNET_WEBHOOK_URL")!;
  assert.equal(row.set, true);
  assert.equal(row.secret, true);
  assert.equal("value" in row, false, "the value never leaves the server");
  assert.throws(() => settings.update({ DRIFTNET_WEBHOOK_URL: "ftp://x/y" }), SettingsError);
  assert.throws(() => settings.update({ DRIFTNET_WEBHOOK_ALLOW_LOCAL: "yes" }), SettingsError);
});

test("saving other settings works when the file holds a value no longer in the choices; xhigh is a choice", () => {
  const { settings, env } = setup("DRIFTNET_LLM_EFFORT=ultra\n");
  assert.deepEqual(settings.update({ DRIFTNET_LLM_EFFORT: "ultra", DRIFTNET_REPLY: "off" }), ["DRIFTNET_REPLY"]);
  assert.throws(() => settings.update({ DRIFTNET_LLM_EFFORT: "extreme" }), SettingsError);
  assert.deepEqual(settings.update({ DRIFTNET_LLM_EFFORT: "xhigh" }), ["DRIFTNET_LLM_EFFORT"]);
  assert.equal(env.DRIFTNET_LLM_EFFORT, "xhigh");
});
