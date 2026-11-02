import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { BlockedUrl, endpointFetch, isLoopbackHost, isPublicAddress, safeFetch, useResolverForTests } from "../src/extractors/net.ts";

test("private, local and metadata addresses are not public", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "localhost"]) {
    assert.equal(isPublicAddress(a), false, a);
  }
  for (const a of ["8.8.8.8", "140.82.112.3", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(a), true, a);
});

test("safeFetch refuses loopback targets, by IP and by name", async () => {
  const server = createServer((_, res) => res.end("internal secret"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, "http://169.254.169.254/latest/meta-data/"]) {
      await assert.rejects(safeFetch(url), BlockedUrl, url);
    }
    await assert.rejects(safeFetch("file:///etc/passwd"), BlockedUrl);
  } finally {
    server.close();
  }
});

test("DNS rebinding: the address that is checked is the address that is connected to", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.end("internal");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  // A name that resolves to loopback at connection time.
  const restore = useResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    await assert.rejects(safeFetch(`http://rebind.test:${port}/`), BlockedUrl);
    assert.equal(hits, 0, "the request must never reach the private address");
    // Same resolver with private targets allowed: the request lands there, so the
    // connection really uses the answer that was checked.
    process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
    assert.equal(await (await safeFetch(`http://rebind.test:${port}/`)).text(), "internal");
    assert.equal(hits, 1);
  } finally {
    delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
    restore();
    server.close();
  }
});

test("redirects are checked hop by hop", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/go") {
      // The first hop was allowed; the guard is back on before the redirect is followed.
      delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
      return res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
    }
    res.end("secret");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/go`), BlockedUrl);
    assert.equal(hits, 1, "/secret must not be requested");
  } finally {
    delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
    server.close();
  }
});

test("a link to a private address is refused, not catalogued", async () => {
  const { Pipeline, Store } = await import("../src/index.ts");
  const { DEFAULT_CATEGORIES } = await import("../src/categories.ts");
  const store = new Store(":memory:");
  const p = new Pipeline({ store, categories: DEFAULT_CATEGORIES });
  const results = await p.ingestMessage("look http://127.0.0.1:1/admin and http://169.254.169.254/latest", { platform: "t", chatId: "c" });
  assert.equal(results.length, 0);
  assert.equal(store.stats().items, 0);
});

test("a model endpoint: this machine always, another private host only with DRIFTNET_LLM_ALLOW_LOCAL=1, and only that host", async () => {
  for (const h of ["localhost", "LocalHost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) assert.ok(isLoopbackHost(h), h);
  for (const h of ["10.0.0.5", "ollama.lan", "api.openai.com", "::ffff:10.0.0.5"]) assert.ok(!isLoopbackHost(h), h);
  const srv = createServer((_, res) => res.end("ok"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  // Any name resolves to this test server; the guard decides by what it was told, not by what answers.
  const restore = useResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
  try {
    assert.equal(await (await endpointFetch(`http://127.0.0.1:${port}/v1`, {})(`http://127.0.0.1:${port}/v1/chat`)).text(), "ok", "Ollama on localhost needs no setting");
    assert.equal(await (await endpointFetch(`http://localhost:${port}/v1`, {})(`http://localhost:${port}/v1/chat`)).text(), "ok");
    await assert.rejects(endpointFetch(`http://ollama.lan:${port}/v1`, {})(`http://ollama.lan:${port}/v1/chat`), BlockedUrl, "a LAN host is refused by default");
    await assert.rejects(endpointFetch(`http://10.0.0.5:${port}/v1`, {})(`http://10.0.0.5:${port}/v1/chat`), BlockedUrl);
    const allowed = endpointFetch(`http://ollama.lan:${port}/v1`, { DRIFTNET_LLM_ALLOW_LOCAL: "1" });
    assert.equal(await (await allowed(`http://ollama.lan:${port}/v1/chat`)).text(), "ok", "allowed on purpose");
    await assert.rejects(allowed(`http://other.lan:${port}/x`), BlockedUrl, "only the host that was named");
  } finally {
    restore();
    srv.close();
  }
});
