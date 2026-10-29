import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LOCALES, resolveLocale, type Locale } from "@driftnet/core";
import { actorOf, canRead, isLocal, isPrivate, readKey, role, token } from "../access.ts";
import { handleChatText } from "../adapters/handle.ts";
import { handleLine } from "../adapters/line.ts";
import { handleSlack } from "../adapters/slack.ts";
import { collect, toMarkdown, toVault, zip } from "../export.ts";
import { atomFeed, llmsTxt, openApi } from "../feeds.ts";
import { createMcpServer } from "../mcp.ts";
import { updateNotice } from "../update.ts";
import { BadRequest, type Route } from "../route.ts";

const PAGE_HEADERS = {
  "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** The page, its icons, the machine-readable descriptions, export, chat webhooks and MCP. */
export const routes: Route[] = [
  // The page itself holds no data; in private mode it asks for the token.
  {
    method: "GET", pattern: "/", access: "public", early: true,
    handler: ({ send, app }) => send(200, app.indexHtml, "text/html; charset=utf-8", PAGE_HEADERS),
  },
  // Icons are public even in private mode: the browser asks for them before any token.
  {
    method: "GET", pattern: /^\/(favicon\.svg|apple-touch-icon\.png|icon-512\.png|qr\.js|manifest\.webmanifest)$/, example: "/favicon.svg", access: "public", early: true,
    handler: ({ res, path, app }) => {
      const asset = app.assets[path]!;
      res.writeHead(200, { "content-type": asset[1], "cache-control": "public, max-age=86400" });
      return res.end(asset[0]);
    },
  },
  { method: "GET", pattern: "/llms.txt", access: "read", handler: ({ send, app }) => send(200, llmsTxt(app.dn), "text/plain; charset=utf-8") },
  {
    method: "GET", pattern: "/feed.xml", access: "read",
    handler: ({ url, send, app: { dn, env } }) => {
      const folder = url.searchParams.get("folder") || undefined;
      if (folder && !dn.store.folders().some((f) => f.id === folder)) return send(404, { error: "no such folder" });
      const base = (env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL)?.replace(/\/$/, "") || undefined;
      const k = readKey(env);
      // Cards link to the page (with the share key when private, so a phone opens them), or to the tool itself.
      const pageBase = base ? (isPrivate(env) && k ? `${base}/?key=${encodeURIComponent(k)}` : base) : undefined;
      const self = `${base ?? `${url.protocol}//${url.host}`}/feed.xml${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`;
      return send(200, atomFeed(dn, { self, pageBase, folder }), "application/atom+xml; charset=utf-8");
    },
  },
  {
    method: "GET", pattern: "/openapi.json", access: "read",
    handler: ({ url, send, app: { env } }) => send(200, openApi(env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL || `${url.protocol}//${url.host}`)),
  },
  { method: "GET", pattern: "/api/categories", access: "read", handler: ({ send, app }) => send(200, app.dn.categories) },
  {
    method: "GET", pattern: "/api/ui", access: "read",
    handler: ({ req, send, app: { dn, env, envFile, port } }) => {
      // Folder names in every locale, for clients that switch language themselves (web page, extension).
      const categories = Object.fromEntries(
        dn.store.folders().map((f) => [f.id, Object.fromEntries(LOCALES.map((l) => [l, dn.folderLabel(f.id, l)]))]),
      );
      // First run: nothing configured yet, so the page opens the settings to get started.
      const setup = !envFile && dn.engines.summarizer === "off" && dn.engines.judge === "heuristic" && !dn.store.stats().items;
      return send(200, {
        locale: resolveLocale(), categories, setup, role: role(req, env, dn.store), local: isLocal(req), passwordSet: !!token(env),
        port, summaries: dn.engines.summarizer !== "off",
      });
    },
  },
  {
    method: "GET", pattern: "/api/stats", access: "read",
    handler: ({ send, app: { dn, env } }) => {
      // update: only when the last daily check found a newer release (no network here); the page shows it as a dismissible notice.
      const update = updateNotice(dn.store, env);
      return send(200, { ...dn.store.stats(), inbox: dn.store.inboxCount(), review: dn.store.reviewCount(), engines: dn.engines, ...(update ? { update } : {}) });
    },
  },
  // Export: one Markdown file, or a zip vault for Obsidian / Notion.
  {
    method: "GET", pattern: "/api/export", access: "read",
    handler: ({ url, res, app: { dn } }) => {
      const lang = url.searchParams.get("lang");
      const data = collect(dn, (LOCALES as readonly string[]).includes(lang ?? "") ? (lang as Locale) : resolveLocale());
      const day = new Date().toISOString().slice(0, 10);
      if (url.searchParams.get("format") === "vault") {
        res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="driftnet-${day}.zip"` });
        return res.end(zip(toVault(data)));
      }
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="driftnet-${day}.md"` });
      return res.end(toMarkdown(data));
    },
  },
  // Chat webhooks: the handlers verify the platform's signature, there is no password. Only live when configured.
  {
    method: "POST", pattern: "/webhooks/line", access: "public",
    handler: async ({ req, send, body, app: { dn, env } }) => {
      if (!env.LINE_CHANNEL_SECRET || !env.LINE_CHANNEL_ACCESS_TOKEN) return send(404, { error: "not found" });
      const status = await handleLine(
        dn, await body(), req.headers["x-line-signature"] as string | undefined,
        env.LINE_CHANNEL_SECRET, env.LINE_CHANNEL_ACCESS_TOKEN,
      );
      return send(status, {});
    },
  },
  {
    method: "POST", pattern: "/webhooks/slack", access: "public",
    handler: async ({ req, send, body, app: { dn, env } }) => {
      if (!env.SLACK_SIGNING_SECRET || !env.SLACK_BOT_TOKEN) return send(404, { error: "not found" });
      const raw = await body();
      // Slack re-sends events it thinks we missed; we already acked the first one.
      if (req.headers["x-slack-retry-num"]) return send(200, {});
      const r = await handleSlack(
        dn, raw,
        { timestamp: req.headers["x-slack-request-timestamp"] as string, signature: req.headers["x-slack-signature"] as string },
        env.SLACK_SIGNING_SECRET, env.SLACK_BOT_TOKEN,
      );
      return send(r.status, r.body ?? "", "text/plain");
    },
  },
  // MCP over Streamable HTTP, stateless: a fresh server per request.
  {
    method: "*", pattern: "/mcp",
    access: "custom", why: "two tiers on one URL: the admin password or a write token gets every tool, the read key or a read token only the reading ones",
    handler: async ({ req, res, send, json, app }) => {
      const { dn, env } = app;
      const admin = app.authorized(req);
      if (!admin && !canRead(req, env, dn.store)) return send(401, { error: "unauthorized" });
      const agent = (req.headers["x-driftnet-agent"] as string | undefined)?.slice(0, 40) ?? "agent";
      const mcp = createMcpServer(dn, agent, { readOnly: !admin, actor: actorOf(req, env, dn.store) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      const body = req.method === "POST" ? await json() : undefined;
      return await transport.handleRequest(req, res, body);
    },
  },
  // Plain-text endpoint for scripts and bots we don't have an adapter for yet.
  {
    method: "POST", pattern: "/api/chat", access: "write",
    handler: async ({ send, json, app: { dn } }) => {
      const body = await json<{ text: string; platform?: string; chat?: string; user?: string }>();
      if (typeof body.text !== "string") throw new BadRequest("text is required");
      const reply = await handleChatText(dn, body.text, {
        platform: body.platform ?? "http", chatId: body.chat ?? "api", ...(body.user ? { userId: body.user } : {}),
      });
      return send(200, { reply });
    },
  },
];
