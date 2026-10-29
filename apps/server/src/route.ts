import type { IncomingMessage, ServerResponse } from "node:http";
import type { Driftnet, loadHomeEnv } from "@driftnet/core";
import type { Settings } from "./settings.ts";
import type { Tunnel } from "./access.ts";

/**
 * Who may call a route. The dispatcher (app.ts) enforces it before the handler runs,
 * so a handler never checks credentials itself and a route cannot forget to.
 *
 *   public   no check: the page, static files, signed webhooks (the handler verifies the signature), pair/claim.
 *   read     the catalogue's read gate: open in public mode, a key or token in private mode.
 *   write    the admin password, a write token, or this machine; never another website's page.
 *   password the admin password itself (or this machine), never an agent token: settings, tokens, pairing.
 *   custom   the handler decides (say why in `why`).
 *
 * Every GET except a `public` route also goes through the read gate, as it always has.
 */
export type Access = "public" | "read" | "write" | "password";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** "*" is any method, "NON_GET" everything but GET (a route that answers 405 for the methods it doesn't know). */
export type Methods = Method | Method[] | "*" | "NON_GET";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  path: string;
  /** The pattern's match: capture groups of a RegExp route. */
  m: RegExpExecArray;
  app: App;
  send: (status: number, body: unknown, type?: string, headers?: Record<string, string>) => void;
  json: <T>() => Promise<T>;
  body: (limit?: number) => Promise<string>;
}
export type Handler = (c: Ctx) => unknown | Promise<unknown>;

type Base = {
  method: Methods;
  handler: Handler;
  /** Served before the throttle and the read gate (the page and its icons: the browser asks before any token). */
  early?: boolean;
  /** `write`: the 401 message, when it should say more than "unauthorized". */
  denied?: string;
  /** `password`: the 403 message while no password is set (the way to turn the feature on). */
  noPasswordHint?: string;
};
type Pattern = { pattern: string } | { pattern: RegExp; /** A path the pattern matches, so tests can call the route. */ example: string };
type Level = { access: Access } | { access: "custom"; why: string };
export type Route = Base & Pattern & Level;

/** Everything a route may need; built once by createApp. */
export interface App {
  dn: Driftnet;
  env: NodeJS.ProcessEnv;
  settings: Settings;
  tunnel: Tunnel;
  plugins: string[];
  envFile: ReturnType<typeof loadHomeEnv>;
  port: number;
  indexHtml: string;
  assets: Record<string, [Buffer, string]>;
  authorized: (req: IncomingMessage) => boolean;
  /** The settings page's extra rule: a same-origin request, JSON on anything but GET. */
  settingsShape: (req: IncomingMessage) => boolean;
  throttled: (req: IncomingMessage) => boolean;
  miss: (req: IncomingMessage) => void;
}

export class BadRequest extends Error {}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new BadRequest("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** JSON request body; malformed input is the client's error (400), not ours. */
export async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}
