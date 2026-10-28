import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createDriftnet, WORTH, type Kind, type Worth } from "@driftnet/core";
import { handleChatText } from "./adapters/handle.ts";
import { handleLine } from "./adapters/line.ts";
import { handleSlack } from "./adapters/slack.ts";
import { startTelegram } from "./adapters/telegram.ts";
import { startDiscord } from "./adapters/discord.ts";
import { createMcpServer } from "./mcp.ts";
import { llmsTxt, openApi } from "./feeds.ts";

const env = process.env;
const dn = createDriftnet();
const PORT = Number(env.PORT ?? 8787);
const TOKEN = env.DRIFTNET_TOKEN;
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/** Writes (ingest, feedback, MCP) need DRIFTNET_TOKEN when it is set; reads are public. */
function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
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
    if (req.method === "GET" && path === "/") return send(res, 200, indexHtml, "text/html; charset=utf-8");
    if (req.method === "GET" && path === "/llms.txt") return send(res, 200, llmsTxt(dn), "text/plain; charset=utf-8");
    if (req.method === "GET" && path === "/openapi.json") return send(res, 200, openApi(`${url.protocol}//${url.host}`));
    if (req.method === "GET" && path === "/api/categories") return send(res, 200, dn.categories);
    if (req.method === "GET" && path === "/api/stats") return send(res, 200, { ...dn.store.stats(), engines: dn.engines });
    if (req.method === "GET" && path === "/api/usage") return send(res, 200, { ...dn.store.usageReport(), engines: dn.engines });

    if (req.method === "GET" && path === "/api/items") {
      const p = url.searchParams;
      const minWorth = p.get("minWorth");
      return send(res, 200, dn.store.list({
        ...(p.get("q") ? { q: p.get("q")! } : {}),
        ...(p.get("category") ? { category: p.get("category")! } : {}),
        ...(p.get("kind") ? { kind: p.get("kind") as Kind } : {}),
        ...(minWorth && (WORTH as readonly string[]).includes(minWorth) ? { minWorth: minWorth as Worth } : {}),
        ...(p.get("since") ? { since: p.get("since")! } : {}),
        clean: p.get("all") !== "1",
        limit: Number(p.get("limit") ?? 200),
      }));
    }
    const itemMatch = /^\/api\/items\/(\d+)(\/feedback)?$/.exec(path);
    if (req.method === "GET" && itemMatch && !itemMatch[2]) {
      const item = dn.store.get(Number(itemMatch[1]));
      return item ? send(res, 200, item) : send(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && path === "/api/ingest") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = JSON.parse(await readBody(req)) as { text?: string; url?: string; note?: string; chat?: string };
      const text = [body.url, body.text, body.note].filter(Boolean).join(" ");
      const results = await dn.pipeline.ingestMessage(text, { platform: "http", chatId: body.chat ?? "api" });
      return send(res, 200, results);
    }
    if (req.method === "POST" && itemMatch?.[2]) {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const id = Number(itemMatch[1]);
      if (!dn.store.get(id)) return send(res, 404, { error: "not found" });
      const body = JSON.parse(await readBody(req)) as { vote: "up" | "down"; reason?: string; voter?: string };
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
      const body = req.method === "POST" ? JSON.parse(await readBody(req)) : undefined;
      return await transport.handleRequest(req, res, body);
    }

    // Plain-text endpoint for scripts and bots we don't have an adapter for yet.
    if (req.method === "POST" && path === "/api/chat") {
      if (!authorized(req)) return send(res, 401, { error: "unauthorized" });
      const body = JSON.parse(await readBody(req)) as { text: string; platform?: string; chat?: string; user?: string };
      const reply = await handleChatText(dn, body.text, {
        platform: body.platform ?? "http", chatId: body.chat ?? "api", ...(body.user ? { userId: body.user } : {}),
      });
      return send(res, 200, { reply });
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(`[http] ${req.method} ${path}:`, err);
    if (!res.headersSent) send(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, () => {
  console.log(`driftnet on http://localhost:${PORT}  judge=${dn.engines.judge}  summarizer=${dn.engines.summarizer}`);
  for (const w of dn.warnings) console.warn(`⚠️  ${w}`);
  if (env.TELEGRAM_BOT_TOKEN) startTelegram(dn, env.TELEGRAM_BOT_TOKEN);
  if (env.DISCORD_BOT_TOKEN) startDiscord(dn, env.DISCORD_BOT_TOKEN);
  if (env.LINE_CHANNEL_SECRET) console.log("[line] webhook at /webhooks/line");
  if (env.SLACK_SIGNING_SECRET) console.log("[slack] webhook at /webhooks/slack");
});
