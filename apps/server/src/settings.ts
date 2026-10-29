import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driftnetHome } from "@driftnet/core";
import { DAYS, parseTargets, validTime } from "./digest.ts";

/**
 * What the settings page may change. Everything here takes effect without a
 * restart (the judge, model and rules are rebuilt; the rest is read per
 * request). The server's own address, token and chat-platform keys are not
 * here on purpose: they need a restart, and a page that can change the token
 * could lock its owner out.
 */
export interface Setting {
  key: string;
  group: "model" | "language" | "chat" | "rules" | "access" | "webhook" | "digest";
  secret?: boolean;
  choices?: readonly string[];
  multiline?: boolean;
  max?: number;
  min?: number;
}

export const SETTINGS: readonly Setting[] = [
  { key: "DRIFTNET_LLM_PROVIDER", group: "model", choices: ["", "anthropic", "openai", "gemini", "bedrock", "vertex", "claude-cli", "gemini-cli"] },
  { key: "DRIFTNET_LLM_MODEL", group: "model" },
  { key: "DRIFTNET_LLM_BASE_URL", group: "model" },
  { key: "DRIFTNET_LLM_API_KEY", group: "model", secret: true },
  { key: "DRIFTNET_LLM_EFFORT", group: "model", choices: ["", "low", "medium", "high", "xhigh"] },
  { key: "TYPESAFE_API_KEY", group: "model", secret: true },
  { key: "DRIFTNET_JUDGE", group: "model", choices: ["", "jev", "rules", "llm", "heuristic", "off"] },
  { key: "GITHUB_TOKEN", group: "model", secret: true },
  { key: "DRIFTNET_LANGUAGE", group: "language", max: 60 },
  { key: "DRIFTNET_LOCALE", group: "language", choices: ["", "en", "zh-TW"] },
  { key: "DRIFTNET_REPLY", group: "chat", choices: ["", "link", "full", "off"] },
  { key: "DRIFTNET_PUBLIC_URL", group: "chat" },
  { key: "DRIFTNET_SUMMARY_DEPTH", group: "model", choices: ["", "brief", "standard", "detailed"] },
  { key: "DRIFTNET_SUMMARY_RULES", group: "rules", multiline: true, max: 1000 },
  { key: "DRIFTNET_BLOCK_DOMAINS", group: "rules", max: 2000 },
  // Outgoing webhook: the URL is secret-ish (tokens often live in it), so it is masked like a key.
  { key: "DRIFTNET_WEBHOOK_URL", group: "webhook", secret: true },
  { key: "DRIFTNET_WEBHOOK_SECRET", group: "webhook", secret: true, max: 200 },
  { key: "DRIFTNET_WEBHOOK_ALLOW_LOCAL", group: "webhook", choices: ["", "1"] },
  // Scheduled digest: times are the server's local time (TZ is respected). Read every minute, so no restart.
  { key: "DRIFTNET_DIGEST", group: "digest", choices: ["", "off", "daily", "weekly"] },
  { key: "DRIFTNET_DIGEST_AT", group: "digest", max: 5 },
  { key: "DRIFTNET_DIGEST_DAY", group: "digest", choices: ["", ...DAYS] },
  { key: "DRIFTNET_DIGEST_TO", group: "digest", max: 500 },
  // Access: the page shows these in their own panel (password strength, share key, public URL).
  { key: "DRIFTNET_TOKEN", group: "access", secret: true, min: 8, max: 200 },
  { key: "DRIFTNET_READ_KEY", group: "access", min: 16, max: 200 },
  { key: "DRIFTNET_ACCESS", group: "access", choices: ["", "public", "private"] },
  { key: "DRIFTNET_HEALTH", group: "rules", choices: ["", "off", "weekly"] },
  { key: "DRIFTNET_REPLY_STYLE", group: "chat", choices: ["", "rich", "text"] },
  // Video understanding (captions, on-screen text, speech) with local tools; see README "Reels and shorts".
  { key: "DRIFTNET_VIDEO", group: "rules", choices: ["", "auto", "captions", "off"] },
  { key: "DRIFTNET_YTDLP", group: "rules", max: 500 },
  { key: "DRIFTNET_FFMPEG", group: "rules", max: 500 },
  { key: "DRIFTNET_TESSERACT", group: "rules", max: 500 },
  { key: "DRIFTNET_WHISPER", group: "rules", max: 500 },
  // Cloud providers (bedrock, vertex) and the rules judge. Keys are write-only like the other secrets;
  // the credentials setting is a file path, never the key itself.
  { key: "DRIFTNET_LLM_REGION", group: "model", max: 60 },
  { key: "AWS_ACCESS_KEY_ID", group: "model", secret: true },
  { key: "AWS_SECRET_ACCESS_KEY", group: "model", secret: true },
  { key: "AWS_SESSION_TOKEN", group: "model", secret: true, max: 4000 },
  { key: "AWS_BEARER_TOKEN_BEDROCK", group: "model", secret: true, max: 4000 },
  { key: "GOOGLE_CLOUD_PROJECT", group: "model", max: 100 },
  { key: "DRIFTNET_VERTEX_CREDENTIALS", group: "model", max: 500 },
  { key: "DRIFTNET_JUDGE_RULES", group: "rules", max: 500 },
  // Search by meaning (optional embeddings). Off unless a local Ollama has the model or a provider is named.
  { key: "DRIFTNET_EMBED", group: "model", choices: ["", "auto", "off"] },
  { key: "DRIFTNET_EMBED_PROVIDER", group: "model", choices: ["", "ollama", "openai", "gemini"] },
  { key: "DRIFTNET_EMBED_MODEL", group: "model", max: 100 },
  { key: "DRIFTNET_EMBED_BASE_URL", group: "model" },
  { key: "DRIFTNET_EMBED_API_KEY", group: "model", secret: true },
  { key: "DRIFTNET_EMBED_FLOOR", group: "model", max: 5 },
];

