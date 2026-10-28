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

test("page content from a logged-in browser is used and can rescue an unsummarised item", async () => {
  const prompts: string[] = [];
  let answer = true;
  const llm: LlmProvider = {
    label: "fixture",
    complete: async (req) => {
      prompts.push(req.user);
      if (!answer) throw new Error("HTTP 401");
      return {
        name: "tool", one_liner: "x", highlights: [], use_cases: [], tags: [], primary_url: "", mentions: [],
        ai_tool: true, category: "other", kind: "post", worth: "normal",
      } as any;
    },
  };
  const p = new Pipeline({ store: new Store(":memory:"), categories: DEFAULT_CATEGORIES, summarizer: new Summarizer(llm, "English") });
  const ctx = { platform: "chrome", chatId: "c" };

  answer = false; // first pass: login wall, model unavailable → stored without a summary
  const first = await p.ingest("https://fixture.test/unlinked", ctx);
  assert.equal(first.item.summary, null);

  answer = true;
  const page = { text: "The real post text, only visible when logged in. Repo in comments:", links: ["https://tool.example/docs", "https://fixture.test/other"] };
  const second = await p.ingest("https://fixture.test/unlinked", ctx, 0, page);
  assert.equal(second.cached, false);
  assert.equal(second.item.summary?.name, "tool");
  const prompt = prompts.at(-1)!;
  assert.match(prompt, /only visible when logged in/);
  assert.match(prompt, /https:\/\/tool\.example\/docs/);
  assert.doesNotMatch(prompt, /fixture\.test\/other/); // same-site links are dropped

  // Once summarised, the same link is a cache hit even with page content.
  assert.equal((await p.ingest("https://fixture.test/unlinked", ctx, 0, page)).cached, true);
});

test("a repo seen only by the browser is catalogued even when the post is already known", async () => {
  registerExtractor({
    name: "fixture-repo",
    matches: (u) => u === "https://github.com/acme/skills",
    extract: async (url) => ({ url, kind: "repo", title: "acme/skills", text: "Skills", outlinks: [], meta: {} }),
  });
  const p = pipelineAnswering("");
  const ctx = { platform: "chrome", chatId: "c" };
  await p.ingest("https://fixture.test/unlinked", ctx);
  const again = await p.ingest("https://fixture.test/unlinked", ctx, 0, {
    text: "post", links: ["https://l.example/redirect", "https://github.com/acme/skills?fbclid=abc"],
  });
  assert.equal(again.cached, true);
  assert.equal(again.related?.[0]?.item.url, "https://github.com/acme/skills");
});
