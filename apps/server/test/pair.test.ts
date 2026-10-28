import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { createDriftnet, hashToken } from "@driftnet/core";
import { pairRoute } from "../src/pair.ts";
import { agentOf, isAdmin, isPassword } from "../src/access.ts";

const dn = createDriftnet({ DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-pair-")), DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
const store = dn.store;
const rawDb = (store as unknown as { db: { prepare(s: string): { get(...a: string[]): { n: number } } } }).db;
const env = { DRIFTNET_TOKEN: "admin-pass-123" };
type Info = { auth?: string; method?: string; local?: boolean; json?: boolean; origin?: string };
const req = ({ auth, method = "POST", local = false, json = true, origin }: Info = {}) =>
  ({
    method,
    url: "/api/pair",
    headers: {
      host: local ? "localhost:8787" : "driftnet.example",
      ...(json ? { "content-type": "application/json" } : {}),
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(origin ? { origin } : {}),
    },
    socket: { remoteAddress: local ? "127.0.0.1" : "203.0.113.9" },
  }) as unknown as IncomingMessage;
const make = (info: Info, body: unknown, now?: number, e: NodeJS.ProcessEnv = env) => pairRoute(store, e, req(info), "create", body, now);
const claim = (code: unknown, now?: number, info: Info = {}) => pairRoute(store, env, req(info), "claim", { code }, now);
const admin = { auth: "admin-pass-123" };

test("the password makes a code; the code becomes a working device token once", () => {
  const made = make(admin, { name: " Kevin's phone ", scope: "write" });
  assert.equal(made.status, 200);
  const { code, expiresAt } = made.body as { code: string; expiresAt: string };
  assert.ok(code.length >= 32, "at least 192 bits as base64url");
  assert.ok(Date.parse(expiresAt) > Date.now());
  assert.equal(rawDb.prepare("SELECT COUNT(*) n FROM pair_codes WHERE hash = ?").get(code)!.n, 0, "only a hash is stored");
  assert.equal(rawDb.prepare("SELECT COUNT(*) n FROM pair_codes WHERE hash = ?").get(hashToken(code))!.n, 1);

  const got = claim(code);
  assert.equal(got.status, 200);
  const dev = got.body as { id: string; name: string; scope: string; token: string };
  assert.equal(dev.name, "📱 Kevin's phone");
  assert.equal(dev.scope, "write");
  assert.match(dev.token, /^dn_/);
  assert.ok(store.listAgentTokens().some((t) => t.id === dev.id && t.name === dev.name), "listed like any token");

  // It authenticates as a write agent: admin for the page, not the password.
  const asDevice = req({ auth: dev.token });
  assert.equal(agentOf(asDevice, store)?.id, dev.id);
  assert.equal(isAdmin(asDevice, env, store), true);
  assert.equal(isPassword(asDevice, env), false);

  assert.equal(claim(code).status, 404, "single use");
  assert.deepEqual(claim(code).body, { error: "not found" });
  store.revokeAgentToken(dev.id);
  assert.equal(agentOf(req({ auth: dev.token }), store), null, "revocable");
});

test("a read code gives a read-only device", () => {
  const { code } = make(admin, { name: "tablet", scope: "read" }).body as { code: string };
  const dev = claim(code).body as { token: string; scope: string };
  assert.equal(dev.scope, "read");
  assert.equal(isAdmin(req({ auth: dev.token }), env, store), false);
});

test("an expired code is a bare 404", () => {
  const t0 = Date.now();
  const { code } = make(admin, { name: "late", scope: "write" }, t0).body as { code: string };
  assert.deepEqual(claim(code, t0 + 5 * 60_000 + 1000), { status: 404, body: { error: "not found" } });
  assert.equal(claim(code, t0 + 1000).status, 200, "inside five minutes it still works");
});

test("unknown and malformed", () => {
  const a = claim("x".repeat(32));
  assert.deepEqual(a, { status: 404, body: { error: "not found" } });
  assert.deepEqual(claim(undefined), a);
  assert.deepEqual(claim("short"), a);
  assert.deepEqual(claim({ nested: 1 }), a);
});

test("only the admin password makes codes", () => {
  const w = store.createAgentToken({ name: "writer", scope: "write" });
  const r = store.createAgentToken({ name: "reader", scope: "read" });
  for (const auth of [w.token, r.token, "wrong", undefined]) assert.equal(make({ auth }, { name: "x", scope: "write" }).status, 403);
  assert.equal(make({ ...admin, origin: "https://evil.example" }, { name: "x", scope: "write" }).status, 403);
  assert.equal(make({ ...admin, json: false }, { name: "x", scope: "write" }).status, 415);
  assert.equal(make(admin, { name: "  ", scope: "write" }).status, 400);
  assert.equal(make(admin, { name: "x", scope: "owner" }).status, 400);
  assert.equal(pairRoute(store, env, req({ ...admin, method: "GET" }), "create").status, 405);
  // No password: this machine only.
  assert.equal(make({ local: true }, { name: "x", scope: "read" }, undefined, {}).status, 200);
  assert.equal(make({}, { name: "x", scope: "read" }, undefined, {}).status, 403);
});
