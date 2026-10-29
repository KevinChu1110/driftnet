import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { z } from "zod";
import { createProvider, IncompleteOutput, registerProvider } from "../src/llm/index.ts";
import { GeminiProvider } from "../src/llm/gemini.ts";
import { BedrockProvider } from "../src/llm/bedrock.ts";
import { signingKey, signRequest } from "../src/llm/sigv4.ts";
import { parseServiceAccount, signServiceAccountJwt, VertexProvider } from "../src/llm/vertex.ts";
import { AnthropicProvider } from "../src/llm/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/llm/openai.ts";

const schema = z.object({ name: z.string(), n: z.number() });
const req = { system: "SYS", user: "USER", schema, schemaName: "thing", maxTokens: 321 };

interface Call { url: string; init: RequestInit; body: any }
function mockFetch(replies: (Response | ((c: Call) => Response))[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    let body: unknown = raw;
    try { body = JSON.parse(raw); } catch { /* form body */ }
    const call = { url: String(url), init: init ?? {}, body };
    calls.push(call);
    const r = replies.shift();
    if (!r) throw new Error("unexpected fetch");
    return typeof r === "function" ? r(call) : r;
  };
  return { fetch: fn as typeof fetch, calls };
}
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const gem = (text: string, finishReason = "STOP") => json({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });

// ---- Gemini ----

test("gemini: request mapping and response parsing", async () => {
  const m = mockFetch([gem('{"name":"x","n":2}')]);
  const p = new GeminiProvider({ apiKey: "AIza-secret-key", fetch: m.fetch });
  assert.equal(p.label, "gemini:gemini-flash-latest");
  assert.deepEqual(await p.complete(req), { name: "x", n: 2 });
  const c = m.calls[0]!;
  assert.equal(c.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
  assert.equal((c.init.headers as Record<string, string>)["x-goog-api-key"], "AIza-secret-key");
  assert.ok(!c.url.includes("AIza"), "key stays out of the URL");
  assert.equal(c.body.systemInstruction.parts[0].text, "SYS");
  assert.equal(c.body.contents[0].parts[0].text, "USER");
  assert.equal(c.body.generationConfig.maxOutputTokens, 321);
  assert.equal(c.body.generationConfig.responseMimeType, "application/json");
  assert.equal(c.body.generationConfig.responseJsonSchema.type, "object");
  assert.deepEqual(c.body.generationConfig.responseJsonSchema.required, ["name", "n"]);
  assert.equal("$schema" in c.body.generationConfig.responseJsonSchema, false);
});

test("gemini: model option, models/ prefix, thought parts ignored, incomplete outputs", async () => {
  const m = mockFetch([
    json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "thinking…", thought: true }, { text: '{"name":"a","n":1}' }] } }] }),
    gem('{"name":"a"', "MAX_TOKENS"),
    json({ promptFeedback: { blockReason: "SAFETY" } }),
    gem("not json"),
  ]);
  const p = new GeminiProvider({ apiKey: "k-12345", model: "models/gemini-x", fetch: m.fetch });
  assert.deepEqual(await p.complete(req), { name: "a", n: 1 });
  assert.match(m.calls[0]!.url, /models\/gemini-x:generateContent$/);
  for (const re of [/MAX_TOKENS/, /blocked: SAFETY/, /not valid JSON/]) {
    await assert.rejects(p.complete(req), (e: Error) => e instanceof IncompleteOutput && re.test(e.message));
  }
});

test("gemini: vendor message surfaces, key never does; 429/5xx are retryable", async () => {
  const m = mockFetch([
    json({ error: { message: "API key not valid: AIza-secret-key" } }, 400),
    json({ error: { message: "overloaded" } }, 503),
  ]);
  const p = new GeminiProvider({ apiKey: "AIza-secret-key", fetch: m.fetch });
  await assert.rejects(p.complete(req), (e: Error) => !(e instanceof IncompleteOutput) && /HTTP 400: API key not valid: \*\*\*/.test(e.message) && !e.message.includes("secret"));
  await assert.rejects(p.complete(req), (e: Error) => e instanceof IncompleteOutput && /HTTP 503: overloaded/.test(e.message));
});

