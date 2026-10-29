import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES, messages, renderLink, renderText, type IngestResult } from "../src/index.ts";

const r = {
  item: {
    id: 12, url: "https://x.test/a", title: "Tool", category: "other", worth: "normal", flags: [], source: "x.test", shareCount: 1, pending: false,
    summary: { name: "Tool", oneLiner: "Does a thing", highlights: ["fast"], useCases: [], tags: [], primaryUrl: "https://x.test/a" },
  },
  cached: false,
} as unknown as IngestResult;

test("the plain replies are unchanged (they are the fallback for every rich reply)", () => {
  const t = messages("en");
  assert.equal(renderLink(r, "https://dn.example", t), "📌 Tool｜Other\nhttps://dn.example/#item-12");
  assert.equal(renderText(r, "https://dn.example", t), "📌 Tool｜Other\nDoes a thing\n• fast\nhttps://x.test/a\nhttps://dn.example/#item-12");
});

test("every locale words the rich replies, with the same keys", () => {
  const keys = (l: (typeof LOCALES)[number]) => JSON.stringify(Object.keys(messages(l).rich).sort()) + JSON.stringify(Object.keys(messages(l).rich.worthName).sort());
  assert.equal(new Set(LOCALES.map(keys)).size, 1);
  for (const l of LOCALES) assert.ok(Object.values(messages(l).rich.worthName).every(Boolean));
  assert.equal(messages("zh-TW").rich.open, "開啟");
});
