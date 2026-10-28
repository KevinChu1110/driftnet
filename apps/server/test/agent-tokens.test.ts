import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDriftnet } from "@driftnet/core";
import { actorOf, agentOf, canRead, isAdmin, isPassword, readOnly, role } from "../src/access.ts";
import { createMcpServer } from "../src/mcp.ts";

const home = mkdtempSync(join(tmpdir(), "driftnet-tokens-"));
const dn = createDriftnet({ DRIFTNET_HOME: home, DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const store = dn.store;
const env = { DRIFTNET_TOKEN: "admin-pass-123", DRIFTNET_ACCESS: "private" };

// Not loopback, so only the credentials count (never the "this machine" shortcut).
const req = (auth?: string) =>
  ({
    url: "/api/items",
    headers: { host: "driftnet.example", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    socket: { remoteAddress: "203.0.113.9" },
  }) as unknown as IncomingMessage;

async function connect(opts: { readOnly?: boolean; actor?: string }) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(dn, "test", opts).connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

test("a write token is admin, a read token only reads, and neither is the password", () => {
  const w = store.createAgentToken({ name: "Hermes", scope: "write" });
  const r = store.createAgentToken({ name: "Dashboard", scope: "read" });
  assert.ok(isAdmin(req(w.token), env, store));
  assert.equal(role(req(w.token), env, store), "admin");
  assert.ok(!isAdmin(req(r.token), env, store), "a read token cannot write");
  assert.ok(readOnly(req(r.token), env, store));
  assert.ok(canRead(req(r.token), env, store));
  assert.equal(role(req(r.token), env, store), "reader");
  assert.ok(!canRead(req("dn_unknown"), env, store));
  assert.equal(role(req("dn_unknown"), env, store), "none");
  assert.ok(!isAdmin(req(w.token), env), "without the store, tokens are unknown");
  // Token management and settings stay with the password.
  assert.ok(isPassword(req(env.DRIFTNET_TOKEN), env));
  assert.ok(!isPassword(req(w.token), env));
  assert.deepEqual(agentOf(req(w.token), store), { id: w.id, name: "Hermes", scope: "write" });
  assert.equal(actorOf(req(w.token), env, store), `agent:${w.id}`);
  assert.equal(actorOf(req(env.DRIFTNET_TOKEN), env, store), "admin");
  assert.equal(actorOf(req("nope"), env, store), undefined);
  assert.ok(isAdmin(req(env.DRIFTNET_TOKEN), env, store), "the password keeps working for agents");
});

test("a token is not accepted in a URL", () => {
  const r = store.createAgentToken({ name: "url", scope: "read" });
  const viaUrl = { ...req(), url: `/llms.txt?key=${r.token}` } as IncomingMessage;
  assert.ok(!canRead(viaUrl, env, store));
});

test("revoking takes effect at once; changing the admin password does not touch tokens", () => {
  const w = store.createAgentToken({ name: "Claude Code", scope: "write" });
  const changed = { ...env, DRIFTNET_TOKEN: "a-completely-new-password" };
  assert.ok(isAdmin(req(w.token), changed, store));
  assert.ok(!isAdmin(req("admin-pass-123"), changed, store));
  assert.ok(store.revokeAgentToken(w.id));
  assert.ok(!isAdmin(req(w.token), changed, store));
  assert.equal(agentOf(req(w.token), store), null);
  assert.ok(!store.revokeAgentToken(w.id), "already revoked");
  assert.ok(store.listAgentTokens().find((t) => t.id === w.id)!.revokedAt);
});

test("only the hash is stored: the token is in no table and no listing", () => {
  const w = store.createAgentToken({ name: "stored", scope: "write" });
  assert.match(w.token, /^dn_[\w-]{32}$/);
  assert.ok(!JSON.stringify(store.listAgentTokens()).includes(w.token));
  assert.ok(!JSON.stringify(store.listAgentTokens()).includes('"hash"'));
  const files = readdirSync(home).filter((f) => /\.db/.test(f));
  assert.ok(files.length);
  for (const f of files) assert.ok(!readFileSync(join(home, f)).includes(w.token), `${f} must not contain the token`);
  assert.throws(() => store.createAgentToken({ name: " ", scope: "read" }));
  assert.throws(() => store.createAgentToken({ name: "x", scope: "admin" as "read" }));
});

test("last_used_at is set on first use and then written at most once a minute", () => {
  const w = store.createAgentToken({ name: "used", scope: "read" });
  const lastUsed = () => store.listAgentTokens().find((t) => t.id === w.id)!.lastUsedAt;
  assert.equal(lastUsed(), null);
  assert.ok(agentOf(req(w.token), store));
  const first = lastUsed();
  assert.ok(first);
  store.touchAgentToken(w.id);
  assert.equal(lastUsed(), first, "throttled");
  (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare("UPDATE agent_tokens SET last_used_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(w.id);
  store.touchAgentToken(w.id);
  assert.notEqual(lastUsed(), "2020-01-01T00:00:00Z", "a stale value is refreshed");
});

test("a read token's MCP session has only the reading tools; a write token's has them all", async () => {
  const read = await connect({ readOnly: true });
  const write = await connect({ readOnly: false });
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);
  const readTools = await names(read);
  assert.deepEqual(readTools.sort(), ["driftnet_get_item", "driftnet_list_folders", "driftnet_list_recent", "driftnet_search"]);
  assert.ok((await names(write)).length > readTools.length);
  assert.ok((await names(write)).includes("driftnet_move_item"));
  const denied = await read.callTool({ name: "driftnet_move_item", arguments: { id: 1, folder: "other" } }).catch(() => ({ isError: true }));
  assert.equal(denied.isError, true, "a read session cannot call a write tool");
  await read.close();
  await write.close();
});

test("who leased or moved is recorded: the token's id, or admin", async () => {
  const judgement = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
  const item = store.upsert({ url: "https://tokens.test/a", aliases: [], title: "a", judgement, summary: null, flags: [], source: "s" });
  const w = store.createAgentToken({ name: "worker", scope: "write" });
  const row = () => (store as unknown as { db: { prepare(s: string): { get(...a: unknown[]): Record<string, string | null> } } }).db
    .prepare("SELECT claimed_actor, moved_by FROM items WHERE id = ?").get(item.id)!;
  const client = await connect({ actor: `agent:${w.id}` });
  await client.callTool({ name: "driftnet_lease_pending", arguments: { limit: 10 } });
  assert.equal(row().claimed_actor, `agent:${w.id}`);
  await client.callTool({ name: "driftnet_move_item", arguments: { id: item.id, folder: "other" } });
  assert.equal(row().moved_by, `agent:${w.id}`);
  store.moveItem(item.id, "other", "admin");
  assert.equal(row().moved_by, "admin");
  await client.close();
});

test("one request looks its token up once, however many questions it asks", () => {
  const w = store.createAgentToken({ name: "once", scope: "write" });
  const original = store.findAgentToken.bind(store);
  let calls = 0;
  store.findAgentToken = (hash) => (calls++, original(hash));
  try {
    const r = req(w.token);
    assert.ok(isAdmin(r, env, store));
    assert.ok(canRead(r, env, store));
    assert.equal(role(r, env, store), "admin");
    assert.equal(actorOf(r, env, store), `agent:${w.id}`);
    assert.equal(calls, 1);
    // A caller with no valid token is remembered too.
    calls = 0;
    const nobody = req("dn_not-a-token");
    assert.ok(!isAdmin(nobody, env, store));
    assert.ok(!canRead(nobody, env, store));
    assert.equal(role(nobody, env, store), "none");
    assert.equal(calls, 1);
  } finally {
    store.findAgentToken = original;
  }
});
