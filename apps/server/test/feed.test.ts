import assert from "node:assert/strict";
import { test } from "node:test";
import { createDriftnet } from "@driftnet/core";
import { atomFeed, llmsTxt } from "../src/feeds.ts";

function setup() {
  const dn = createDriftnet({ DRIFTNET_DB: ":memory:", DRIFTNET_HOME: "/nonexistent-driftnet-home" } as NodeJS.ProcessEnv);
  const add = (n: number, over: { worth?: "skip" | "low" | "normal" | "must-see"; flags?: string[]; category?: string; name?: string; one?: string; demo?: string } = {}) =>
    dn.store.upsert({
      url: `https://e.com/${n}`, aliases: [], title: `T${n}`,
      judgement: { isAiTool: 1, category: over.category ?? "other", kind: "repo", worth: over.worth ?? "normal", engine: "llm", confidence: 1 },
      summary: { name: over.name ?? `Tool ${n}`, oneLiner: over.one ?? `one ${n}`, ...(over.demo ? { demo: over.demo } : {}), highlights: [`hi ${n}`], useCases: [], tags: [] },
      flags: over.flags ?? [], source: "e.com",
    });
  return { dn, add };
}

/** Enough of an XML parser to prove tags balance and entities are legal. */
function assertWellFormed(x: string) {
  assert.ok(x.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  assert.equal(/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(x), false, "bare ampersand");
  const stack: string[] = [];
  for (const m of x.replace(/<\?.*?\?>/g, "").matchAll(/<(\/?)([A-Za-z:]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2]);
    else stack.push(m[2]!);
  }
  assert.deepEqual(stack, []);
}

test("feed: well-formed Atom, escaped, skipping what llms.txt skips", () => {
  const { dn, add } = setup();
  add(1, { name: `Fish & <Chips> "x"`, one: "a < b && c" });
  add(2, { worth: "skip" });
  add(3, { flags: ["injection"] });
  const trashed = add(4);
  dn.store.setTrashed(trashed.id, true);
  add(5, { category: "learning" });
  const x = atomFeed(dn, { self: "https://dn.example/feed.xml" });
  assertWellFormed(x);
  assert.equal((x.match(/<entry>/g) ?? []).length, 2);
  assert.ok(x.includes("Fish &amp; &lt;Chips&gt; &quot;x&quot;"));
  assert.ok(x.includes("a &lt; b &amp;&amp; c"));
  assert.ok(x.includes('<link href="https://e.com/1"/>'), "no public URL: links to the tool");
  assert.ok(x.includes('<category term="Learning"/>') || x.includes('<category term="學習資源"/>'));
  assert.ok(!x.includes("e.com/2") && !x.includes("urn:driftnet:item:3>"));
});

test("feed: page links when a public URL exists, folder filter, 50 newest", () => {
  const { dn, add } = setup();
  for (let n = 1; n <= 55; n++) add(n, { category: n % 2 ? "learning" : "other" });
  const all = atomFeed(dn, { self: "s", pageBase: "https://dn.example/?key=k1" });
  assert.equal((all.match(/<entry>/g) ?? []).length, 50);
  assert.match(all, /<link href="https:\/\/dn\.example\/\?key=k1#item-\d+"\/>/);
  const only = atomFeed(dn, { self: "s", folder: "learning" });
  assert.equal((only.match(/<entry>/g) ?? []).length, 28 > 50 ? 50 : 28);
  assertWellFormed(only);
});

test("llms.txt and the feed carry the demo line", () => {
  const { dn, add } = setup();
  add(1, { demo: "Draws ASCII sharks on a canvas." });
  assert.ok(llmsTxt(dn).includes(": one 1 Demo: Draws ASCII sharks on a canvas."));
  assert.ok(atomFeed(dn, { self: "https://dn.example/feed.xml" }).includes("one 1\nDraws ASCII sharks on a canvas."));
});
