import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { BlockedUrl, isPublicAddress, safeFetch } from "../src/extractors/net.ts";

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

test("redirects are checked hop by hop", async () => {
  // With private targets allowed for the first hop only, a redirect into a
  // blocked address must still be refused once the guard is back on.
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: URL, init: RequestInit) => {
    delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS; // guard on again after the first hop
    return realFetch(u, init);
  }) as typeof fetch;
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/go`), BlockedUrl);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
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
