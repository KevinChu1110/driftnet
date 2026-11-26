import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const free = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

/** Raw request, so the Host header can be anything. */
const call = (port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string; raw: Buffer }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        ok({ status: res.statusCode!, headers: res.headers, body: raw.toString("utf8"), raw });
      });
    });
    r.on("error", fail);
    r.end(body ? JSON.stringify(body) : undefined);
  });

test("server: host guard (421), page security headers, and feedback validation", async () => {
  const port = await free();
  const home = mkdtempSync(join(tmpdir(), "driftnet-srv-"));
  const child = spawn(process.execPath, ["--import", "tsx", new URL("../src/main.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PORT: String(port), DRIFTNET_HOME: home, DRIFTNET_DB: join(home, "t.db"), DRIFTNET_OPEN: "0", DRIFTNET_LLM_PROVIDER: "", DRIFTNET_JUDGE: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((ok, fail) => {
      const t = setTimeout(() => fail(new Error("server did not start")), 20_000);
      child.stdout!.on("data", (c) => { if (String(c).includes("driftnet on")) { clearTimeout(t); ok(); } });
      child.on("exit", () => fail(new Error("server exited")));
    });
    const bad = await call(port, "GET", "/api/folders", { host: "evil.example.com" });
    assert.equal(bad.status, 421);
    assert.equal((await call(port, "GET", "/", { host: "evil.example.com" })).status, 421);
    assert.equal((await call(port, "GET", "/api/folders", { host: `localhost:${port}` })).status, 200);

    const page = await call(port, "GET", "/", { host: `localhost:${port}` });
    const csp = String(page.headers["content-security-policy"]);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), "script-src must not allow unsafe-inline");
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce && nonce.length >= 16, "script-src carries a random nonce");
    assert.ok(page.body.includes(`<script nonce="${nonce}">`), "inline script carries the matching nonce");
    const page2 = await call(port, "GET", "/", { host: `localhost:${port}` });
    assert.notEqual(/script-src 'self' 'nonce-([^']+)'/.exec(String(page2.headers["content-security-policy"]))?.[1], nonce, "nonce rotates per request");
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["vary"], "accept-encoding");
    assert.equal(page.headers["content-encoding"], undefined);

    const brPage = await call(port, "GET", "/", { host: `localhost:${port}`, "accept-encoding": "gzip, deflate, br" });
    assert.equal(brPage.status, 200);
    assert.equal(brPage.headers["content-encoding"], "br");
    assert.equal(brPage.headers["vary"], "accept-encoding");
    assert.ok(brPage.raw.length < page.raw.length, "brotli payload is smaller than uncompressed HTML");
    const brNonce = /script-src 'self' 'nonce-([^']+)'/.exec(String(brPage.headers["content-security-policy"]))?.[1];
    assert.ok(brNonce && brNonce.length >= 16);
    const brHtml = brotliDecompressSync(brPage.raw).toString("utf8");
    assert.ok(brHtml.includes(`<script nonce="${brNonce}">`), "brotli HTML carries the matching nonce");

    const gzipPage = await call(port, "GET", "/", { host: `localhost:${port}`, "accept-encoding": "gzip, deflate" });
    assert.equal(gzipPage.status, 200);
    assert.equal(gzipPage.headers["content-encoding"], "gzip");
    assert.equal(gzipPage.headers["vary"], "accept-encoding");
    assert.ok(gzipPage.raw.length < page.raw.length, "gzip payload is smaller than uncompressed HTML");
    const gzipNonce = /script-src 'self' 'nonce-([^']+)'/.exec(String(gzipPage.headers["content-security-policy"]))?.[1];
    assert.ok(gzipNonce && gzipNonce.length >= 16);
    const gzipHtml = gunzipSync(gzipPage.raw).toString("utf8");
    assert.ok(gzipHtml.includes(`<script nonce="${gzipNonce}">`), "gzip HTML carries the matching nonce");

    const h = { host: `localhost:${port}` };
    const saved = JSON.parse((await call(port, "POST", "/api/ingest", h, { url: "https://example.com/feedback-test", page: { title: "Feedback test", text: "A page the extension already read, so nothing is fetched." } })).body) as { item?: { id: number } }[];
    const id = saved[0]?.item?.id;
    assert.ok(id, "ingest returned an item");
    {
      assert.equal((await call(port, "POST", `/api/items/${id}/feedback`, h, { vote: "sideways" })).status, 400);
      assert.equal((await call(port, "POST", `/api/items/${id}/feedback`, h, {})).status, 400);
      assert.equal((await call(port, "POST", `/api/items/${id}/feedback`, h, { vote: "up", voter: "spoof", reason: "x".repeat(1000) })).status, 200);
    }
  } finally {
    child.kill();
  }
});
