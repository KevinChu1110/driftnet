import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { createDriftnet, registerExtractor } from "@driftnet/core";
import { startSlackSocket } from "../src/adapters/slack.ts";

registerExtractor({
  name: "slack-fixture",
  matches: (u) => u.startsWith("https://slack.test/"),
  extract: async (url) => ({ url, kind: "repo", title: "Slack fixture tool", text: "", outlinks: [], meta: {} }),
});

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const c of req) raw += c;
  return raw;
};

/** A fake Slack: Web API over HTTP plus a Socket Mode WebSocket. */
test("Slack Socket Mode: connect, ack, reply in thread, reconnect on disconnect", async () => {
  const opens: string[] = [];
  const posts: any[] = [];
  const acks: string[] = [];
  const sockets: WebSocket[] = [];

  const wss = new WebSocketServer({ port: 0 });
  const wsPort = (wss.address() as { port: number }).port;
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (m) => acks.push(JSON.parse(String(m)).envelope_id));
    ws.send(JSON.stringify({ type: "hello" }));
  });
  const http = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/apps.connections.open") {
      opens.push(String(req.headers.authorization));
      return res.end(JSON.stringify({ ok: true, url: `ws://127.0.0.1:${wsPort}/` }));
    }
    if (req.url === "/api/chat.postMessage") {
      posts.push({ auth: req.headers.authorization, ...JSON.parse(await body(req)) });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  process.env.SLACK_API_URL = `http://127.0.0.1:${(http.address() as { port: number }).port}/api`;

  const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-slack-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
  const stop = startSlackSocket(dn, "xapp-test", "xoxb-test");
  try {
    await until(() => sockets.length === 1);
    assert.deepEqual(opens, ["Bearer xapp-test"]);

    const event = (id: string, ev: object) =>
      sockets.at(-1)!.send(JSON.stringify({ type: "events_api", envelope_id: id, payload: { type: "event_callback", event: ev } }));
    // Slack wraps links as <url|label>.
    event("env-1", { type: "message", channel: "C1", user: "U1", ts: "171.0001", text: "look <https://slack.test/a|slack.test/a>" });
    event("env-2", { type: "message", subtype: "bot_message", bot_id: "B1", channel: "C1", ts: "171.0002", text: "https://slack.test/b" });
    event("env-3", { type: "message", channel: "C1", user: "U1", ts: "171.0003", text: "no links here" });

    await until(() => acks.length === 3 && posts.length === 1);
    assert.deepEqual(acks, ["env-1", "env-2", "env-3"]); // every envelope acknowledged, bots included
    assert.equal(posts[0].auth, "Bearer xoxb-test");
    assert.equal(posts[0].channel, "C1");
    assert.equal(posts[0].thread_ts, "171.0001");
    assert.match(posts[0].text, /Slack fixture tool/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(posts.length, 1, "bot messages and link-less messages get no reply");

    // Slack asks clients to reconnect from time to time.
    sockets.at(-1)!.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
    await until(() => sockets.length === 2);
    assert.equal(opens.length, 2);
  } finally {
    stop();
    delete process.env.SLACK_API_URL;
    for (const ws of sockets) ws.terminate();
    wss.close();
    http.close();
  }
});
