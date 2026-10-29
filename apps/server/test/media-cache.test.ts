import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadMedia, MediaError } from "../src/media.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
let hits = 0;
let img: Server;
let base: string;
before(async () => {
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  img = createServer((req, res) => {
    hits++;
    if (req.url!.startsWith("/ok")) return void res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => img.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(img.address() as { port: number }).port}`;
});
after(() => { img.close(); delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS; });

const tmp = () => mkdtempSync(join(tmpdir(), "dn-media-cache-"));

test("a failed URL is remembered: the second try answers 502 without reaching upstream", async () => {
  const dir = tmp();
  await assert.rejects(loadMedia(dir, `${base}/gone.png`), (e) => e instanceof MediaError && e.status === 502);
  const before = hits;
  await assert.rejects(loadMedia(dir, `${base}/gone.png`), (e) => e instanceof MediaError && e.status === 502 && /404/.test(e.message));
  assert.equal(hits, before);
});

test("eviction goes down to ~90% of the cap, not just under it", async () => {
  const dir = tmp();
  const cap = PNG.length * 4 + 10; // room for four
  for (let i = 0; i < 4; i++) await loadMedia(dir, `${base}/ok?n=${i}`, { capBytes: cap });
  assert.equal(readdirSync(dir).length, 4);
  await loadMedia(dir, `${base}/ok?n=4`, { capBytes: cap }); // over the cap: 90% of it holds three
  assert.equal(readdirSync(dir).length, 3);
});
