import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet, type LlmProvider } from "@driftnet/core";
import { detectLocalAi, testAiConnection } from "../src/ai-probe.ts";
import { createApp } from "../src/app.ts";

const PASSWORD = "ai-settings-test-password-1A!";
const READ_KEY = "ai-settings-read-key";
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("detectLocalAi: detects CLIs, Ollama and LM Studio models, filtering embed models and capping counts", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "http://127.0.0.1:11434/api/tags") {
      return mockResponse({
        models: [
          { name: "nomic-embed-text:latest" },
          { name: "llama3.2:latest" },
          { name: "qwen2.5:7b" },
          { name: "mxbai-embed-large" },
          { name: "mistral:latest" },
          { name: "gemma3:4b" },
          { name: "deepseek-r1:8b" },
          { name: "phi4:latest" }, // 6th non-embed -> should be capped at 5
        ],
      });
    }
    if (url === "http://127.0.0.1:1234/v1/models") {
      return mockResponse({
        data: [
          { id: "text-embedding-nomic" },
          { id: "lm-model-1" },
          { id: "lm-model-2" },
          { id: "lm-model-3" },
          { id: "lm-model-4" }, // 4th non-embed -> should be capped at 3
        ],
      });
    }
    throw new Error(`unexpected url: ${url}`);
  };

  const detected = await detectLocalAi({
    hasBin: (name) => name === "claude" || name === "gemini",
    fetch: fakeFetch,
  });

  assert.equal(detected.length, 2 + 5 + 3);
  assert.deepEqual(detected[0], {
    id: "claude-cli",
    label: "Claude Code (claude-cli)",
    kind: "cli",
    values: { DRIFTNET_LLM_PROVIDER: "claude-cli", DRIFTNET_LLM_MODEL: "haiku", DRIFTNET_LLM_BASE_URL: "" },
  });
  assert.deepEqual(detected[1], {
    id: "gemini-cli",
    label: "Gemini CLI (gemini-cli)",
    kind: "cli",
    values: { DRIFTNET_LLM_PROVIDER: "gemini-cli", DRIFTNET_LLM_MODEL: "", DRIFTNET_LLM_BASE_URL: "" },
  });

  const ollama = detected.filter((d) => d.id.startsWith("ollama:"));
  assert.deepEqual(ollama.map((d) => d.id), [
    "ollama:llama3.2:latest",
    "ollama:qwen2.5:7b",
    "ollama:mistral:latest",
    "ollama:gemma3:4b",
    "ollama:deepseek-r1:8b",
  ]);
  assert.deepEqual(ollama[0], {
    id: "ollama:llama3.2:latest",
    label: "Ollama — llama3.2:latest",
    kind: "local",
    values: {
      DRIFTNET_LLM_PROVIDER: "openai",
      DRIFTNET_LLM_MODEL: "llama3.2:latest",
      DRIFTNET_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
    },
  });

  const lm = detected.filter((d) => d.id.startsWith("lmstudio:"));
  assert.deepEqual(lm.map((d) => d.id), [
    "lmstudio:lm-model-1",
    "lmstudio:lm-model-2",
    "lmstudio:lm-model-3",
  ]);
  assert.deepEqual(lm[0], {
    id: "lmstudio:lm-model-1",
    label: "LM Studio — lm-model-1",
    kind: "local",
    values: {
      DRIFTNET_LLM_PROVIDER: "openai",
      DRIFTNET_LLM_MODEL: "lm-model-1",
      DRIFTNET_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
    },
  });
});

