import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BlockedUrl, canonicalize, FolderError, LOCALES, createDriftnet, loadPlugins, type Locale, defaultDbPath, driftnetHome, loadHomeEnv, resolveLocale, WORTH, type Kind, type PageContent, type Worth } from "@driftnet/core";
import { handleChatText } from "./adapters/handle.ts";
import { handleLine } from "./adapters/line.ts";
import { handleSlack, startSlackSocket } from "./adapters/slack.ts";
import { startTelegram } from "./adapters/telegram.ts";
import { startDiscord } from "./adapters/discord.ts";
import { createMcpServer } from "./mcp.ts";
import { collect, toMarkdown, toVault, zip } from "./export.ts";
import { Settings, SettingsError } from "./settings.ts";
import { llmsTxt, openApi } from "./feeds.ts";

const env = process.env;
// Settings the environment itself provides (systemd, Docker, the shell) win over the file; the page shows them read-only.
const fromEnvironment = new Set(Object.keys(env).filter((k) => env[k] !== undefined));
const envFile = loadHomeEnv(env);
const plugins = await loadPlugins(env);
const dn = createDriftnet();
const settings = new Settings(env, fromEnvironment);
const PORT = Number(env.PORT ?? 8787);
// Loopback by default: put a reverse proxy (Caddy, nginx, a tunnel) in front to expose it.
const HOST = env.DRIFTNET_HOST ?? "127.0.0.1";
const TOKEN = env.DRIFTNET_TOKEN;
/**
 * public  — anyone can read the catalogue; writes need DRIFTNET_TOKEN.
 * private — every read needs the token too (the web page asks for it once).
 */
const PRIVATE = env.DRIFTNET_ACCESS === "private";
if (PRIVATE && !TOKEN) {
  console.error("DRIFTNET_ACCESS=private needs DRIFTNET_TOKEN to be set");
  process.exit(1);
}
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
/** Icons are public even in private mode: the browser asks for them before any token. */
const STATIC: Record<string, [Buffer, string]> = {
  "/favicon.svg": [readFileSync(new URL("../public/favicon.svg", import.meta.url)), "image/svg+xml"],
  "/apple-touch-icon.png": [readFileSync(new URL("../public/apple-touch-icon.png", import.meta.url)), "image/png"],
  "/icon-512.png": [readFileSync(new URL("../public/icon-512.png", import.meta.url)), "image/png"],
  "/manifest.webmanifest": [readFileSync(new URL("../public/manifest.webmanifest", import.meta.url)), "application/manifest+json"],
};

/** Writes (ingest, feedback, MCP) need DRIFTNET_TOKEN when it is set; reads are public. */
function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * The settings page can point the model at another URL with your key, so it
 * needs more than a write: the token when one is set, and without a token only
 * this machine (by Host, which also stops DNS rebinding). The JSON content type
 * forces a CORS preflight, which this server never grants, and a foreign
 * Origin is refused outright.
 */
