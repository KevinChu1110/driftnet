import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet } from "@driftnet/core";
import { createApp, routes } from "../src/app.ts";
import type { Route } from "../src/route.ts";

const PASSWORD = "route-table-test-password-1A!";
const READ_KEY = "route-table-read-key";
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function start(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-routes-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en", DRIFTNET_TOKEN: PASSWORD, DRIFTNET_READ_KEY: READ_KEY, ...extra };
  const dn = createDriftnet(env);
  const server = createApp({ dn, env, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  /**
   * "forwarded" makes the request look like it came through a proxy, so it is not this machine
   * (which would count as trusted): the same thing a tunnel or reverse proxy produces. Each call gets its own address so the wrong-password throttle never kicks in.
   */
  let n = 0;
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port, method, path, headers: { "x-forwarded-for": `203.0.113.${(++n % 250) + 1}`, ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => ok({ status: res.statusCode!, body: b }));
      });
      r.on("error", fail);
      r.end(body ? JSON.stringify(body) : undefined);
    });
  return { call, dn };
}

const methodOf = (r: Route) => (Array.isArray(r.method) ? r.method[0]! : r.method === "*" || r.method === "NON_GET" ? "POST" : r.method);
const pathOf = (r: Route) => ("example" in r ? r.example : r.pattern as string);

test("route table: every route says who may call it", () => {
  assert.ok(routes.length > 30);
  for (const r of routes) {
    assert.ok(["public", "read", "write", "password", "custom"].includes(r.access), `${r.pattern} has no access`);
    if (r.access === "custom") assert.ok(r.why.length > 10, `${r.pattern}: custom needs a reason`);
    if (r.pattern instanceof RegExp) assert.ok(r.pattern.test(pathOf(r)), `${r.pattern}: example does not match`);
  }
});

test("route table: every write and password route refuses a caller with no credentials, or the wrong ones", async () => {
  const { call } = await start();
  const guarded = routes.filter((r) => r.access === "write" || r.access === "password");
  assert.ok(guarded.length > 15);
  for (const r of guarded) {
    const method = methodOf(r);
    const path = pathOf(r);
    const none = await call(method, path, {}, method === "GET" ? undefined : {});
    assert.ok(none.status === 401 || none.status === 403, `${method} ${path} without credentials answered ${none.status}`);
    const wrong = await call(method, path, { authorization: "Bearer not-the-password" }, method === "GET" ? undefined : {});
    assert.ok(wrong.status === 401 || wrong.status === 403, `${method} ${path} with a wrong password answered ${wrong.status}`);
  }
});

test("route table: password routes also refuse the read-only key and the password routes accept the password", async () => {
  const { call } = await start();
  for (const r of routes.filter((r) => r.access === "password")) {
    const method = methodOf(r);
    const res = await call(method, pathOf(r), { authorization: `Bearer ${READ_KEY}` }, method === "GET" ? undefined : {});
    assert.equal(res.status, 403, `${method} ${pathOf(r)} accepted the read key`);
  }
  const list = await call("GET", "/api/agent-tokens", { authorization: `Bearer ${PASSWORD}` });
  assert.equal(list.status, 200);
  assert.equal((await call("GET", "/api/settings", { authorization: `Bearer ${PASSWORD}` })).status, 200);
});

test("public mode: reads are open, writes are not, the page and pair/claim need nothing", async () => {
  const { call } = await start();
  assert.equal((await call("GET", "/")).status, 200);
  assert.equal((await call("GET", "/favicon.svg")).status, 200);
  assert.equal((await call("GET", "/api/stats")).status, 200);
  assert.equal((await call("GET", "/llms.txt")).status, 200);
  assert.equal((await call("GET", "/api/nope")).status, 404);
  assert.equal((await call("GET", "/.well-known/oauth-authorization-server")).status, 404);
  assert.equal((await call("POST", "/api/ingest", {}, { text: "hi" })).status, 401);
  assert.equal((await call("POST", "/api/pending", { authorization: "Bearer nope" }, {})).status, 401);
  const claim = await call("POST", "/api/pair/claim", {}, { code: "x".repeat(20) });
  assert.equal(claim.status, 404, "an unknown code is a bare 404, not an auth error");
  assert.equal((await call("POST", "/webhooks/line", {}, {})).status, 404, "webhooks are off until configured");
  const mcp = await call("POST", "/mcp", {}, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.notEqual(mcp.status, 401, "public mode: MCP is open for reading");
});

test("private mode: every read needs a key; the page, icons and pair/claim stay reachable", async () => {
  const { call } = await start({ DRIFTNET_ACCESS: "private" });
  assert.equal((await call("GET", "/")).status, 200);
  assert.equal((await call("GET", "/manifest.webmanifest")).status, 200);
  for (const path of ["/api/stats", "/api/items", "/api/folders", "/llms.txt", "/feed.xml", "/api/export", "/api/nope"]) {
    assert.equal((await call("GET", path)).status, 401, `GET ${path} should need a key`);
  }
  assert.equal((await call("GET", "/api/stats", { authorization: `Bearer ${READ_KEY}` })).status, 200);
  assert.equal((await call("GET", `/llms.txt?key=${READ_KEY}`)).status, 200);
  assert.equal((await call("POST", "/mcp", {}, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  assert.equal((await call("POST", "/api/pair/claim", {}, { code: "x".repeat(20) })).status, 404);
  assert.equal((await call("POST", "/api/ingest", { authorization: `Bearer ${READ_KEY}` }, { text: "hi" })).status, 401, "the read key cannot write");
});

test("tags and permanent delete over HTTP: validation, 409 outside the trash, 404 when gone", async () => {
  const { call, dn } = await start();
  const auth = { authorization: `Bearer ${PASSWORD}` };
  const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
  const it = dn.store.upsert({ url: "https://r.test/x", aliases: [], title: "x", judgement: j, summary: { name: "X", oneLiner: "o", highlights: [], useCases: [], tags: [] }, flags: [], source: "s" });
  const bare = dn.store.upsert({ url: "https://r.test/y", aliases: [], title: "y", judgement: j, summary: null, flags: [], source: "s" });
  assert.equal((await call("PUT", `/api/items/${it.id}/tags`, {}, { tags: ["a"] })).status, 401);
  assert.equal((await call("DELETE", `/api/items/${it.id}`)).status, 401);
  assert.equal((await call("PUT", `/api/items/${it.id}/tags`, auth, { tags: "a" })).status, 400);
  assert.equal((await call("PUT", `/api/items/${it.id}/tags`, auth, { tags: ["x".repeat(41)] })).status, 422);
  assert.equal((await call("PUT", `/api/items/${bare.id}/tags`, auth, { tags: ["a"] })).status, 422, "no summary yet");
  assert.equal((await call("PUT", "/api/items/999/tags", auth, { tags: ["a"] })).status, 404);
  const ok = await call("PUT", `/api/items/${it.id}/tags`, auth, { tags: ["Alpha"] });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body).summary.tags, ["alpha"]);
  assert.equal((await call("DELETE", `/api/items/${it.id}`, auth)).status, 409, "not in the trash");
  await call("POST", `/api/items/${it.id}/trash`, auth);
  assert.equal((await call("DELETE", `/api/items/${it.id}`, auth)).status, 200);
  assert.equal((await call("GET", `/api/items/${it.id}`)).status, 404);
  assert.equal((await call("DELETE", `/api/items/${it.id}`, auth)).status, 404);
  await call("POST", `/api/items/${bare.id}/trash`, auth);
  assert.deepEqual(JSON.parse((await call("DELETE", "/api/trash", auth)).body), { ok: true, removed: 1 });
});