test("detectLocalAi: handles unreachable local servers gracefully without throwing", async () => {
  const detected = await detectLocalAi({
    hasBin: (name) => name === "claude",
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(detected.length, 1);
  assert.equal(detected[0]!.id, "claude-cli");

  const empty = await detectLocalAi({
    hasBin: () => false,
    fetch: async () => new Response("error", { status: 500 }),
  });
  assert.deepEqual(empty, []);
});

test("testAiConnection: success, dispose called, failure, and no provider configured", async () => {
  let disposed = false;
  const okRes = await testAiConnection(
    {},
    { DRIFTNET_LLM_PROVIDER: "openai", DRIFTNET_LLM_MODEL: "gpt-4o-mini" },
    {
      createProvider: () => ({
        label: "openai:gpt-4o-mini",
        complete: async () => ({ ok: true }) as never,
        dispose: () => { disposed = true; },
      } as LlmProvider & { dispose: () => void }),
    },
  );
  assert.equal(okRes.ok, true);
  if (okRes.ok) {
    assert.equal(okRes.provider, "openai:gpt-4o-mini");
    assert.equal(typeof okRes.ms, "number");
    assert.ok(okRes.ms >= 0);
  }
  assert.equal(disposed, true);

  let disposedOnErr = false;
  const failRes = await testAiConnection(
    {},
    { DRIFTNET_LLM_PROVIDER: "openai", DRIFTNET_LLM_MODEL: "gpt-4o-mini" },
    {
      createProvider: () => ({
        label: "openai:gpt-4o-mini",
        complete: async () => { throw new Error("401 invalid api key"); },
        dispose: () => { disposedOnErr = true; },
      } as LlmProvider & { dispose: () => void }),
    },
  );
  assert.deepEqual(failRes, { ok: false, error: "401 invalid api key" });
  assert.equal(disposedOnErr, true);

  const noneRes = await testAiConnection(
    {},
    {},
    { createProvider: () => undefined },
  );
  assert.deepEqual(noneRes, { ok: false, error: "No AI provider configured" });
});

test("testAiConnection: keeps existing secret on empty string, deletes on null, ignores non-model keys, rejects invalid values", async () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const res = await testAiConnection(
    { DRIFTNET_LLM_API_KEY: "sk-existing", DRIFTNET_TOKEN: "keep-me" },
    {
      DRIFTNET_LLM_PROVIDER: "openai",
      DRIFTNET_LLM_MODEL: "gpt-4o-mini",
      DRIFTNET_LLM_API_KEY: "",
      DRIFTNET_TOKEN: "should-be-ignored",
    },
    {
      createProvider: (e) => {
        seenEnv = e;
        return { label: "openai:gpt-4o-mini", complete: async () => ({ ok: true }) as never };
      },
    },
  );
  assert.equal(res.ok, true);
  assert.equal(seenEnv?.DRIFTNET_LLM_API_KEY, "sk-existing");
  assert.equal(seenEnv?.DRIFTNET_TOKEN, "keep-me");

  let seenCleared: NodeJS.ProcessEnv | undefined;
  await testAiConnection(
    { DRIFTNET_LLM_API_KEY: "sk-existing" },
    { DRIFTNET_LLM_PROVIDER: "openai", DRIFTNET_LLM_MODEL: "gpt-4o-mini", DRIFTNET_LLM_API_KEY: null },
    {
      createProvider: (e) => {
        seenCleared = e;
        return { label: "openai:gpt-4o-mini", complete: async () => ({ ok: true }) as never };
      },
    },
  );
  assert.equal(seenCleared?.DRIFTNET_LLM_API_KEY, undefined);

  const badType = await testAiConnection({}, { DRIFTNET_LLM_MODEL: 123 });
  assert.equal(badType.ok, false);
  if (!badType.ok) assert.match(badType.error, /must be text/);

  const badChoice = await testAiConnection({}, { DRIFTNET_LLM_PROVIDER: "not-a-provider" });
  assert.equal(badChoice.ok, false);
  if (!badChoice.ok) assert.match(badChoice.error, /must be one of/);

  const badUrl = await testAiConnection({}, { DRIFTNET_LLM_BASE_URL: "file:///etc/passwd" });
  assert.equal(badUrl.ok, false);
  if (!badUrl.ok) assert.match(badUrl.error, /http\(s\) URL/);
});

async function startServer(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-ai-routes-")),
    DRIFTNET_JUDGE: "off",
    DRIFTNET_LOCALE: "en",
    ...extra,
  };
  const dn = createDriftnet(env);
  const server = createApp({ dn, env, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  let n = 0;
  const call = (
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; body?: unknown; local?: boolean; rawBody?: string } = {},
  ) =>
    new Promise<{ status: number; body: string }>((ok, fail) => {
      const headers: Record<string, string> = {
        ...(opts.local ? {} : { "x-forwarded-for": `203.0.113.${(++n % 250) + 1}` }),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      };
      const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => ok({ status: res.statusCode!, body: b }));
      });
      r.on("error", fail);
      r.end(opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    });
  return { call, port };
}

test("HTTP routes: /api/settings/detect-ai and /api/settings/test-ai enforce password, local-only without password, and settingsShape", async () => {
  const { call, port } = await startServer({ DRIFTNET_TOKEN: PASSWORD, DRIFTNET_READ_KEY: READ_KEY });
  const auth = { authorization: `Bearer ${PASSWORD}` };

  // No credentials -> 403
  assert.equal((await call("GET", "/api/settings/detect-ai")).status, 403);
  assert.equal((await call("POST", "/api/settings/test-ai", { body: { values: {} } })).status, 403);

  // Read-only key -> 403
  assert.equal((await call("GET", "/api/settings/detect-ai", { headers: { authorization: `Bearer ${READ_KEY}` } })).status, 403);
  assert.equal((await call("POST", "/api/settings/test-ai", { headers: { authorization: `Bearer ${READ_KEY}` }, body: { values: {} } })).status, 403);

  // settingsShape: foreign Origin -> 403 even with valid password
  assert.equal(
    (await call("GET", "/api/settings/detect-ai", { headers: { ...auth, origin: "https://evil.test" } })).status,
    403,
  );
  assert.equal(
    (await call("POST", "/api/settings/test-ai", { headers: { ...auth, origin: "https://evil.test" }, body: { values: {} } })).status,
    403,
  );

  // settingsShape: POST without application/json content-type -> 403
  assert.equal(
    (await call("POST", "/api/settings/test-ai", { headers: { ...auth, "content-type": "text/plain" }, rawBody: "{}" })).status,
    403,
  );

  // Valid password + same-origin + JSON -> works (no provider configured -> 400 with ok:false)
  const testRes = await call("POST", "/api/settings/test-ai", {
    headers: { ...auth, origin: `http://127.0.0.1:${port}` },
    body: { values: {} },
  });
  assert.equal(testRes.status, 400);
  assert.deepEqual(JSON.parse(testRes.body), { ok: false, error: "No AI provider configured" });

  // No password set: remote (forwarded) refused with hint; local allowed
  const noPw = await startServer({});
  const remoteDetect = await noPw.call("GET", "/api/settings/detect-ai");
  assert.equal(remoteDetect.status, 403);
  assert.match(JSON.parse(remoteDetect.body).error, /admin password/);

  const remoteTest = await noPw.call("POST", "/api/settings/test-ai", { body: { values: {} } });
  assert.equal(remoteTest.status, 403);
  assert.match(JSON.parse(remoteTest.body).error, /admin password/);

  const localTest = await noPw.call("POST", "/api/settings/test-ai", { local: true, body: { values: {} } });
  assert.equal(localTest.status, 400);
  assert.deepEqual(JSON.parse(localTest.body), { ok: false, error: "No AI provider configured" });
});
