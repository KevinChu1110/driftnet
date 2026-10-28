import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { z } from "zod";
import { cleanList, Summarizer } from "../src/summarize.ts";
import { createProvider, IncompleteOutput, parseStructured, type LlmProvider } from "../src/llm/index.ts";
import { OpenAICompatibleProvider } from "../src/llm/openai.ts";
import type { Digest } from "../src/types.ts";

const digest: Digest = { url: "https://github.com/a/b", kind: "repo", title: "a/b", text: "A tool", outlinks: [], meta: {} };
const good = {
  name: " b ", one_liner: "Does a thing", highlights: ["x", "x", " ", "y", "z", "w"], use_cases: ["u"],
  tags: ["#AI", "cli"], primary_url: "not a url", mentions: [{ name: "Foo", open_source: true }, { name: "Foo", open_source: true }],
};

/** A provider that plays back a script of answers and errors. */
function scripted(steps: (object | Error)[]) {
  let calls = 0;
  const llm: LlmProvider = {
    label: "test",
    async complete() {
      const step = steps[calls++]!;
      if (step instanceof Error) throw step;
      return step as any;
    },
  };
  return { s: new Summarizer(llm, "English"), calls: () => calls };
}

test("retries once on an incomplete answer, then normalises the output", async () => {
  const { s, calls } = scripted([new IncompleteOutput("stop_reason=max_tokens"), good]);
  const r = await s.summarize(digest, undefined);
  assert.equal(calls(), 2);
  assert.equal(r.error, undefined);
  assert.equal(r.summary?.name, "b");
  assert.deepEqual(r.summary?.highlights, ["x", "y", "z"]);
  assert.deepEqual(r.summary?.tags, ["ai", "cli"]);
  assert.equal(r.summary?.primaryUrl, undefined);
  assert.deepEqual(r.summary?.mentions, [{ name: "Foo", openSource: true }]);
});

test("does not retry other errors (auth, bad request)", async () => {
  const { s, calls } = scripted([new Error("HTTP 401: bad key"), good]);
  const r = await s.summarize(digest, undefined);
  assert.equal(calls(), 1);
  assert.equal(r.summary, null);
  assert.match(r.error!, /401/);
});

test("gives up after two incomplete answers", async () => {
  const { s, calls } = scripted([new IncompleteOutput("refused"), new IncompleteOutput("refused")]);
  const r = await s.summarize(digest, undefined);
  assert.equal(calls(), 2);
  assert.equal(r.summary, null);
});

test("parseStructured strips code fences and rejects schema mismatches", () => {
  const schema = z.object({ a: z.number() });
  assert.deepEqual(parseStructured(schema, '```json\n{"a": 1}\n```'), { a: 1 });
  assert.throws(() => parseStructured(schema, '{"a": "x"}'), IncompleteOutput);
  assert.throws(() => parseStructured(schema, "not json"), IncompleteOutput);
});

test("createProvider only reads DRIFTNET_LLM_* variables", () => {
  assert.equal(createProvider({ ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "y" }), undefined);
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "off" }), undefined);
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "openai" }), /MODEL/);
  assert.throws(() => createProvider({ DRIFTNET_LLM_PROVIDER: "nope", DRIFTNET_LLM_MODEL: "m" }), /Unknown/);
  assert.equal(
    createProvider({ DRIFTNET_LLM_PROVIDER: "openai", DRIFTNET_LLM_MODEL: "qwen3", DRIFTNET_LLM_BASE_URL: "http://localhost:11434/v1" })!.label,
    "openai:qwen3 @ localhost:11434",
  );
});

test("OpenAI-compatible provider sends a closed JSON schema and validates the reply", async () => {
  let body: any;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    body = JSON.parse(raw);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ a: 2, b: [{ c: "x" }] }) } }] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const llm = new OpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "m" });
    const schema = z.object({ a: z.number(), b: z.array(z.object({ c: z.string() })) });
    const out = await llm.complete({ system: "s", user: "u", schema, schemaName: "t", maxTokens: 10 });
    assert.deepEqual(out, { a: 2, b: [{ c: "x" }] });
    const sent = body.response_format.json_schema.schema;
    assert.equal(sent.additionalProperties, false);
    assert.equal(sent.properties.b.items.additionalProperties, false);
    assert.deepEqual(sent.required, ["a", "b"]);
    assert.equal(sent.$schema, undefined);
  } finally {
    server.close();
  }
});

test("cleanList drops non-strings, blanks, long entries and duplicates", () => {
  assert.deepEqual(cleanList(["a", 1, "", "a", "x".repeat(50), "b", "c"], 2, 10), ["a", "b"]);
  assert.deepEqual(cleanList("nope", 3, 10), []);
});
