import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mediaSigOk, setMediaSecret, type Driftnet, type loadHomeEnv } from "@driftnet/core";
import { canRead, clientIp, foreignOrigin, hostAllowed, isAdmin, isLocal, isPassword, isTrustedLocal, token, Tunnel } from "./access.ts";
import { Settings } from "./settings.ts";
import { BadRequest, readBody, readJson, type App, type Ctx, type Route } from "./route.ts";
import { routes as digest } from "./routes/digest.ts";
import { routes as folders } from "./routes/folders.ts";
import { routes as importRoutes } from "./routes/import.ts";
import { routes as items } from "./routes/items.ts";
import { routes as notes } from "./routes/notes.ts";
import { routes as settingsRoutes } from "./routes/settings.ts";
import { routes as system } from "./routes/system.ts";

/**
 * Every route, in match order (first match wins, so specific patterns come before
 * catch-alls). A feature adds routes by exporting `routes: Route[]` from its own
 * file and listing it here; `access` is required, so a route cannot be added
 * without saying who may call it.
 */
export const routes: Route[] = [...system, ...folders, ...items, ...importRoutes, ...notes, ...digest, ...settingsRoutes];

const asset = (file: string) => readFileSync(new URL(`../public/${file}`, import.meta.url));

export interface AppOptions {
  dn: Driftnet;
  env: NodeJS.ProcessEnv;
  /** Defaults to one that treats every variable already in `env` as set by the environment. */
  settings?: Settings;
  tunnel?: Tunnel;
  plugins?: string[];
  envFile?: ReturnType<typeof loadHomeEnv>;
  /** Only used to tell the page and the tunnel which port this is; createApp never listens. */
  port?: number;
}

