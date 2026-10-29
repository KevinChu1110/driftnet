import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const free = () => new Promise<number>((ok) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });

/** Raw request, so the Host header can be anything. */
const call = (port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => ok({ status: res.statusCode!, headers: res.headers, body: b }));
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
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");

    const h = { host: `localhost:${port}` };
    const saved = JSON.parse((await call(port, "POST", "/api/ingest", h, { url: "https://example.com/feedback-test" })).body) as { item?: { id: number } }[];
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
