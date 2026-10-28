import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { blockedHost, loadMedia, MediaError, sniffImage } from "../src/media.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 2)]);

let hits: Record<string, number> = {};
let img: Server;
let base: string;
before(async () => {
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  img = createServer((req, res) => {
    hits[req.url!] = (hits[req.url!] ?? 0) + 1;
    req.url = req.url!.split("?")[0];
    if (req.url === "/a.png") return void res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    if (req.url === "/b.gif") return void res.writeHead(200, { "content-type": "image/gif" }).end(GIF);
    if (req.url === "/x.svg") return void res.writeHead(200, { "content-type": "image/svg+xml" }).end("<svg onload='alert(1)'/>");
    if (req.url === "/fake.png") return void res.writeHead(200, { "content-type": "image/png" }).end("<html>not an image</html>");
    if (req.url === "/big.png") return void res.writeHead(200, { "content-type": "image/png" }).end(Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]));
    if (req.url === "/redir") return void res.writeHead(302, { location: "/a.png" }).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => img.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(img.address() as { port: number }).port}`;
});
after(() => { img.close(); delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS; });

const tmp = () => mkdtempSync(join(tmpdir(), "dn-media-"));

test("sniffImage recognises the five formats and nothing else", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(GIF), "image/gif");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(Buffer.from("\0\0\0\x1cftypavif\0\0\0\0")), "image/avif");
  assert.equal(sniffImage(Buffer.from("<svg xmlns=''/>")), null);
});

test("proxy: fetches, follows redirects, caches (second call never reaches upstream)", async () => {
  const dir = tmp();
  hits = {};
  const m = await loadMedia(dir, `${base}/redir`);
  assert.equal(m.type, "image/png");
  assert.ok(m.bytes.equals(PNG));
  const again = await loadMedia(dir, `${base}/redir`);
  assert.ok(again.bytes.equals(PNG));
  assert.equal(hits["/redir"], 1);
  assert.equal(readdirSync(dir).length, 1);
});

test("proxy: refuses SVG, a lying content type, oversize and 404", async () => {
  const dir = tmp();
  for (const [path, re] of [["/x.svg", /not an accepted image type/], ["/fake.png", /not an image/], ["/big.png", /too large/], ["/missing", /404/]] as const) {
    await assert.rejects(loadMedia(dir, `${base}${path}`), (e: unknown) => e instanceof MediaError && e.status === 502 && re.test(e.message), path);
  }
  assert.equal(readdirSync(dir).length, 0, "nothing refused is cached");
});

test("proxy: private addresses, non-http links and blocked domains are refused", async () => {
  const dir = tmp();
  delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
  try {
    await assert.rejects(loadMedia(dir, `${base}/a.png`), /private|local/);
    await assert.rejects(loadMedia(dir, "http://169.254.169.254/latest/meta-data/"), /private|local/);
  } finally {
    process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  }
  await assert.rejects(loadMedia(dir, "file:///etc/passwd"), MediaError);
  await assert.rejects(loadMedia(dir, `${base}/a.png`, { blockDomains: "127.0.0.1" }), /blocked/);
  assert.ok(blockedHost("https://cdn.evil.com/x.png", "evil.com, other.org"));
  assert.ok(!blockedHost("https://good.com/x.png", "evil.com"));
});

test("cache cap evicts the oldest file first", async () => {
  const dir = tmp();
  const cap = PNG.length + GIF.length + 10; // room for two
  await loadMedia(dir, `${base}/a.png`, { capBytes: cap });
  const [first] = readdirSync(dir);
  utimesSync(join(dir, first!), new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
  await loadMedia(dir, `${base}/b.gif`, { capBytes: cap });
  assert.equal(readdirSync(dir).length, 2);
  writeFileSync(join(dir, "filler"), Buffer.alloc(0));
  await loadMedia(dir, `${base}/b.gif?x=1`, { capBytes: cap }); // a third image: over the cap
  assert.ok(!existsSync(join(dir, first!)), "oldest evicted");
});

// ── The HTTP route, through the real server ──────────────────────────────
let proc: ChildProcess;
let api: string;
let home: string;
const KEY = "share-key-abcdefghijkl";
const ADMIN = "admin-pass-123456";

before(async () => {
  home = tmp();
  const port = 20000 + Math.floor(Math.random() * 20000);
  api = `http://127.0.0.1:${port}`;
  proc = spawn("node", ["--import", "tsx", new URL("../src/main.ts", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), DRIFTNET_HOME: home, DRIFTNET_DB: join(home, "t.db"), DRIFTNET_ACCESS: "private",
      DRIFTNET_TOKEN: ADMIN, DRIFTNET_READ_KEY: KEY, DRIFTNET_ALLOW_PRIVATE_URLS: "1", DRIFTNET_OPEN: "0", CI: "1" },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${api}/api/categories`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
after(() => { proc?.kill(); });

test("route: private catalogue needs the key; item JSON never leaks the original URL; proxy headers; 404s", async () => {
  const pageServer = createServer((_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><title>Pic page</title><meta property="og:image" content="${base}/a.png"><meta property="og:type" content="article"></head><body><article>hello world</article></body></html>`);
  });
  await new Promise<void>((r) => pageServer.listen(0, "127.0.0.1", r));
  const pageUrl = `http://127.0.0.1:${(pageServer.address() as { port: number }).port}/p`;
  try {
    const admin = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
    const ing = await fetch(`${api}/api/ingest`, { method: "POST", headers: admin, body: JSON.stringify({ url: pageUrl }) });
    assert.equal(ing.status, 200);
    const [{ item }] = (await ing.json()) as [{ item: { id: number; media: { src: string }[] } }];
    assert.equal(item.media[0]!.src, `/api/media/${item.id}/0`);
    assert.ok(!JSON.stringify(item).includes(base), "original URL stays server-side");

    // Authorization: no key → 401; wrong key → 401; share key and admin → image.
    // (A proxy header makes the request "not this machine", which is how a tunnel or reverse proxy looks.)
    const remote = { "x-forwarded-for": "203.0.113.9" };
    assert.equal((await fetch(`${api}${item.media[0]!.src}`, { headers: remote })).status, 401);
    assert.equal((await fetch(`${api}${item.media[0]!.src}?key=wrong`, { headers: remote })).status, 401);
    const ok = await fetch(`${api}${item.media[0]!.src}?key=${KEY}`, { headers: remote });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.equal(ok.headers.get("cache-control"), "private, max-age=86400");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("content-security-policy"), "default-src 'none'");
    assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG));
    assert.equal((await fetch(`${api}${item.media[0]!.src}`, { headers: admin })).status, 200);

    // Item JSON from the detail endpoint.
    const one = (await (await fetch(`${api}/api/items/${item.id}?key=${KEY}`)).json()) as { media: { src: string }[] };
    assert.equal(one.media[0]!.src, `/api/media/${item.id}/0`);
    // Missing index / item → 404.
    assert.equal((await fetch(`${api}/api/media/${item.id}/9?key=${KEY}`)).status, 404);
    assert.equal((await fetch(`${api}/api/media/99999/0?key=${KEY}`)).status, 404);

    // Backfill endpoint: write access only.
    const url = `${api}/api/items/${item.id}/media/refresh`;
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${KEY}`, ...remote } })).status, 401);
    const re = await fetch(url, { method: "POST", headers: admin });
    assert.equal(re.status, 200);
    assert.equal(((await re.json()) as { media: unknown[] }).media.length, 1);
    assert.equal((await fetch(`${api}/api/items/99999/media/refresh`, { method: "POST", headers: admin })).status, 404);
  } finally {
    pageServer.close();
  }
});