/** Builds the HTTP server and returns it: no listen, no chat bots, no process.exit. The caller starts it. */
export function createApp(opts: AppOptions): Server {
  const { dn, env } = opts;
  const port = opts.port ?? Number(env.PORT ?? 8787);
  // Signs picture paths so <img> works on a private catalogue (see publicMedia).
  setMediaSecret(dn.store.getState("media_secret") ?? (() => { const s = randomBytes(32).toString("base64url"); dn.store.setState("media_secret", s); return s; })());

  /**
   * Writes. Never for another website's page: with no password set everyone is
   * "admin", so without this check any page you visit could write into (and,
   * with open CORS, read) your catalogue.
   */
  const authorized = (req: IncomingMessage) => !foreignOrigin(req) && (isAdmin(req, env, dn.store) || isTrustedLocal(req));
  /** Authorized, and by the admin password (or this machine) rather than an agent token: a leaked token must not mint tokens or change settings. */
  const authorizedAsPassword = (req: IncomingMessage) => authorized(req) && (isPassword(req, env) || isTrustedLocal(req));
  /** No password yet: only this machine itself, never something a tunnel or proxy forwarded. */
  const passwordOk = (req: IncomingMessage) => authorizedAsPassword(req) && (!!token(env) || isLocal(req));
  const settingsShape = (req: IncomingMessage) => {
    const host = req.headers.host ?? "";
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false;
    return req.method === "GET" || /^application\/json\b/.test(req.headers["content-type"] ?? "");
  };

  function signedMedia(path: string, sig: string | null): boolean {
    const m = /^\/api\/media\/(\d+)\/(\d+)$/.exec(path);
    const ref = m ? dn.store.get(Number(m[1]))?.media?.[Number(m[2])] : undefined;
    return !!ref && mediaSigOk(Number(m![1]), Number(m![2]), ref.url, sig);
  }
  const readOk = (req: IncomingMessage, path: string, url: URL) =>
    canRead(req, env, dn.store) || isTrustedLocal(req) || signedMedia(path, url.searchParams.get("s"));

  /**
   * Guessing passwords: after 20 refused attempts that carried a password or key,
   * the same address waits 15 minutes.
   */
  const misses = new Map<string, { n: number; since: number }>();
  const triedCredentials = (req: IncomingMessage) => !!req.headers.authorization || /[?&]key=/.test(req.url ?? "");
  const throttled = (req: IncomingMessage): boolean => {
    const m = misses.get(clientIp(req));
    if (!m) return false;
    if (Date.now() - m.since > 15 * 60_000) { misses.delete(clientIp(req)); return false; }
    return m.n >= 20;
  };
  const miss = (req: IncomingMessage) => {
    const ip = clientIp(req);
    const m = misses.get(ip) ?? { n: 0, since: Date.now() };
    m.n++;
    misses.set(ip, m);
    if (misses.size > 1000) {
      const now = Date.now();
      for (const [k, v] of misses) if (now - v.since > 15 * 60_000) misses.delete(k);
      // Still too many live addresses: drop the oldest, so a flood can't grow memory without bound.
      for (const k of misses.keys()) { if (misses.size <= 10_000) break; misses.delete(k); }
    }
  };

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8", headers: Record<string, string> = {}) {
    const req = res.req;
    if ((status === 401 || status === 403) && req && triedCredentials(req)) miss(req);
    // No CORS headers: the page is same-origin, and agents, the extension and chat platforms aren't browsers' pages.
    res.writeHead(status, { "content-type": type, ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  const app: App = {
    dn, env, port,
    settings: opts.settings ?? new Settings(env, new Set(Object.keys(env).filter((k) => env[k] !== undefined))),
    tunnel: opts.tunnel ?? new Tunnel(port),
    plugins: opts.plugins ?? [],
    envFile: opts.envFile,
    indexHtml: readFileSync(new URL("../public/index.html", import.meta.url), "utf8"),
    /** Icons are public even in private mode: the browser asks for them before any token. */
    assets: {
      "/favicon.svg": [asset("favicon.svg"), "image/svg+xml"],
      "/apple-touch-icon.png": [asset("apple-touch-icon.png"), "image/png"],
      "/icon-512.png": [asset("icon-512.png"), "image/png"],
      "/qr.js": [asset("qr.js"), "text/javascript; charset=utf-8"],
      "/manifest.webmanifest": [asset("manifest.webmanifest"), "application/manifest+json"],
    },
    authorized, settingsShape, throttled, miss,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const reply: Ctx["send"] = (status, body, type, headers) => send(res, status, body, type, headers);
    try {
      if (!hostAllowed(req, env)) return send(res, 421, { error: "unknown host; set DRIFTNET_ALLOWED_HOSTS to use this address, or set an admin password" });
      const method = req.method ?? "GET";
      let route: Route | undefined;
      let m: RegExpExecArray | null = null;
      for (const r of routes) {
        if (!methodMatches(r, method)) continue;
        m = typeof r.pattern === "string" ? (r.pattern === path ? ([path] as RegExpExecArray) : null) : r.pattern.exec(path);
        if (m) { route = r; break; }
      }
      const run = () => route!.handler({ req, res, url, path, m: m!, app, send: reply, json: () => readJson(req), body: (limit) => readBody(req, limit) } as Ctx);
      // The page and its icons: before the throttle and the read gate.
      if (route?.early) return await run();
      // OAuth discovery probes (Claude.ai connectors): there is none, say so plainly instead of "unauthorized".
      if (path.startsWith("/.well-known/")) return send(res, 404, { error: "not found" });
      if (triedCredentials(req) && throttled(req)) return send(res, 429, { error: "too many wrong passwords; try again in 15 minutes" });
      // Reads: every GET (even of a path with no route) except a public route, and any non-GET route declared "read".
      if (route?.access !== "public" && (method === "GET" || route?.access === "read") && !readOk(req, path, url)) return send(res, 401, { error: "unauthorized" });
      if (!route) return send(res, 404, { error: "not found" });
      if (route.access === "write" && !authorized(req)) return send(res, 401, { error: route.denied ?? "unauthorized" });
      if (route.access === "password" && !passwordOk(req)) return send(res, 403, { error: token(env) ? "unauthorized" : route.noPasswordHint ?? "unauthorized" });
      await run();
    } catch (err) {
      if (err instanceof BadRequest) {
        if (!res.headersSent) send(res, 400, { error: err.message });
        return;
      }
      console.error(`[http] ${req.method} ${path}:`, err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  });
  return server;
}

function methodMatches(r: Route, method: string): boolean {
  const want = r.method;
  if (want === "*") return true;
  if (want === "NON_GET") return method !== "GET";
  return Array.isArray(want) ? want.includes(method as never) : want === method;
}
