import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { createDriftnet } from "@driftnet/core";
import { tokenRoute } from "../src/tokens.ts";

const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-token-routes-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const store = dn.store;
const env = { DRIFTNET_TOKEN: "admin-pass-123" };
type Info = { auth?: string; method?: string; local?: boolean; url?: string; json?: boolean };

/** A fake request: remote unless `local`, JSON unless told otherwise. */
const req = ({ auth, method = "GET", local = false, url = "/api/agent-tokens", json = true }: Info = {}) =>
  ({
    method,
    url,
    headers: {
      host: local ? "localhost:8787" : "driftnet.example",
      ...(json ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    socket: { remoteAddress: local ? "127.0.0.1" : "203.0.113.9" },
  }) as unknown as IncomingMessage;

const route = (info: Info, id: string | null = null, body?: unknown, e: NodeJS.ProcessEnv = env) => tokenRoute(store, e, req(info), id, body);
const admin = { auth: "admin-pass-123" };

test("the admin password lists, creates, revokes and removes tokens", () => {
  const made = route({ ...admin, method: "POST" }, null, { name: "  Claude Code ", scope: "write" });
  assert.equal(made.status, 200);
  const { id, token, name } = made.body as { id: string; token: string; name: string };
  assert.equal(name, "Claude Code");
  assert.match(token, /^dn_/);

  const listed = route(admin).body as { id: string; revokedAt: string | null }[];
  assert.equal(listed.find((t) => t.id === id)?.revokedAt, null);
  assert.ok(!JSON.stringify(listed).includes(token), "the list never carries the token");

  assert.equal(route({ ...admin, method: "DELETE", url: `/api/agent-tokens/${id}?purge=1` }, id).status, 409, "an active token cannot be removed");
  assert.equal(route({ ...admin, method: "DELETE" }, id).status, 200);
  assert.equal(route({ ...admin, method: "DELETE" }, id).status, 404, "already revoked");
  assert.equal(route({ ...admin, method: "DELETE", url: `/api/agent-tokens/${id}?purge=1` }, id).status, 200);
  assert.ok(!(route(admin).body as { id: string }[]).some((t) => t.id === id));
  assert.equal(route({ ...admin, method: "DELETE", url: `/api/agent-tokens/${id}?purge=1` }, id).status, 404);
  assert.equal(route({ ...admin, method: "PUT" }, id).status, 405);
});

test("a read token or a write token cannot manage tokens", () => {
  const r = store.createAgentToken({ name: "reader", scope: "read" });
  const w = store.createAgentToken({ name: "writer", scope: "write" });
  for (const t of [r.token, w.token]) {
    assert.equal(route({ auth: t }).status, 403);
    assert.equal(route({ auth: t, method: "POST" }, null, { name: "x", scope: "write" }).status, 403);
    assert.equal(route({ auth: t, method: "DELETE" }, w.id).status, 403);
  }
  assert.ok(store.listAgentTokens().find((t) => t.id === w.id)?.revokedAt === null, "nothing was revoked");
  assert.equal(route({ auth: "wrong" }).status, 403);
  assert.equal(route({}).status, 403, "no credentials");
});

test("no password: this machine may, anyone else may not", () => {
  const open = {};
  assert.equal(route({}, null, undefined, open).status, 403);
  assert.equal((route({}, null, undefined, open).body as { error: string }).error, "set an admin password to manage agent tokens remotely");
  assert.equal(route({ local: true }, null, undefined, open).status, 200);
  assert.equal(route({ local: true, method: "POST" }, null, { name: "local", scope: "read" }, open).status, 200);
});

test("a page on another site cannot manage tokens, even from this machine", () => {
  const foreign = req({ local: true });
  foreign.headers.origin = "https://evil.example";
  assert.equal(tokenRoute(store, {}, foreign, null).status, 403);
});

test("bad input is a 400, a non-JSON body a 415", () => {
  const post = { ...admin, method: "POST" };
  assert.equal(route(post, null, {}).status, 400);
  assert.equal(route(post, null, { name: "  ", scope: "read" }).status, 400);
  assert.equal(route(post, null, { scope: "read" }).status, 400);
  const noScope = route(post, null, { name: "x" });
  assert.equal(noScope.status, 400);
  assert.equal((noScope.body as { error: string }).error, "scope must be read or write");
  assert.equal(route(post, null, { name: "x", scope: "admin" }).status, 400);
  assert.equal(route({ ...post, json: false }, null, { name: "x", scope: "read" }).status, 415);
});

test("revoked tokens drop out of the list after 30 days", () => {
  const old = store.createAgentToken({ name: "ancient", scope: "read" });
  const fresh = store.createAgentToken({ name: "recent", scope: "read" });
  store.revokeAgentToken(old.id);
  store.revokeAgentToken(fresh.id);
  (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare("UPDATE agent_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','-31 days') WHERE id = ?").run(old.id);
  const ids = store.listAgentTokens().map((t) => t.id);
  assert.ok(!ids.includes(old.id));
  assert.ok(ids.includes(fresh.id));
  assert.equal(store.deleteAgentToken("nope"), false);
});