function settingsAllowed(req: IncomingMessage): boolean {
  if (!authorized(req)) return false;
  const host = req.headers.host ?? "";
  if (!TOKEN && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false;
  return req.method === "GET" || /^application\/json\b/.test(req.headers["content-type"] ?? "");
}

class BadRequest extends Error {}

/** JSON request body; malformed input is the client's error (400), not ours. */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req);
  try {
    return (raw ? JSON.parse(raw) : {}) as T;
  } catch {
    throw new BadRequest("body is not valid JSON");
  }
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new BadRequest("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  try {
    // The page itself holds no data; in private mode it asks for the token.
    if (req.method === "GET" && path === "/") return send(res, 200, indexHtml, "text/html; charset=utf-8");
    const asset = req.method === "GET" ? STATIC[path] : undefined;
    if (asset) {
      res.writeHead(200, { "content-type": asset[1], "cache-control": "public, max-age=86400" });
      return res.end(asset[0]);
    }
    if (PRIVATE && req.method === "GET" && !authorized(req)) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && path === "/llms.txt") return send(res, 200, llmsTxt(dn), "text/plain; charset=utf-8");
    if (req.method === "GET" && path === "/openapi.json") return send(res, 200, openApi(`${url.protocol}//${url.host}`));
    if (req.method === "GET" && path === "/api/categories") return send(res, 200, dn.categories);
    if (req.method === "GET" && path === "/api/ui") {
      // Folder names in every locale, for clients that switch language themselves (web page, extension).
      const categories = Object.fromEntries(
        dn.store.folders().map((f) => [f.id, Object.fromEntries(LOCALES.map((l) => [l, dn.folderLabel(f.id, l)]))]),
      );
      // First run: nothing configured yet, so the page opens the settings to get started.
      const setup = !envFile && dn.engines.summarizer === "off" && dn.engines.judge === "heuristic" && !dn.store.stats().items;
      return send(res, 200, { locale: resolveLocale(), categories, setup });
    }

    // ── The reader's folder tree ──────────────────────────────────────────
    if (req.method === "GET" && path === "/api/folders") {
      return send(res, 200, dn.store.folders().map((f) => ({ ...f, label: Object.fromEntries(LOCALES.map((l) => [l, dn.folderLabel(f.id, l)])) })));
    }
    const folderMatch = /^\/api\/folders(?:\/([^/]+))?$/.exec(path);
    if (folderMatch && req.method !== "GET") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = folderMatch[1] ? decodeURIComponent(folderMatch[1]) : null;
      try {
        if (req.method === "POST" && !id) {
          const body = await readJson<{ name?: string; description?: string; parent?: string | null }>(req);
          return send(res, 200, dn.store.createFolder({ name: String(body.name ?? ""), ...(body.description ? { description: String(body.description) } : {}), parent: body.parent ?? null }));
        }
        if (req.method === "PATCH" && id) {
          const body = await readJson<{ name?: string; description?: string; parent?: string | null; position?: number }>(req);
          return send(res, 200, dn.store.updateFolder(id, body));
        }
        if (req.method === "DELETE" && id) {
          dn.store.deleteFolder(id);
          return send(res, 200, { ok: true });
        }
      } catch (err) {
        if (err instanceof FolderError) return send(res, 400, { error: err.message });
        throw err;
      }
      return send(res, 405, { error: "method not allowed" });
    }
    const moveMatch = /^\/api\/items\/(\d+)\/move$/.exec(path);
    if (req.method === "POST" && moveMatch) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const { folder } = await readJson<{ folder?: string }>(req);
      try {
        return dn.store.moveItem(Number(moveMatch[1]), String(folder ?? ""))
          ? send(res, 200, dn.store.get(Number(moveMatch[1])))
          : send(res, 404, { error: "not found" });
      } catch (err) {
        if (err instanceof FolderError) return send(res, 400, { error: err.message });
        throw err;
      }
    }
    if (req.method === "GET" && path === "/api/stats") return send(res, 200, { ...dn.store.stats(), engines: dn.engines });

    if (req.method === "GET" && path === "/api/items") {
      const p = url.searchParams;
      const minWorth = p.get("minWorth");
      const list = dn.store.list({
        ...(p.get("q") ? { q: p.get("q")! } : {}),
        ...(p.get("category") ? { category: p.get("category")! } : {}),
        ...(p.get("kind") ? { kind: p.get("kind") as Kind } : {}),
        ...(minWorth && (WORTH as readonly string[]).includes(minWorth) ? { minWorth: minWorth as Worth } : {}),
        ...(p.get("since") ? { since: p.get("since")! } : {}),
        ...(p.get("view") === "favorites" || p.get("view") === "trash" ? { view: p.get("view") as "favorites" | "trash" } : {}),
        ...(["best", "newest", "shared"].includes(p.get("sort") ?? "") ? { sort: p.get("sort") as "best" | "newest" | "shared" } : {}),
        clean: p.get("all") !== "1",
        limit: Number(p.get("limit") ?? 200),
      });
      // Tools found inside each item (repos a post named or linked), by name.
      const names = new Map(list.map((i) => [i.id, i.summary?.name ?? i.title]));
      const found = new Map<number, { id: number; name: string }[]>();
      for (const { parent, child } of dn.store.foundLinks()) {
        if (!names.has(parent)) continue;
        const name = names.get(child) ?? dn.store.get(child)?.summary?.name ?? dn.store.get(child)?.title;
        if (name && !dn.store.get(child)?.trashedAt) found.set(parent, [...(found.get(parent) ?? []), { id: child, name }]);
      }
      // What people wrote around the link when they shared it.
      const said = dn.store.chatNotes(list.map((i) => i.id));
      return send(res, 200, list.map((i) => ({ ...i, found: found.get(i.id) ?? [], said: said.get(i.id) ?? [] })));
    }
    const noteMatch = /^\/api\/items\/(\d+)\/note$/.exec(path);
    if (req.method === "PUT" && noteMatch) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const { note } = await readJson<{ note?: string }>(req);
      const id = Number(noteMatch[1]);
      return dn.store.setNote(id, String(note ?? "")) ? send(res, 200, dn.store.get(id)) : send(res, 404, { error: "not found" });
    }

    // ── Free-standing notes ───────────────────────────────────────────────
    if (req.method === "GET" && path === "/api/notes") return send(res, 200, dn.store.listNotes(url.searchParams.get("q") ?? undefined));
    const notesMatch = /^\/api\/notes(?:\/(\d+))?$/.exec(path);
    if (notesMatch && req.method !== "GET") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = notesMatch[1] ? Number(notesMatch[1]) : undefined;
      if (req.method === "DELETE" && id) return dn.store.deleteNote(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
      if ((req.method === "POST" && !id) || (req.method === "PUT" && id)) {
        const body = await readJson<{ title?: string; body?: string }>(req);
        const note = dn.store.saveNote({ ...(id ? { id } : {}), title: String(body.title ?? ""), body: String(body.body ?? "") });
        return note ? send(res, 200, note) : send(res, 404, { error: "not found" });
      }
      return send(res, 405, { error: "method not allowed" });
    }

    // ── Settings page ─────────────────────────────────────────────────────
    if (path === "/api/settings" && (req.method === "GET" || req.method === "PUT")) {
      if (!settingsAllowed(req)) {
        return send(res, 403, { error: TOKEN ? "unauthorized" : "settings can only be changed from this machine; set DRIFTNET_TOKEN to change them remotely" });
      }
      if (req.method === "PUT") {
        try {
          const changed = settings.update((await readJson<{ values?: Record<string, unknown> }>(req)).values ?? {});
          if (changed.length) dn.reconfigure(env);
          return send(res, 200, { ...settings.view(), changed, engines: dn.engines });
        } catch (err) {
          if (err instanceof SettingsError) return send(res, 400, { error: err.message });
          throw err;
        }
      }
      return send(res, 200, { ...settings.view(), engines: dn.engines, plugins });
    }

    // ── Export: one Markdown file, or a zip vault for Obsidian / Notion ───
    if (req.method === "GET" && path === "/api/export") {
      const lang = url.searchParams.get("lang");
      const data = collect(dn, (LOCALES as readonly string[]).includes(lang ?? "") ? (lang as Locale) : resolveLocale());
      const day = new Date().toISOString().slice(0, 10);
      if (url.searchParams.get("format") === "vault") {
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="driftnet-${day}.zip"` });
        return res.end(zip(toVault(data)));
      }
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="driftnet-${day}.md"` });
      return res.end(toMarkdown(data));
    }
    const itemMatch = /^\/api\/items\/(\d+)(\/feedback)?$/.exec(path);
    if (req.method === "GET" && itemMatch && !itemMatch[2]) {
      const item = dn.store.get(Number(itemMatch[1]));
      return item ? send(res, 200, item) : send(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && path === "/api/ingest") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readJson<{
        text?: string; url?: string; note?: string; chat?: string; platform?: string; page?: PageContent;
      }>(req);
      const ctx = {
        platform: /^[a-z0-9-]{1,32}$/.test(body.platform ?? "") ? body.platform! : "http",
        chatId: String(body.chat ?? "api").slice(0, 64),
      };
      // A single URL with what the browser saw on it (the Chrome extension).
      const url = body.page && body.url ? canonicalize(body.url) : null;
      if (url) {
        const page: PageContent = {
          ...(typeof body.page!.title === "string" ? { title: body.page!.title.slice(0, 300) } : {}),
          ...(typeof body.page!.text === "string" ? { text: body.page!.text.slice(0, 20_000) } : {}),
          ...(Array.isArray(body.page!.links) ? { links: body.page!.links.filter((l) => typeof l === "string").slice(0, 50) } : {}),
        };
        const note = body.note?.slice(0, 1000);
        try {
          return send(res, 200, [await dn.pipeline.ingest(url, { ...ctx, ...(note ? { note } : {}) }, 0, page)]);
        } catch (err) {
          if (err instanceof BlockedUrl) return send(res, 422, { error: err.message });
          throw err;
        }
      }
      const text = [body.url, body.text, body.note].filter(Boolean).join(" ");
      return send(res, 200, await dn.pipeline.ingestMessage(text, ctx));
    }
    if (req.method === "POST" && itemMatch?.[2]) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = Number(itemMatch[1]);
      if (!dn.store.get(id)) return send(res, 404, { error: "not found" });
      const body = await readJson<{ vote: "up" | "down"; reason?: string; voter?: string }>(req);
      dn.store.vote(id, body.vote === "up" ? 1 : -1, body.voter ?? "http", body.reason);
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/webhooks/line" && env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN) {
      const status = await handleLine(
        dn, await readBody(req), req.headers["x-line-signature"] as string | undefined,
        env.LINE_CHANNEL_SECRET, env.LINE_CHANNEL_ACCESS_TOKEN,
      );
      return send(res, status, {});
    }
    if (req.method === "POST" && path === "/webhooks/slack" && env.SLACK_SIGNING_SECRET && env.SLACK_BOT_TOKEN) {
      const raw = await readBody(req);
      // Slack re-sends events it thinks we missed; we already acked the first one.
      if (req.headers["x-slack-retry-num"]) return send(res, 200, {});
      const r = await handleSlack(
        dn, raw,
        { timestamp: req.headers["x-slack-request-timestamp"] as string, signature: req.headers["x-slack-signature"] as string },
        env.SLACK_SIGNING_SECRET, env.SLACK_BOT_TOKEN,
      );
      return send(res, r.status, r.body ?? "", "text/plain");
    }

    // MCP over Streamable HTTP, stateless: a fresh server per request.
    if (path === "/mcp") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const agent = (req.headers["x-driftnet-agent"] as string | undefined)?.slice(0, 40) ?? "agent";
      const mcp = createMcpServer(dn, agent);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      const body = req.method === "POST" ? await readJson(req) : undefined;
      return await transport.handleRequest(req, res, body);
    }

    // The agent queue. Always needs the token: taking work leases items.
    if (req.method === "POST" && path === "/api/pending") {
      if (!TOKEN || !authorized(req)) return send(res, 401, { error: "unauthorized (set DRIFTNET_TOKEN)" });
      const body = await readJson<{ limit?: number; agent?: string }>(req);
      const agent = `agent:${String(body.agent ?? "http").slice(0, 40)}`;
      const items = dn.store.claimPending(agent, Number(body.limit ?? 5));
      return send(res, 200, {
        pending: dn.store.pendingCount(),
        language: env.DRIFTNET_LANGUAGE || "English",
        categories: Object.keys(dn.categories),
        folders: dn.categories,
        ...(env.DRIFTNET_SUMMARY_RULES?.trim() ? { rules: env.DRIFTNET_SUMMARY_RULES.trim() } : {}),
        items: items.map((i) => ({ id: i.id, url: i.url, title: i.title, kind: i.kind, category_guess: i.category, shared_with: dn.store.notes(i.id) })),
      });
    }
    // Library actions from the web page: trash / restore / favorite / unfavorite.
    const actionMatch = /^\/api\/items\/(\d+)\/(trash|restore|favorite|unfavorite)$/.exec(path);
    if (req.method === "POST" && actionMatch) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = Number(actionMatch[1]);
      const action = actionMatch[2];
      const ok =
        action === "trash" || action === "restore"
          ? dn.store.setTrashed(id, action === "trash")
          : dn.store.setFavorite(id, action === "favorite");
      return ok ? send(res, 200, dn.store.get(id)) : send(res, 404, { error: "not found" });
    }

    const enrichMatch = /^\/api\/items\/(\d+)\/enrich$/.exec(path);
    if (req.method === "POST" && enrichMatch) {
      if (!TOKEN || !authorized(req)) return send(res, 401, { error: "unauthorized (set DRIFTNET_TOKEN)" });
      const body = await readJson<Record<string, unknown>>(req);
      const agent = `agent:${String(body.agent ?? "http").slice(0, 40)}`;
      delete body.agent;
      const r = await dn.pipeline.enrich(Number(enrichMatch[1]), body, agent);
      return r.ok ? send(res, 200, r.result) : send(res, 422, { error: r.error });
    }

    // Plain-text endpoint for scripts and bots we don't have an adapter for yet.
    if (req.method === "POST" && path === "/api/chat") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = await readJson<{ text: string; platform?: string; chat?: string; user?: string }>(req);
      if (typeof body.text !== "string") throw new BadRequest("text is required");
      const reply = await handleChatText(dn, body.text, {
        platform: body.platform ?? "http", chatId: body.chat ?? "api", ...(body.user ? { userId: body.user } : {}),
      });
      return send(res, 200, { reply });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof BadRequest) {
      if (!res.headersSent) send(res, 400, { error: err.message });
      return;
    }
    console.error(`[http] ${req.method} ${path}:`, err);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${PORT} is already in use. Is driftnet already running? (pnpm service:status) Or set PORT in ${driftnetHome(env)}/.env.`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`driftnet on http://${HOST}:${PORT}  judge=${dn.engines.judge}  summarizer=${dn.engines.summarizer}`);
  for (const w of dn.warnings) console.warn(`⚠️  ${w}`);
  console.log(`settings: ${envFile ?? `none (create ${driftnetHome(env)}/.env, or open the page's ⚙ Settings)`}  data: ${env.DRIFTNET_DB ?? defaultDbPath(env)}`);
  if (plugins.length) console.log(`plugins: ${plugins.join(", ")}`);
  void suggestLocalModel();
  // First run in a terminal: open the page, where ⚙ Settings walks through the rest.
  if (!envFile && process.stdout.isTTY && env.DRIFTNET_OPEN !== "0" && !env.CI) openBrowser(`http://localhost:${PORT}/`);
  if (env.TELEGRAM_BOT_TOKEN) startTelegram(dn, env.TELEGRAM_BOT_TOKEN);
  if (env.DISCORD_BOT_TOKEN) startDiscord(dn, env.DISCORD_BOT_TOKEN);
  if (env.LINE_CHANNEL_SECRET) console.log("[line] webhook at /webhooks/line");
  if (env.SLACK_APP_TOKEN && env.SLACK_BOT_TOKEN) startSlackSocket(dn, env.SLACK_APP_TOKEN, env.SLACK_BOT_TOKEN);
  else if (env.SLACK_SIGNING_SECRET) console.log("[slack] webhook at /webhooks/slack");
});

function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(command, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // no browser here (a server); the URL is printed above
  }
}

/** Running with no model while Ollama sits right there: say how to use it. */
async function suggestLocalModel(): Promise<void> {
  if (env.DRIFTNET_LLM_PROVIDER) return;
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1000) });
    const { models } = (await res.json()) as { models?: { name: string }[] };
    if (!models?.length) return;
    console.log(
      `tip: Ollama is running locally. To summarise without any cloud model, add to ${driftnetHome(env)}/.env:\n` +
        `  DRIFTNET_LLM_PROVIDER=openai\n  DRIFTNET_LLM_BASE_URL=http://127.0.0.1:11434/v1\n  DRIFTNET_LLM_MODEL=${models[0]!.name}`,
    );
  } catch {
    // no Ollama — nothing to suggest
  }
}
