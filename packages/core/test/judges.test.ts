import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDriftnet, registerJudge, type Judge } from "../src/index.ts";
import { JevJudge } from "../src/judge/jev.ts";
import { parseRules, RulesJudge } from "../src/judge/rules.ts";
import { loadPlugins } from "../src/plugins.ts";
import { createProvider } from "../src/llm/index.ts";
import type { Digest } from "../src/types.ts";

// A developer's own ~/.typesafe/api_key would turn Jev on in every "no key" case below.
process.env.HOME = mkdtempSync(join(tmpdir(), "driftnet-nohome-"));
const tmp = (): string => mkdtempSync(join(tmpdir(), "driftnet-judges-"));
const digest = (url: string, over: Partial<Digest> = {}): Digest => ({ url, kind: "article", title: "A page", text: "", outlinks: [], meta: {}, ...over });
const cats = { coding: "Coding — source code, libraries and dev tools", videos: "Videos", cooking: "Cooking — recipes, kitchen, baking bread", other: "Other" };

test("rules: patterns, first match wins, folder by id or name", async () => {
  const { rules, errors } = parseRules(`
# comment
github.com/*  ->  coding
youtube.com -> Videos   # trailing comment
kind:repo -> coding
contains:sourdough -> cooking
*.example.org/blog -> cooking
nonsense line
kind:paper -> coding
`);
  assert.equal(rules.length, 5);
  assert.deepEqual(errors, ['line 8: expected "pattern -> folder"', 'line 9: unknown kind "paper" (use repo, product, video, article, post, other)']);
  const j = new RulesJudge({ rules: "github.com/* -> coding\nyoutube.com -> Videos\ncontains:sourdough -> cooking\n*.example.org/blog -> cooking\nkind:video -> videos\nmissing.test -> deleted-folder" });
  const cat = async (d: Digest) => (await j.judge(d, undefined, cats))?.judgement.category;
  assert.equal(await cat(digest("https://github.com/a/b")), "coding");
  assert.equal(await cat(digest("https://www.youtube.com/watch?v=1")), "videos");
  assert.equal(await cat(digest("https://m.youtube.com/watch?v=1")), "videos", "a bare host covers subdomains");
  assert.equal(await cat(digest("https://notyoutube.com/x")), undefined);
  assert.equal(await cat(digest("https://blog.example.org/blog/post")), "cooking", "* in a host+path pattern matches anything");
  assert.equal(await cat(digest("https://example.org/blog/post")), undefined, "...but *. needs a subdomain");
  assert.equal(await cat(digest("https://evil.test/github.com/x")), undefined, "host+path patterns anchor at the host");
  assert.equal(await cat(digest("https://a.test/", { text: "my Sourdough starter" })), "cooking");
  assert.equal(await cat(digest("https://vimeo.com/1", { kind: "video" })), "videos");
  assert.equal(await cat(digest("https://missing.test/x")), undefined, "a rule naming a folder the reader lacks is skipped");
  const r = (await j.judge(digest("https://github.com/a/b"), undefined, cats))!;
  assert.equal(r.judgement.engine, "rules");
  assert.equal(r.judgement.confidence, 1);
  assert.equal(r.judgement.worth, "normal");
});

test("rules: without rules it uses folder descriptions, and answers null when unsure", async () => {
  const j = new RulesJudge();
  const hit = await j.judge(digest("https://a.test/", { title: "Easy bread baking", text: "recipes for the kitchen: bread, baking, flour" }), undefined, cats);
  assert.equal(hit?.judgement.category, "cooking");
  assert.ok(hit!.judgement.confidence >= 0.4 && hit!.judgement.confidence <= 0.75);
  assert.equal(await j.judge(digest("https://a.test/", { title: "Weather", text: "rain tomorrow" }), undefined, cats), null);
  assert.equal(await j.judge(digest("https://a.test/", { title: "", text: "" }), undefined, cats), null);
});

