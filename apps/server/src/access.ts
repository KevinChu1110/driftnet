import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { hashToken, type Store } from "@driftnet/core";

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
 * Agents can also carry their own named tokens (see Store.createAgentToken): a
 * write token counts as admin for everything except settings, a read token as
 * the read-only key. Revoking one cuts that agent off and nothing else, and they
 * survive a change of the admin password. Pass the store to the functions below
 * to honour them; without it only the two keys count.
 *
 * DRIFTNET_ACCESS=private makes reads need either key or a token; public leaves reads open.
 */
export const token = (env: NodeJS.ProcessEnv) => env.DRIFTNET_TOKEN || undefined;
export const readKey = (env: NodeJS.ProcessEnv) => env.DRIFTNET_READ_KEY || undefined;
export const isPrivate = (env: NodeJS.ProcessEnv) => env.DRIFTNET_ACCESS === "private";

export function same(given: string | null | undefined, want: string | undefined): boolean {
  if (!given || !want) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim() || null;
const queryKey = (req: IncomingMessage) => new URL(req.url ?? "/", "http://x").searchParams.get("key");

type Agent = { id: string; name: string; scope: "read" | "write" };
/** One lookup per request, including "none": a request asks who it is three or four times. */
const agents = new WeakMap<IncomingMessage, Agent | null>();

/**
 * The agent token in the Authorization header, if it is active. Only a header,
 * never a URL. The lookup is by sha256 of the given value, a fixed-length digest
 * of a random token, so there is nothing to time. Marks the token as used, once
 * per request: the answer is remembered for the rest of it.
 */
export function agentOf(req: IncomingMessage, store: Store | undefined): Agent | null {
  const cached = agents.get(req);
  if (cached !== undefined) return cached;
  const given = bearer(req);
  if (!store || !given) return null;
  const found = store.findAgentToken(hashToken(given));
  if (found) store.touchAgentToken(found.id);
  agents.set(req, found);
  return found;
}

/**
 * Who to write in the audit columns: "agent:<token id>", or "admin" for the
 * password, this machine, or anyone at all while no password is set. Undefined
 * for a caller the write routes would refuse anyway.
 */
export function actorOf(req: IncomingMessage, env: NodeJS.ProcessEnv, store: Store | undefined): string | undefined {
  const a = agentOf(req, store);
  if (a) return `agent:${a.id}`;
  return isPassword(req, env) || isTrustedLocal(req) ? "admin" : undefined;
}

/** Writes and everything else that changes state. With no admin password set, anyone who can reach the server. */
export function isAdmin(req: IncomingMessage, env: NodeJS.ProcessEnv, store?: Store): boolean {
  const t = token(env);
  return !t || same(bearer(req), t) || agentOf(req, store)?.scope === "write";
}

/** The admin password itself (or no password at all), not an agent token: settings and token management. */
export function isPassword(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  const t = token(env);
  return !t || same(bearer(req), t);
}

/**
 * Reads. Accepts the admin password as a header, or the read-only key as a
 * header or as ?key=. The admin password is never accepted in a URL, where it
 * would end up in history, logs and chat transcripts.
 */
export function canRead(req: IncomingMessage, env: NodeJS.ProcessEnv, store?: Store): boolean {
  if (!isPrivate(env) || isAdmin(req, env, store)) return true;
  const k = readKey(env);
  return same(bearer(req), k) || same(queryKey(req), k) || !!agentOf(req, store);
}

/** A read-only caller: has the share key or a read token, not the admin password or a write token. */
export function readOnly(req: IncomingMessage, env: NodeJS.ProcessEnv, store?: Store): boolean {
  return !!token(env) && !isAdmin(req, env, store);
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const hostOf = (url: string | undefined): string | undefined => {
  try { return url ? new URL(url).host.toLowerCase() : undefined; } catch { return undefined; }
};

/**
 * DNS rebinding guard. Without an admin password a web page could point its own
 * domain at 127.0.0.1 and read the catalogue through the browser, so the Host
 * header must name this machine, the public or tunnel address, or a host in
 * DRIFTNET_ALLOWED_HOSTS. With a password set, the password is the defence.
 */
export function hostAllowed(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  if (token(env)) return true;
  const host = (req.headers.host ?? "").toLowerCase();
  if (LOOPBACK_HOST.test(host)) return true;
  const allowed = [hostOf(env.DRIFTNET_PUBLIC_URL), hostOf(env.DRIFTNET_TUNNEL_URL), ...(env.DRIFTNET_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase())];
  return !!host && allowed.includes(host);
}

/**
 * The address to count wrong passwords against: the socket peer, unless that is
 * a local proxy or tunnel, which says who it forwarded in cf-connecting-ip or
 * the last (the proxy's own) x-forwarded-for entry. Anything else is spoofable.
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? "?";
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return peer;
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  };
  return header("cf-connecting-ip") ?? header("x-forwarded-for")?.split(",").pop()?.trim() ?? peer;
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

/**
 * This machine acting on purpose: local (see isLocal) and not a request another
 * website's page made the browser send (a foreign Origin). Whoever can use this
 * machine can already read ~/.driftnet/.env, so it may set or reset the admin
 * password without knowing the old one — the way out when it is forgotten.
 */
export function isTrustedLocal(req: IncomingMessage): boolean {
  if (!isLocal(req)) return false;
  const origin = req.headers.origin;
  const host = req.headers.host ?? "";
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

/**
 * A request another website's page made the browser send. Browsers always add
 * Origin to cross-site POSTs; the page itself sends its own origin, the Chrome
 * extension sends chrome-extension://…, and curl, MCP clients and chat
 * platforms send none.
 */
export function foreignOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin.startsWith("chrome-extension://")) return false;
  const host = req.headers.host ?? "";
  return origin !== `http://${host}` && origin !== `https://${host}`;
}

/** What the page may offer: admin (change things), reader (look only), none (asks for a key). */
export function role(req: IncomingMessage, env: NodeJS.ProcessEnv, store?: Store): "admin" | "reader" | "none" {
  if (isTrustedLocal(req) || (token(env) ? isAdmin(req, env, store) : true)) return "admin";
  return canRead(req, env, store) ? "reader" : "none";
}

/**
 * Where links to cards point: the public address, plus the read-only share key
 * when reading is private, so a link sent to a phone opens without a password.
 * The page stores the key and removes it from the address bar.
 */
export function shareBase(env: NodeJS.ProcessEnv): string | undefined {
  const base = (env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL)?.replace(/\/$/, "");
  if (!base) return undefined;
  const k = readKey(env);
  return isPrivate(env) && k ? `${base}/?key=${encodeURIComponent(k)}` : base;
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