export class SettingsError extends Error {}

export interface SettingsView {
  file: string;
  settings: { key: string; group: string; value?: string; set: boolean; locked: boolean; secret: boolean; choices?: readonly string[]; multiline: boolean }[];
}

export class Settings {
  readonly file: string;

  /** `locked`: keys the process environment already sets (systemd, Docker, the shell) — the file can't override them. */
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly locked: ReadonlySet<string>) {
    this.file = join(driftnetHome(env), ".env");
  }

  view(): SettingsView {
    return {
      file: this.file,
      settings: SETTINGS.map((s) => ({
        key: s.key,
        group: s.group,
        // A secret never leaves the server; the page only learns whether it is set.
        ...(s.secret ? {} : { value: this.env[s.key] ?? "" }),
        set: !!this.env[s.key],
        locked: this.locked.has(s.key),
        secret: !!s.secret,
        ...(s.choices ? { choices: s.choices } : {}),
        multiline: !!s.multiline,
      })),
    };
  }

  /**
   * Apply changes: a string sets the value, null clears it. An empty string
   * for a secret means "unchanged" (the page never had the old value).
   * Returns the keys that changed.
   */
  update(changes: Record<string, unknown>): string[] {
    const next = new Map<string, string | null>();
    for (const [key, raw] of Object.entries(changes)) {
      const s = SETTINGS.find((x) => x.key === key);
      if (!s) throw new SettingsError(`${key} can't be changed here`);
      if (this.locked.has(key)) throw new SettingsError(`${key} is set by the environment driftnet runs in; change it there`);
      if (raw !== null && typeof raw !== "string") throw new SettingsError(`${key} must be text`);
      let value = raw === null ? null : raw.trim();
      if (s.secret && value === "") continue;
      if (value === "") value = null;
      // Unchanged: nothing to validate (the file may hold a value from before a rule changed).
      if ((this.env[key] ?? null) === value) continue;
      if (value !== null) {
        if (s.choices && !s.choices.includes(value)) throw new SettingsError(`${key} must be one of ${s.choices.filter(Boolean).join(", ")}`);
        if (value.length > (s.max ?? 500)) throw new SettingsError(`${key} is too long`);
        if (s.min && value.length < s.min) throw new SettingsError(`${key} needs at least ${s.min} characters`);
        if (s.key === "DRIFTNET_TOKEN" && /\s/.test(value)) throw new SettingsError("the password can't contain spaces");
        if (value.includes("`")) throw new SettingsError(`${key} can't contain a backtick`);
        if (!s.multiline && /[\r\n]/.test(value)) throw new SettingsError(`${key} must be one line`);
        if (key === "DRIFTNET_DIGEST_AT" && !validTime(value)) throw new SettingsError(`${key} must be a time like 09:00`);
        if (key === "DRIFTNET_DIGEST_TO") {
          const { invalid } = parseTargets(value);
          if (invalid.length) throw new SettingsError(`${key}: not a valid target: ${invalid.join(", ")} (use telegram:<chat id>, discord:<channel id>, slack:<channel id>, line:<id>)`);
        }
        if (/URL$/.test(key) && !/^https?:\/\/\S+$/.test(value)) throw new SettingsError(`${key} must be an http(s) URL`);
      }
      next.set(key, value);
    }
    if (!next.size) return [];
    this.write(next);
    for (const [key, value] of next) {
      if (value === null) delete this.env[key];
      else this.env[key] = value;
    }
    return [...next.keys()];
  }

  /** Rewrite only the changed lines of ~/.driftnet/.env; comments and other settings stay. */
  private write(changes: Map<string, string | null>): void {
    const lines = existsSync(this.file) ? readFileSync(this.file, "utf8").split("\n") : [];
    const out: string[] = [];
    const done = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]!)?.[1];
      if (!key || !changes.has(key)) { out.push(lines[i]!); continue; }
      // A multi-line value (backtick-quoted) spans several lines: skip all of them.
      const rest = lines[i]!.slice(lines[i]!.indexOf("=") + 1).trim();
      if (rest.startsWith("`") && !(rest.length > 1 && rest.endsWith("`"))) while (i + 1 < lines.length && !lines[++i]!.trimEnd().endsWith("`"));
      if (!done.has(key)) {
        done.add(key);
        const value = changes.get(key);
        if (value != null) out.push(`${key}=${serialize(value)}`);
      }
    }
    for (const [key, value] of changes) if (!done.has(key) && value != null) out.push(`${key}=${serialize(value)}`);
    writeFileSync(this.file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

/** Plain when safe; otherwise backtick-quoted, which keeps quotes, # and line breaks as they are. */
function serialize(value: string): string {
  return /^[\w.,:/@+\-=*%]*$/.test(value) ? value : `\`${value}\``;
}
