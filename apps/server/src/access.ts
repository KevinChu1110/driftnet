import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/**
 * Who may do what. Two keys, both read from the environment on every request
 * so the settings page can change them without a restart:
 *
 *   DRIFTNET_TOKEN     the admin password: writes, settings, MCP with every tool.
 *   DRIFTNET_READ_KEY  a read-only share key. Safe to paste into a URL for an AI
 *                      that can only fetch links (…/llms.txt?key=…): if it leaks,
 *                      someone can read the catalogue, nothing more, and a new
 *                      one is a click away.
 *
 * DRIFTNET_ACCESS=private makes reads need either key; public leaves reads open.
 */
export const token = (env: NodeJS.ProcessEnv) => env.DRIFTNET_TOKEN || undefined;
export const readKey = (env: NodeJS.ProcessEnv) => env.DRIFTNET_READ_KEY || undefined;
export const isPrivate = (env: NodeJS.ProcessEnv) => env.DRIFTNET_ACCESS === "private";

function same(given: string | null | undefined, want: string | undefined): boolean {
  if (!given || !want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim() || null;
const queryKey = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").searchParams.get("key");

/** Writes and everything else that changes state. With no admin password set, anyone who can reach the server. */
export function isAdmin(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  const t = token(env);
  return !t || same(bearer(req), t);
}

/**
 * Reads. Accepts the admin password as a header, or the read-only key as a
 * header or as ?key=. The admin password is never accepted in a URL, where it
 * would end up in history, logs and chat transcripts.
 */
export function canRead(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  if (!isPrivate(env) || isAdmin(req, env)) return true;
  const k = readKey(env);
  return same(bearer(req), k) || same(queryKey(req), k);
}

/** A read-only caller: has the share key, not the admin password. */
export function readOnly(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  return !!token(env) && !isAdmin(req, env);
}

/**
 * This very machine, not something forwarded to it: a loopback socket, a
 * loopback Host (which also stops DNS rebinding) and no proxy headers. A tunnel
 * such as cloudflared connects from 127.0.0.1 too, but marks what it forwards.
 */
export function isLocal(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const host = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host ?? "");
  const forwarded = ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "cf-ray"].some((h) => req.headers[h] !== undefined);
  return loopback && host && !forwarded;
}

/** 32 random characters, URL-safe. */
export const newKey = () => randomBytes(24).toString("base64url");

/** Rough password strength, for the warning on the settings page. */
export function strength(password: string): "weak" | "ok" | "strong" {
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(password)).length;
  if (password.length >= 16 && kinds >= 2) return "strong";
  if (password.length >= 12 && kinds >= 3) return "strong";
  if (password.length >= 10 && kinds >= 2) return "ok";
  return "weak";
}

/**
 * A public https URL for this machine through a Cloudflare quick tunnel
 * (cloudflared, no account). driftnet never downloads it: if cloudflared is not
 * installed, the page says how. The URL changes every time the tunnel starts.
 */
export class Tunnel {
  private child: ChildProcess | null = null;
  url: string | null = null;
  error: string | null = null;

  constructor(private readonly port: number, private readonly bin = process.env.DRIFTNET_CLOUDFLARED || "cloudflared") {}

  available(): boolean {
    try {
      return spawnSync(this.bin, ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0;
    } catch {
      return false;
    }
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(timeoutMs = 30_000): Promise<string> {
    if (this.url && this.child) return Promise.resolve(this.url);
    this.error = null;
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`], { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      const timer = setTimeout(() => fail(new Error("cloudflared did not report a URL in time")), timeoutMs);
      const fail = (err: Error) => {
        clearTimeout(timer);
        this.error = err.message;
        this.stop();
        reject(err);
      };
      const scan = (chunk: Buffer) => {
        const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
        if (m && !this.url) {
          clearTimeout(timer);
          this.url = m[0];
          resolve(m[0]);
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.on("error", (err) => fail(err));
      child.on("exit", (code) => {
        if (this.child === child) {
          this.child = null;
          this.url = null;
          if (code) this.error = `cloudflared exited with code ${code}`;
        }
        clearTimeout(timer);
      });
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.url = null;
    child?.kill();
  }
}
