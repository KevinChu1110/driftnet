import assert from "node:assert/strict";
import { test } from "node:test";
import { Pipeline, registerExtractor, Store, Summarizer, type LlmProvider } from "../src/index.ts";
import { DEFAULT_CATEGORIES } from "../src/categories.ts";

// Offline fixtures: an article that links a real repo, and one that links nothing.
registerExtractor({
  name: "fixture",
  matches: (u) => u.startsWith("https://fixture.test/"),
  extract: async (url) => ({
    url, kind: "article", title: "A tool", meta: {},
    text: url.endsWith("/linked") ? "Try it: https://github.com/real/tool" : "A tool called tool, no link.",
    outlinks: url.endsWith("/linked") ? ["https://github.com/real/tool"] : [],
  }),
});

function pipelineAnswering(primaryUrl: string) {
  const llm: LlmProvider = {
    label: "fixture",
    complete: async () => ({
      name: "tool", one_liner: "x", highlights: [], use_cases: [], tags: [], primary_url: primaryUrl, mentions: [],
      ai_tool: true, category: "other", kind: "article", worth: "normal",
    }) as any,
  };
  return new Pipeline({ store: new Store(":memory:"), categories: DEFAULT_CATEGORIES, summarizer: new Summarizer(llm, "English") });
}

test("a link the model invented is dropped", async () => {
  const r = await pipelineAnswering("https://github.com/made-up/tool").ingest("https://fixture.test/unlinked", { platform: "t", chatId: "c" });
  assert.equal(r.item.summary?.primaryUrl, undefined);
  assert.equal(r.item.summary?.name, "tool");
});

test("a link that appears in the content is kept", async () => {
  const r = await pipelineAnswering("https://github.com/real/tool").ingest("https://fixture.test/linked", { platform: "t", chatId: "c" });
  assert.equal(r.item.summary?.primaryUrl, "https://github.com/real/tool");
});
