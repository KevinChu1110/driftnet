import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { sendWebhook, signBody, shouldNotify, webhookPayload } from "../src/webhook.ts";
import type { Item } from "../src/types.ts";

function seed() {
  const store = new Store(":memory:");
  store.seedFolders({ "coding-agent": "x", other: "y" });
  const sub = store.createFolder({ name: "Skills", parent: "coding-agent" });
  const item = store.upsert({
    url: "https://example.com/a", aliases: [], title: "A",
    judgement: { isAiTool: 1, category: sub.id, kind: "repo", worth: "normal", engine: "llm", confidence: 1 },
    summary: { name: "Alpha", oneLiner: "does a thing", highlights: ["h1"], useCases: [], tags: ["t"], primaryUrl: "https://alpha.dev" },
    flags: [], source: "example.com",
  });
  return { store, item };
}

async function receiver() {
  const calls: { body: string; headers: IncomingHttpHeaders }[] = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    calls.push({ body: Buffer.concat(chunks).toString(), headers: req.headers });
    res.writeHead(status).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return { calls, url: `http://127.0.0.1:${port}/hook`, setStatus: (s: number) => (status = s), close: () => server.close() };
}

test("payload carries the card, folder path and page URL", () => {
  const { store, item } = seed();
  const p = webhookPayload(store, item, "item.added", { DRIFTNET_PUBLIC_URL: "https://dn.example" });
  assert.equal(p.event, "item.added");
  assert.equal(p.item.name, "Alpha");
  assert.equal(p.item.primaryUrl, "https://alpha.dev");
  assert.deepEqual(p.item.folderPath, ["Coding agents", "Skills"]);
  assert.equal(p.item.pageUrl, `https://dn.example/#item-${item.id}`);
  assert.deepEqual(p.item.highlights, ["h1"]);
});

test("delivers with a signature; allowed local host only with ALLOW_LOCAL", async () => {
  const { store, item } = seed();
  const rx = await receiver();
  try {
    const env = { DRIFTNET_WEBHOOK_URL: rx.url, DRIFTNET_WEBHOOK_SECRET: "s3cret" };
    assert.equal(await sendWebhook(store, item, "item.added", env), false, "loopback refused by default");
    assert.equal(rx.calls.length, 0);
    assert.equal(await sendWebhook(store, item, "item.added", { ...env, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" }), true);
    assert.equal(rx.calls.length, 1);
    const [call] = rx.calls;
    const ts = call!.headers["x-driftnet-timestamp"] as string;
    assert.match(ts, /^\d{10}$/);
    assert.ok(call!.headers["x-driftnet-delivery"]);
    assert.equal(call!.headers["x-driftnet-signature"], signBody(call!.body, "s3cret", ts));
    assert.equal(JSON.parse(call!.body).item.name, "Alpha");
    rx.calls.length = 0;
    await sendWebhook(store, item, "item.updated", { DRIFTNET_WEBHOOK_URL: rx.url, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" });
    assert.equal(rx.calls[0]!.headers["x-driftnet-signature"], undefined, "no secret, no signature");
  } finally {
    rx.close();
  }
});

test("skipped, trashed and injection-flagged items are never sent", async () => {
  const { store, item } = seed();
  const rx = await receiver();
  try {
    const env = { DRIFTNET_WEBHOOK_URL: rx.url, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" };
    for (const bad of [{ worth: "skip" }, { trashedAt: "2026-01-01" }, { flags: ["injection"] }] as Partial<Item>[]) {
      assert.equal(shouldNotify({ ...item, ...bad }), false);
      assert.equal(await sendWebhook(store, { ...item, ...bad }, "item.added", env), false);
    }
    assert.equal(rx.calls.length, 0);
  } finally {
    rx.close();
  }
});

test("a failing receiver is retried once and never throws; non-http is refused", async () => {
  const { store, item } = seed();
  const rx = await receiver();
  try {
    rx.setStatus(500);
    const env = { DRIFTNET_WEBHOOK_URL: rx.url, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" };
    assert.equal(await sendWebhook(store, item, "item.added", env), false);
    assert.equal(rx.calls.length, 2, "one retry");
  } finally {
    rx.close();
  }
  assert.equal(await sendWebhook(store, item, "item.added", { DRIFTNET_WEBHOOK_URL: "http://127.0.0.1:1/x", DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" }), false);
  assert.equal(await sendWebhook(store, item, "item.added", { DRIFTNET_WEBHOOK_URL: "ftp://example.com/x" }), false);
  assert.equal(await sendWebhook(store, item, "item.added", {}), false);
});

test("a redirect is a failure, never followed", async () => {
  const { store, item } = seed();
  const target = await receiver();
  const redirector = createServer((_req, res) => res.writeHead(302, { location: target.url }).end());
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  try {
    const { port } = redirector.address() as { port: number };
    const env = { DRIFTNET_WEBHOOK_URL: `http://127.0.0.1:${port}/x`, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" };
    assert.equal(await sendWebhook(store, item, "item.added", env), false);
    assert.equal(target.calls.length, 0);
  } finally {
    redirector.close();
    target.close();
  }
});

test("the retry keeps the delivery id, waits and re-signs", async () => {
  const { store, item } = seed();
  const rx = await receiver();
  try {
    rx.setStatus(500);
    const t0 = Date.now();
    await sendWebhook(store, item, "item.added", { DRIFTNET_WEBHOOK_URL: rx.url, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1", DRIFTNET_WEBHOOK_SECRET: "k" });
    assert.ok(Date.now() - t0 >= 900, "about a second between attempts");
    assert.equal(rx.calls[0]!.headers["x-driftnet-delivery"], rx.calls[1]!.headers["x-driftnet-delivery"]);
  } finally {
    rx.close();
  }
});

test("trash and restore events are sent for a trashed item", async () => {
  const { store, item } = seed();
  const rx = await receiver();
  try {
    const env = { DRIFTNET_WEBHOOK_URL: rx.url, DRIFTNET_WEBHOOK_ALLOW_LOCAL: "1" };
    store.setTrashed(item.id, true);
    assert.equal(await sendWebhook(store, store.get(item.id)!, "item.trashed", env), true);
    assert.equal(await sendWebhook(store, store.get(item.id)!, "item.updated", env), false, "other events stay quiet while trashed");
    assert.equal(JSON.parse(rx.calls[0]!.body).event, "item.trashed");
  } finally {
    rx.close();
  }
});
