import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { cleanList, resolveSummaryProfile, Summarizer } from "../src/summarize.ts";
import { Store } from "../src/store.ts";
import type { Digest } from "../src/types.ts";

const digest: Digest = { url: "https://github.com/a/b", kind: "repo", title: "a/b", text: "A tool", outlinks: [], meta: {} };
const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const good = {
  name: " b ", one_liner: "Does a thing", highlights: ["x", "x", " ", "y", "z", "w"], use_cases: ["u"],
  tags: ["#AI", "cli"], primary_url: "not a url", mentions: [{ name: "Foo", open_source: true }, { name: "Foo", open_source: true }],
};

/** Replaces the SDK call with a scripted sequence of responses or errors. */
function scripted(steps: (object | Error)[]) {
  const s = new Summarizer("test-key", "English", { model: "claude-haiku-5-5", effort: "low" });
  let calls = 0;
  (s as any).client.messages.parse = async () => {
    const step = steps[calls++]!;
    if (step instanceof Error) throw step;
    return step;
  };
  return { s, calls: () => calls };
}

test("retries once when the output is truncated, and counts both attempts", async () => {
  const { s, calls } = scripted([
    { stop_reason: "max_tokens", parsed_output: null, usage },
    { stop_reason: "end_turn", parsed_output: good, usage },
  ]);
  const r = await s.summarize(digest, undefined);
  assert.equal(calls(), 2);
  assert.equal(r.error, undefined);
  assert.equal(r.inputTokens, 2000);
  assert.ok(Math.abs(r.costUsd - 2 * (1000 * 0.1e-6 + 200 * 0.5e-6)) < 1e-12);
  // lenient in, strict out
  assert.equal(r.summary?.name, "b");
  assert.deepEqual(r.summary?.highlights, ["x", "y", "z"]);
  assert.deepEqual(r.summary?.tags, ["ai", "cli"]);
  assert.equal(r.summary?.primaryUrl, undefined);
  assert.deepEqual(r.summary?.mentions, [{ name: "Foo", openSource: true }]);
});

test("does not retry auth errors and reports the failure", async () => {
  const err = new Anthropic.AuthenticationError(401, { error: { message: "bad key" } }, "bad key", new Headers());
  const { s, calls } = scripted([err, { stop_reason: "end_turn", parsed_output: good, usage }]);
  const r = await s.summarize(digest, undefined);
  assert.equal(calls(), 1);
  assert.equal(r.summary, null);
  assert.ok(r.error);
});

test("gives up after two incomplete outputs", async () => {
  const { s, calls } = scripted([
    { stop_reason: "refusal", parsed_output: null, usage },
    { stop_reason: "refusal", parsed_output: null, usage },
  ]);
  const r = await s.summarize(digest, undefined);
  assert.equal(calls(), 2);
  assert.equal(r.summary, null);
  assert.match(r.error!, /refusal/);
});

test("effort typo falls back to low", () => {
  assert.deepEqual(resolveSummaryProfile({ DRIFTNET_SUMMARY_EFFORT: "hgih" }), { model: "claude-haiku-5-5", effort: "low" });
  assert.deepEqual(resolveSummaryProfile({ DRIFTNET_SUMMARY_MODEL: "claude-sonnet-5-5", DRIFTNET_SUMMARY_EFFORT: "medium" }), {
    model: "claude-sonnet-5-5", effort: "medium",
  });
});

test("cleanList drops non-strings, blanks, long entries and duplicates", () => {
  assert.deepEqual(cleanList(["a", 1, "", "a", "x".repeat(50), "b", "c"], 2, 10), ["a", "b"]);
  assert.deepEqual(cleanList("nope", 3, 10), []);
});

test("usage report sums calls per month and counts cache hits", () => {
  const store = new Store(":memory:");
  store.logUsage({ step: "judge", model: "jev-latest", url: "u", inputTokens: 2000, costUsd: 0.000084 });
  store.logUsage({ step: "summary", model: "claude-haiku-5-5", url: "u", inputTokens: 1500, outputTokens: 300, costUsd: 0.0003, ok: false });
  const j = { isAiTool: 1, category: "other", kind: "repo" as const, worth: "normal" as const, engine: "jev" as const, confidence: 1 };
  const item = store.upsert({ url: "u", aliases: [], title: "t", judgement: j, summary: null, costUsd: 0, flags: [], source: "s" });
  store.recordShare(item.id, { platform: "line", chatId: "c" });
  store.recordShare(item.id, { platform: "line", chatId: "c" });
  const r = store.usageReport();
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows.find((x) => x.step === "summary")!.failed, 1);
  assert.ok(Math.abs(r.totalUsd - 0.000384) < 1e-12);
  assert.equal(r.cacheHits, 1);
});
