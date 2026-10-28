import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { canRead, isAdmin, isLocal, newKey, readOnly, strength, Tunnel } from "../src/access.ts";

const req = (o: { url?: string; auth?: string; host?: string; ip?: string; headers?: Record<string, string> } = {}) =>
  ({
    url: o.url ?? "/api/items",
    headers: { host: o.host ?? "localhost:8787", ...(o.auth ? { authorization: `Bearer ${o.auth}` } : {}), ...(o.headers ?? {}) },
    socket: { remoteAddress: o.ip ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;

const env = { DRIFTNET_TOKEN: "admin-pass-123", DRIFTNET_READ_KEY: "share-key-abcdefghijkl", DRIFTNET_ACCESS: "private" };

test("the admin password writes; the share key only reads, and only it may sit in a URL", () => {
  assert.ok(isAdmin(req({ auth: env.DRIFTNET_TOKEN }), env));
  assert.ok(!isAdmin(req({ auth: env.DRIFTNET_READ_KEY }), env));
  assert.ok(!isAdmin(req({ url: `/x?key=${env.DRIFTNET_TOKEN}` }), env), "never the admin password in a URL");
  assert.ok(canRead(req({ auth: env.DRIFTNET_READ_KEY }), env));
  assert.ok(canRead(req({ url: `/llms.txt?key=${env.DRIFTNET_READ_KEY}` }), env));
  assert.ok(!canRead(req({ url: `/llms.txt?key=${env.DRIFTNET_TOKEN}` }), env));
  assert.ok(!canRead(req({ url: "/llms.txt?key=wrong" }), env));
  assert.ok(!canRead(req(), env));
  assert.ok(readOnly(req({ auth: env.DRIFTNET_READ_KEY }), env));
  assert.ok(canRead(req(), { ...env, DRIFTNET_ACCESS: "public" }), "public: reads are open");
  assert.ok(isAdmin(req(), {}), "no password: anyone who can reach it (loopback by default)");
});

test("only this machine counts as local — not a tunnel or proxy that connects from loopback", () => {
  assert.ok(isLocal(req()));
  assert.ok(!isLocal(req({ host: "abc.trycloudflare.com" })));
  assert.ok(!isLocal(req({ headers: { "cf-connecting-ip": "1.2.3.4" } })), "cloudflared marks what it forwards");
  assert.ok(!isLocal(req({ headers: { "x-forwarded-for": "1.2.3.4" } })));
  assert.ok(!isLocal(req({ ip: "192.168.1.5" })));
  assert.ok(!isLocal(req({ host: "evil.test" })), "DNS rebinding");
});

test("keys and password strength", () => {
  assert.match(newKey(), /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(newKey(), newKey());
  assert.equal(strength("12345678"), "weak");
  assert.equal(strength("hunter2hunter"), "ok");
  assert.equal(strength("correct-Horse-9"), "strong");
});

test("the tunnel reads cloudflared's URL, and stops with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "driftnet-cf-"));
  const fake = join(dir, "cloudflared");
  writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fake; exit 0; fi\necho "INF |  https://quiet-river-1234.trycloudflare.com  |" >&2\nexec sleep 30\n`);
  chmodSync(fake, 0o755);
  const t = new Tunnel(8787, fake);
  assert.ok(t.available());
  assert.equal(await t.start(5000), "https://quiet-river-1234.trycloudflare.com");
  assert.ok(t.running);
  t.stop();
  assert.ok(!t.running);
  assert.equal(new Tunnel(8787, join(dir, "missing")).available(), false);
});

test("card links carry the share key only when reading is private", async () => {
  const { shareBase } = await import("../src/access.ts");
  const { cardLink } = await import("@driftnet/core");
  assert.equal(shareBase({}), undefined);
  assert.equal(shareBase({ DRIFTNET_PUBLIC_URL: "https://dn.example/" }), "https://dn.example");
  assert.equal(shareBase({ ...env, DRIFTNET_PUBLIC_URL: "https://dn.example" }), `https://dn.example/?key=${env.DRIFTNET_READ_KEY}`);
  assert.equal(shareBase({ ...env, DRIFTNET_PUBLIC_URL: "https://dn.example", DRIFTNET_TUNNEL_URL: "https://t.trycloudflare.com" }), `https://t.trycloudflare.com/?key=${env.DRIFTNET_READ_KEY}`);
  assert.equal(cardLink("https://dn.example", 6), "https://dn.example/#item-6");
  assert.equal(cardLink("https://dn.example/?key=abc", 6), "https://dn.example/?key=abc#item-6");
});

test("this machine on purpose is trusted; another site's page or a forwarded request is not", async () => {
  const { isTrustedLocal, role } = await import("../src/access.ts");
  assert.ok(isTrustedLocal(req()));
  assert.ok(isTrustedLocal(req({ headers: { origin: "http://localhost:8787" } })));
  assert.ok(!isTrustedLocal(req({ headers: { origin: "https://evil.test" } })), "CSRF from a web page");
  assert.ok(!isTrustedLocal(req({ headers: { "x-forwarded-for": "1.2.3.4" } })));
  const remote = { headers: { "x-forwarded-for": "1.2.3.4" } };
  assert.equal(role(req(), env), "admin");
  assert.equal(role(req({ ...remote, auth: env.DRIFTNET_TOKEN }), env), "admin");
  assert.equal(role(req({ ...remote, auth: env.DRIFTNET_READ_KEY }), env), "reader");
  assert.equal(role(req(remote), env), "none");
});

test("another website's page is never trusted to write, even with no password", async () => {
  const { foreignOrigin } = await import("../src/access.ts");
  assert.ok(foreignOrigin(req({ headers: { origin: "https://evil.test" } })));
  assert.ok(!foreignOrigin(req({ headers: { origin: "http://localhost:8787" } })), "the page itself");
  assert.ok(!foreignOrigin(req({ headers: { origin: "chrome-extension://abcdef" } })), "the browser extension");
  assert.ok(!foreignOrigin(req()), "curl, agents, chat platforms send no Origin");
});
