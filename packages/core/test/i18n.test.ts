import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES, categoryLabel, categoryLabels, messages, resolveLocale, type Locale } from "../src/i18n.ts";

const BUILTIN_SHELVES = [
  // Default template
  "coding-agent",
  "agent-framework",
  "chat-assistant",
  "image-video",
  "design-frontend",
  "audio-voice",
  "automation",
  "knowledge-rag",
  "model-infra",
  "productivity",
  "news",
  "learning",
  "other",
  // Research template
  "papers",
  "articles",
  "datasets",
  "methods",
  "research-tools",
  "people-talks",
  "to-read",
  // Everyday template
  "cooking",
  "travel",
  "health",
  "money",
  "home",
  "entertainment",
  "shopping",
] as const;

test("LOCALES includes all 6 supported locales", () => {
  const expected: Locale[] = ["en", "zh-TW", "zh-CN", "ja", "ko", "es"];
  assert.deepEqual([...LOCALES].sort(), [...expected].sort());
});

test("resolveLocale honors explicit DRIFTNET_LOCALE over DRIFTNET_LANGUAGE", () => {
  for (const l of LOCALES) {
    assert.equal(resolveLocale({ DRIFTNET_LOCALE: l, DRIFTNET_LANGUAGE: "English" }), l);
  }
  // Unknown explicit locale falls back to DRIFTNET_LANGUAGE.
  assert.equal(resolveLocale({ DRIFTNET_LOCALE: "fr", DRIFTNET_LANGUAGE: "Japanese" }), "ja");
});

test("resolveLocale maps natural DRIFTNET_LANGUAGE values accurately", () => {
  const cases: [string, Locale][] = [
    ["Japanese", "ja"],
    ["日本語", "ja"],
    ["ja-JP", "ja"],
    ["Simplified Chinese", "zh-CN"],
    ["简体中文", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh_Hans", "zh-CN"],
    ["Traditional Chinese (Taiwan)", "zh-TW"],
    ["繁體中文", "zh-TW"],
    ["Chinese", "zh-TW"],
    ["中文", "zh-TW"],
    ["Korean", "ko"],
    ["한국어", "ko"],
    ["ko-KR", "ko"],
    ["Spanish", "es"],
    ["Español", "es"],
    ["es-MX", "es"],
    ["English", "en"],
    ["Portuguese", "en"],
    ["", "en"],
  ];

  for (const [lang, expected] of cases) {
    assert.equal(resolveLocale({ DRIFTNET_LANGUAGE: lang }), expected, `DRIFTNET_LANGUAGE=${JSON.stringify(lang)}`);
  }
});

test("every locale has complete messages matching the en schema", () => {
  const en = messages("en");
  const enKeys = Object.keys(en).sort();
  const enDigestKeys = Object.keys(en.digest).sort();
  const enRichKeys = Object.keys(en.rich).sort();
  const enWorthKeys = Object.keys(en.rich.worthName).sort();

  for (const l of LOCALES) {
    const m = messages(l);
    assert.equal(m.locale, l);
    assert.deepEqual(Object.keys(m).sort(), enKeys);
    assert.deepEqual(Object.keys(m.digest).sort(), enDigestKeys);
    assert.deepEqual(Object.keys(m.rich).sort(), enRichKeys);
    assert.deepEqual(Object.keys(m.rich.worthName).sort(), enWorthKeys);

    // Exercise string fields and formatters.
    assert.ok(m.injection.length > 0);
    assert.ok(m.lowReputation.length > 0);
    assert.ok(m.mentions.length > 0);
    assert.ok(m.listSep.length > 0);
    assert.ok(m.queued.length > 0);
    assert.ok(m.working.length > 0);
    assert.ok(m.needsPage.length > 0);
    assert.ok(m.alsoFound.length > 0);
    assert.ok(m.seenBefore.length > 0);
    assert.ok(m.cached(3).includes("3"));
    assert.ok(m.footer(42).includes("42"));
    assert.ok(m.noItem(42).includes("42"));
    assert.ok(m.votedUp(42).includes("42"));
    assert.ok(m.votedDown(42).includes("42"));
    assert.ok(m.digest.title("daily").length > 0);
    assert.ok(m.digest.title("weekly").length > 0);
    assert.ok(m.digest.counts(1, 2).includes("1"));
    assert.ok(m.digest.counts(5, 3).includes("5"));
    assert.ok(m.digest.sharedTimes(4).includes("4"));
    assert.ok(m.digest.more(7).includes("7"));
    for (const v of Object.values(m.rich.worthName)) assert.ok(v.length > 0);
  }
});

test("every locale has category labels for all 27 built-in shelves", () => {
  const all = categoryLabels([...BUILTIN_SHELVES]);
  for (const id of BUILTIN_SHELVES) {
    for (const l of LOCALES) {
      const label = categoryLabel(id, l);
      assert.ok(label.length > 0, `missing label for ${id} in ${l}`);
      assert.notEqual(label, id, `untranslated id ${id} in ${l}`);
      assert.equal(all[id]?.[l], label);
    }
  }
  assert.equal(categoryLabel("custom-shelf", "ja"), "custom-shelf");
});