test("DRIFTNET_JUDGE selects the judge", () => {
  const label = (extra: Record<string, string>) => createDriftnet({ DRIFTNET_HOME: tmp(), ...extra }).engines.judge;
  assert.equal(label({}), "heuristic");
  assert.equal(label({ DRIFTNET_JUDGE: "rules" }), "rules");
  assert.equal(label({ DRIFTNET_JUDGE: "Rules" }), "rules");
  assert.equal(label({ TYPESAFE_API_KEY: "k" }), "jev");
  assert.equal(label({ TYPESAFE_API_KEY: "k", DRIFTNET_JUDGE: "jev" }), "jev");
  for (const off of ["off", "llm", "heuristic"]) assert.equal(label({ TYPESAFE_API_KEY: "k", DRIFTNET_JUDGE: off }), "heuristic");
  assert.equal(label({ TYPESAFE_API_KEY: "k", DRIFTNET_JUDGE: "rules" }), "rules");
  const llm = { DRIFTNET_LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k-12345" };
  assert.equal(label({ ...llm, DRIFTNET_JUDGE: "off" }), "llm");
  assert.equal(createDriftnet({ DRIFTNET_HOME: tmp(), ...llm }).engines.summarizer, "gemini:gemini-flash-latest");
});

test("DRIFTNET_JUDGE=<registered name> and an unknown name", () => {
  const made: NodeJS.ProcessEnv[] = [];
  const mine: Judge = { name: "mine", judge: async () => null };
  registerJudge("Mine", (env) => (made.push(env), mine));
  assert.equal(createDriftnet({ DRIFTNET_HOME: tmp(), DRIFTNET_JUDGE: "mine", TYPESAFE_API_KEY: "k" }).engines.judge, "mine");
  assert.equal(made.length, 1);
  registerJudge("unconfigured", () => undefined);
  assert.equal(createDriftnet({ DRIFTNET_HOME: tmp(), DRIFTNET_JUDGE: "unconfigured" }).engines.judge, "heuristic");
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  try {
    assert.equal(createDriftnet({ DRIFTNET_HOME: tmp(), DRIFTNET_JUDGE: "nope" }).engines.judge, "heuristic");
  } finally {
    console.warn = warn;
  }
  assert.match(warned.join(), /nope is not a built-in or registered judge/);
});

test("rules judge reads DRIFTNET_JUDGE_RULES and judges items end to end", async () => {
  const home = tmp();
  const file = join(home, "rules.txt");
  const dn = createDriftnet({ DRIFTNET_HOME: home, DRIFTNET_JUDGE: "rules", DRIFTNET_JUDGE_RULES: file });
  const folder = Object.keys(dn.categories).find((id) => id !== "other")!;
  writeFileSync(file, `rules-fixture.test -> ${folder}\n`);
  dn.reconfigure({ DRIFTNET_HOME: home, DRIFTNET_JUDGE: "rules", DRIFTNET_JUDGE_RULES: file });
  const judge = (dn.pipeline as unknown as { opts: { judge: Judge } }).opts.judge;
  const r = await judge.judge(digest("https://rules-fixture.test/a"), undefined, dn.categories);
  assert.equal(r?.judgement.category, folder);
});

test("Jev: the endpoint is a constructor option", async () => {
  const urls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ answers: {
      ai_tool: { type: "noul", noul: 0.9 }, category: { type: "choice", choice: "coding", confidence: 0.9 },
      kind: { type: "choice", choice: "repo", confidence: 0.9 }, worth: { type: "score", score: 2 },
    } }));
  }) as typeof fetch;
  try {
    const r1 = await new JevJudge("k", 1000, "https://jev.example.test/x").judge(digest("https://github.com/a/b"), undefined, cats);
    assert.equal(r1?.judgement.category, "coding");
    await new JevJudge("k").judge(digest("https://github.com/a/b"), undefined, cats);
    assert.deepEqual(urls, ["https://jev.example.test/x", "https://api.typesafe.ai/v1/systemone"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("plugins: { extractors, providers, judges } register; old shapes keep working", async () => {
  const home = tmp();
  const dir = join(home, "plugins");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.mjs"), `export default {
    providers: { plugprov: (env) => ({ label: "plug:" + env.DRIFTNET_LLM_MODEL, complete: async () => ({}) }) },
    judges: { plugjudge: () => ({ name: "plugjudge", judge: async () => null }) },
    extractors: [{ name: "plug-ex", matches: () => false, extract: async () => null }],
  };`);
  writeFileSync(join(dir, "b.mjs"), `export const judges = { named: () => ({ name: "named", judge: async () => null }) };`);
  writeFileSync(join(dir, "c.mjs"), `export default () => ({ judges: { fromfn: () => undefined } });`);
  writeFileSync(join(dir, "empty.mjs"), `export default {};`);
  copyFileSync(new URL("../../../examples/plugins/rainbow-judge.mjs", import.meta.url), join(dir, "rainbow.mjs"));
  copyFileSync(new URL("../../../examples/plugins/hackernews.mjs", import.meta.url), join(dir, "hn.mjs"));
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  let loaded: string[];
  try {
    loaded = await loadPlugins({ DRIFTNET_HOME: home });
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(loaded, [
    "plug-ex (a.mjs)", "provider plugprov (a.mjs)", "judge plugjudge (a.mjs)",
    "judge named (b.mjs)", "judge fromfn (c.mjs)", "hackernews (hn.mjs)", "judge rainbow (rainbow.mjs)",
  ]); // load order is by file name: a, b, c, hn, rainbow
  assert.match(warned.join("\n"), /empty\.mjs not loaded: nothing to load/);
  assert.equal(createProvider({ DRIFTNET_LLM_PROVIDER: "plugprov", DRIFTNET_LLM_MODEL: "m" })?.label, "plug:m");
  assert.equal(createDriftnet({ DRIFTNET_HOME: tmp(), DRIFTNET_JUDGE: "plugjudge" }).engines.judge, "plugjudge");
  assert.equal(createDriftnet({ DRIFTNET_HOME: tmp(), DRIFTNET_JUDGE: "named" }).engines.judge, "named");
});

test("example judge plugin files a link and defers otherwise", async () => {
  const mod = (await import(new URL("../../../examples/plugins/rainbow-judge.mjs", import.meta.url).href)).default;
  const judge: Judge = mod.judges.rainbow();
  assert.equal((await judge.judge(digest("https://www.youtube.com/watch?v=1"), undefined, cats))?.judgement.category, "videos");
  assert.equal(await judge.judge(digest("https://example.org/"), undefined, cats), null);
});