test("gemini: createProvider reads DRIFTNET_LLM_API_KEY or GEMINI_API_KEY, model optional", () => {
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k-12345" })?.label, "gemini:gemini-flash-latest");
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "gemini", DRIFTNET_LLM_API_KEY: "k-12345", DRIFTNET_LLM_MODEL: "gemini-z" })?.label, "gemini:gemini-z");
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "gemini" }), /GEMINI_API_KEY/);
});

// ---- SigV4 ----

test("sigv4: AWS test-suite vector (get-vanilla)", () => {
  const h = signRequest({
    method: "GET",
    url: "https://example.amazonaws.com/",
    region: "us-east-1",
    service: "service",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
});

test("sigv4: AWS documentation example (IAM ListUsers, signed content-type) and signing key", () => {
  const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  assert.equal(signingKey(secret, "20120215", "us-east-1", "iam").toString("hex"), "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  const h = signRequest({
    method: "GET",
    url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    region: "us-east-1",
    service: "iam",
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: secret },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  assert.match(h.authorization!, /SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
});

test("sigv4: session token is signed; the path is encoded twice", () => {
  const a = signRequest({ method: "POST", url: "https://h.amazonaws.com/model/a%3Ab/converse", body: "{}", region: "r", service: "s", credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" }, date: new Date(0) });
  assert.equal(a["x-amz-security-token"], "T");
  assert.match(a.authorization!, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  // Same request with the colon spelled out must sign differently from a literal-path variant only via encoding.
  const b = signRequest({ method: "POST", url: "https://h.amazonaws.com/model/a/converse", body: "{}", region: "r", service: "s", credentials: { accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" }, date: new Date(0) });
  assert.notEqual(a.authorization, b.authorization);
});

// ---- Bedrock ----

const bedrockReply = (text: string, stopReason = "end_turn") => json({ stopReason, output: { message: { role: "assistant", content: [{ text }] } } });

test("bedrock: signed Converse request and response", async () => {
  const m = mockFetch([bedrockReply('{"name":"b","n":3}')]);
  const p = new BedrockProvider({
    model: "anthropic.claude-x-v1:0",
    region: "us-west-2",
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "very-secret-value", sessionToken: "sess-token-value" },
    fetch: m.fetch,
    now: () => new Date("2026-01-02T03:04:05Z"),
  });
  assert.equal(p.label, "bedrock:anthropic.claude-x-v1:0 @ us-west-2");
  assert.deepEqual(await p.complete(req), { name: "b", n: 3 });
  const c = m.calls[0]!;
  assert.equal(c.url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-x-v1%3A0/converse");
  const h = c.init.headers as Record<string, string>;
  assert.match(h.authorization!, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260102\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(h["x-amz-date"], "20260102T030405Z");
  assert.equal(h["x-amz-security-token"], "sess-token-value");
  assert.ok(!JSON.stringify(h).includes("very-secret-value"));
  assert.match(c.body.system[0].text, /^SYS\n\n.*JSON Schema/s);
  assert.deepEqual(c.body.messages, [{ role: "user", content: [{ text: "USER" }] }]);
  assert.equal(c.body.inferenceConfig.maxTokens, 321);
});

test("bedrock: bearer API key, errors without secrets, stop reasons", async () => {
  const m = mockFetch([bedrockReply('{"name":"b","n":1}'), json({ message: "bad token tok-abcdef" }, 403), bedrockReply('{"name":"b"', "max_tokens"), json({ message: "slow down" }, 429)]);
  const p = new BedrockProvider({ model: "m", region: "eu-west-1", bearerToken: "tok-abcdef", fetch: m.fetch });
  await p.complete(req);
  assert.equal((m.calls[0]!.init.headers as Record<string, string>).authorization, "Bearer tok-abcdef");
  await assert.rejects(p.complete(req), (e: Error) => /HTTP 403: bad token \*\*\*/.test(e.message) && !e.message.includes("tok-abcdef"));
  await assert.rejects(p.complete(req), (e: Error) => e instanceof IncompleteOutput && /max_tokens/.test(e.message));
  await assert.rejects(p.complete(req), (e: Error) => e instanceof IncompleteOutput && /429/.test(e.message));
});

test("bedrock: createProvider reads AWS_* and DRIFTNET_LLM_REGION; bad region rejected", () => {
  const env = { DRIFTNET_LLM_PROVIDER: "bedrock", DRIFTNET_LLM_MODEL: "m", AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" };
  assert.equal(createProvider({ ...env, AWS_REGION: "us-east-1" })?.label, "bedrock:m @ us-east-1");
  assert.equal(createProvider({ ...env, AWS_REGION: "us-east-1", DRIFTNET_LLM_REGION: "eu-west-1" })?.label, "bedrock:m @ eu-west-1");
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "bedrock", DRIFTNET_LLM_MODEL: "m", AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "t" })?.label, "bedrock:m @ us-east-1");
  assert.throws(() => createProvider({ ...env }), /REGION/);
  assert.throws(() => createProvider({ ...env, AWS_REGION: "x.evil.com/" }), /not a valid region/);
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "bedrock", DRIFTNET_LLM_MODEL: "m", AWS_REGION: "us-east-1" }), /AWS_ACCESS_KEY_ID/);
});

// ---- Vertex ----

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const sa = { client_email: "bot@proj.iam.gserviceaccount.com", private_key: privateKey, project_id: "my-proj" };

test("vertex: self-signed JWT verifies with the public key", () => {
  const jwt = signServiceAccountJwt(sa, 1_800_000_000);
  const [h, c, s] = jwt.split(".") as [string, string, string];
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url").toString()), {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url")));
  assert.ok(!createVerify("RSA-SHA256").update(`${h}.${c}x`).verify(publicKey, Buffer.from(s, "base64url")));
});

test("vertex: token exchange, caching until expiry, request mapping", async () => {
  let t = 1_800_000_000_000;
  const m = mockFetch([
    json({ access_token: "ya29.one", expires_in: 3600 }),
    gem('{"name":"v","n":1}'),
    gem('{"name":"v","n":2}'),
    json({ access_token: "ya29.two", expires_in: 3600 }),
    gem('{"name":"v","n":3}'),
  ]);
  const p = new VertexProvider({ model: "gemini-x", region: "europe-west4", serviceAccount: sa, fetch: m.fetch, now: () => t });
  assert.equal(p.label, "vertex:gemini-x @ europe-west4");
  assert.deepEqual(await p.complete(req), { name: "v", n: 1 });
  t += 60_000;
  assert.deepEqual(await p.complete(req), { name: "v", n: 2 });
  assert.equal(m.calls.length, 3, "second request reused the cached token");
  const tok = m.calls[0]!;
  assert.equal(tok.url, "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(tok.body as string);
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url")));
  const gen = m.calls[1]!;
  assert.equal(gen.url, "https://europe-west4-aiplatform.googleapis.com/v1/projects/my-proj/locations/europe-west4/publishers/google/models/gemini-x:generateContent");
  assert.equal((gen.init.headers as Record<string, string>).authorization, "Bearer ya29.one");
  assert.equal(gen.body.generationConfig.responseMimeType, "application/json");
  // Past expiry (minus the one-minute margin): a new token is minted.
  t += 3600_000;
  assert.deepEqual(await p.complete(req), { name: "v", n: 3 });
  assert.equal((m.calls[4]!.init.headers as Record<string, string>).authorization, "Bearer ya29.two");
});

test("vertex: concurrent calls share one token exchange; raw access token skips it", async () => {
  const m = mockFetch([json({ access_token: "tok", expires_in: 3600 }), gem('{"name":"a","n":1}'), gem('{"name":"a","n":1}')]);
  const p = new VertexProvider({ model: "m", region: "us-central1", serviceAccount: sa, fetch: m.fetch });
  await Promise.all([p.complete(req), p.complete(req)]);
  assert.equal(m.calls.filter((c) => c.url.includes("oauth2")).length, 1);
  const raw = mockFetch([gem('{"name":"a","n":1}')]);
  const q = new VertexProvider({ model: "m", region: "global", project: "p1", accessToken: "ya29.raw", fetch: raw.fetch });
  await q.complete(req);
  assert.equal(raw.calls[0]!.url, "https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/m:generateContent");
  assert.equal(raw.calls.length, 1);
});

test("vertex: errors carry the vendor message and no key material", async () => {
  const m = mockFetch([json({ error: "invalid_grant", error_description: "Invalid JWT" }, 400), json({ error: { message: "denied for ya29.tok-secret" } }, 403)]);
  const p = new VertexProvider({ model: "m", region: "us-central1", serviceAccount: sa, fetch: m.fetch });
  await assert.rejects(p.complete(req), (e: Error) => /HTTP 400: invalid_grant/.test(e.message) && !e.message.includes("PRIVATE KEY"));
  const q = new VertexProvider({ model: "m", region: "us-central1", project: "p", accessToken: "ya29.tok-secret", fetch: m.fetch });
  await assert.rejects(q.complete(req), (e: Error) => /HTTP 403: denied for \*\*\*/.test(e.message));
});

test("vertex: createProvider wiring (key file path, inline JSON, project, region, access token)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "driftnet-vertex-"));
  const file = join(dir, "sa.json");
  writeFileSync(file, JSON.stringify(sa));
  const base = { DRIFTNET_LLM_PROVIDER: "vertex", DRIFTNET_LLM_MODEL: "gemini-x" };
  assert.equal(createProvider({ ...base, GOOGLE_APPLICATION_CREDENTIALS: file })?.label, "vertex:gemini-x @ us-central1");
  assert.equal(createProvider({ ...base, DRIFTNET_VERTEX_CREDENTIALS: JSON.stringify(sa), DRIFTNET_LLM_REGION: "asia-east1" })?.label, "vertex:gemini-x @ asia-east1");
  assert.equal(createProvider({ ...base, DRIFTNET_LLM_API_KEY: "ya29.x", GOOGLE_CLOUD_PROJECT: "p" })?.label, "vertex:gemini-x @ us-central1");
  assert.throws(() => createProvider({ ...base, DRIFTNET_LLM_API_KEY: "ya29.x" }), /project/);
  assert.throws(() => createProvider({ ...base }), /service-account key/);
  assert.throws(() => createProvider({ ...base, GOOGLE_APPLICATION_CREDENTIALS: join(dir, "missing.json") }), /can't be read/);
  assert.throws(() => parseServiceAccount('{"private_key":"SECRET-KEY-MATERIAL"}'), (e: Error) => /client_email/.test(e.message) && !e.message.includes("SECRET"));
  assert.throws(() => parseServiceAccount("SECRET-KEY-MATERIAL"), (e: Error) => !e.message.includes("SECRET"));
  assert.throws(() => createProvider({ ...base, DRIFTNET_VERTEX_CREDENTIALS: JSON.stringify(sa), DRIFTNET_LLM_REGION: "a.b/c" }), /not a valid region/);
});

// ---- registry, existing providers ----

test("registerProvider: DRIFTNET_LLM_PROVIDER=<name> uses the registered factory", async () => {
  registerProvider("Fake-Test", (env) => ({ label: `fake:${env.DRIFTNET_LLM_MODEL ?? "-"}`, complete: async () => ({}) as never }));
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "fake-test", DRIFTNET_LLM_MODEL: "m1" })?.label, "fake:m1");
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "nope", DRIFTNET_LLM_MODEL: "m" }), /expected anthropic, openai, gemini, bedrock, vertex, claude-cli, gemini-cli, .*fake-test.*off/);
});

test("existing providers are unchanged", () => {
  assert.ok(createProvider({ DRIFTNET_LLM_PROVIDER: "anthropic", DRIFTNET_LLM_MODEL: "m", DRIFTNET_LLM_API_KEY: "k" }) instanceof AnthropicProvider);
  const o = createProvider({ DRIFTNET_LLM_PROVIDER: "openai", DRIFTNET_LLM_MODEL: "gpt-x", DRIFTNET_LLM_BASE_URL: "http://127.0.0.1:11434/v1" });
  assert.ok(o instanceof OpenAICompatibleProvider);
  assert.equal(o.label, "openai:gpt-x @ 127.0.0.1:11434");
  assert.equal(createProvider({}), undefined);
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "off" }), undefined);
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "openai" }), /DRIFTNET_LLM_MODEL is required/);
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "anthropic", DRIFTNET_LLM_MODEL: "m" }), /DRIFTNET_LLM_API_KEY is required/);
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "claude-cli" })?.label.startsWith("claude"), true);
});
