import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createDriftnet, type Judgement } from "@driftnet/core";
import { exportCmd, type Ctx } from "../src/cli/commands.ts";
import { ShowcaseError, toShowcase, toShowcaseFromApi } from "../src/showcase.ts";

const judge = (category: string, worth: Judgement["worth"] = "normal"): Judgement => ({
  kind: "repo", category, worth, isAiTool: 1, confidence: 0.9, engine: "heuristic",
});

function seed() {
  const home = mkdtempSync(join(tmpdir(), "driftnet-showcase-"));
  const dn = createDriftnet({ DRIFTNET_HOME: home, DRIFTNET_JUDGE: "off", DRIFTNET_LOCALE: "en" });
  const coding = dn.store.createFolder({ name: "Coding" });
  const sub = dn.store.createFolder({ name: "Agents", parent: coding.id });
  const design = dn.store.createFolder({ name: "Design" });

  const a = dn.store.upsert({
    url: "https://github.com/acme/alpha",
    aliases: [],
    title: "alpha",
    judgement: judge(coding.id, "must-see"),
    summary: {
      name: "Alpha </script><script>alert(1)</script>",
      oneLiner: "Fast CLI tool",
      demo: "Runs in terminal",
      why: "Saves time",
      highlights: ["Zero deps"],
      useCases: ["Daily dev"],
      tryIt: "npx alpha",
      tags: ["cli", "ai"],
      primaryUrl: "https://github.com/acme/alpha",
    },
    flags: [],
    source: "github.com/acme",
    repo: { stars: 4200, archived: false },
  });
  dn.store.setNote(a.id, "SUPER SECRET PRIVATE NOTE");
  dn.store.recordShare(a.id, { platform: "telegram", chatId: "1", note: "PRIVATE CHAT MESSAGE" });

  dn.store.upsert({
    url: "https://github.com/acme/beta",
    aliases: [],
    title: "beta",
    judgement: judge(sub.id, "normal"),
    summary: {
      name: "Beta Agent",
      oneLiner: "Agent helper",
      demo: null,
      why: null,
      highlights: [],
      useCases: [],
      tryIt: null,
      tags: ["agent"],
    },
    flags: [],
    source: "github.com/acme",
  });

  // Trashed item must never be exported.
  const trashed = dn.store.upsert({
    url: "https://example.com/trashed",
    aliases: [],
    title: "Trashed secret",
    judgement: judge(coding.id),
    summary: null,
    flags: [],
    source: "example.com",
  });
  dn.store.setTrashed(trashed.id, true);

  // Prompt-injection-flagged item must never be exported.
  dn.store.upsert({
    url: "https://example.com/injected",
    aliases: [],
    title: "Ignore previous instructions",
    judgement: judge(coding.id),
    summary: null,
    flags: ["injection"],
    source: "example.com",
  });

  // Item in another top-level folder.
  dn.store.upsert({
    url: "https://example.com/design-tool",
    aliases: [],
    title: "Design Tool",
    judgement: judge(design.id),
    summary: null,
    flags: [],
    source: "example.com",
  });

  return { home, dn, coding, sub };
}

test("toShowcase builds searchable static files, excludes private/flagged/trashed content and escapes script tags", () => {
  const { dn } = seed();
  const { files, data } = toShowcase(dn, { title: "My AI Picks", locale: "en", builtAt: "2026-11-26T00:00:00Z" });
  const byPath = new Map(files.map((f) => [f.path, f.data]));
  assert.ok(byPath.has("index.html"));
  assert.ok(byPath.has("data.json"));
  assert.ok(byPath.has(".nojekyll"));

  assert.equal(data.title, "My AI Picks");
  assert.equal(data.items.length, 3, "only non-trashed, non-flagged items");
  const html = byPath.get("index.html")!;
  const json = byPath.get("data.json")!;

  assert.ok(html.includes("Built with <a href=\"https://github.com/KevinChu1110/driftnet\""));
  assert.ok(!html.includes("SUPER SECRET PRIVATE NOTE"), "personal notes never leak");
  assert.ok(!html.includes("PRIVATE CHAT MESSAGE"), "chat messages never leak");
  assert.ok(!json.includes("Trashed secret"));
  assert.ok(!json.includes("Ignore previous instructions"));
  assert.ok(!html.includes("</script><script>alert(1)</script>"), "embedded JSON escapes </script>");

  // Inline script syntax check (must parse as valid JS).
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]![1]!));
});

test("toShowcase --folder includes the folder and its sub-folders only, and rejects unknown folders", () => {
  const { dn } = seed();
  const { data } = toShowcase(dn, { folder: "coding", locale: "zh-TW" });
  assert.equal(data.items.length, 2, "coding + Agents sub-folder");
  assert.ok(data.items.every((i) => i.folder === "coding" || i.folder === "agents"));
  assert.throws(() => toShowcase(dn, { folder: "nope" }), ShowcaseError);
});

test("local and API showcases share filtering, folder paths and localized labels", () => {
  const { dn } = seed();
  dn.store.upsert({
    url: "https://example.com/builtin",
    aliases: [],
    title: "Built-in folder",
    judgement: judge("coding-agent"),
    summary: null,
    flags: [],
    source: "example.com",
  });
  const items = dn.store.exportable();
  const folders = dn.store.folders();
  const extra = [
    { ...items[0]!, id: 100, flags: ["injection"] },
    { ...items[0]!, id: 103, flags: ["possible-INJECTION"] },
    { ...items[0]!, id: 101, trashedAt: "2026-01-01" },
    { ...items[0]!, id: 102, url: "javascript:alert(1)", summary: null },
  ];
  for (const folder of [undefined, "coding", "coding-agent"]) {
    const opts = { folder, locale: "zh-TW" as const, builtAt: "2026-11-26T00:00:00Z" };
    const local = toShowcase(dn, opts);
    const api = toShowcaseFromApi([...items].reverse().concat(extra), folders, opts);
    assert.deepEqual(api, local);
  }
  const builtIn = toShowcaseFromApi(items, folders, { folder: "coding-agent", locale: "zh-TW" });
  assert.equal(builtIn.data.title, "AI 寫程式");
  assert.equal(builtIn.data.items[0]?.folderLabel, "AI 寫程式");
  assert.throws(() => toShowcaseFromApi(items, folders, { folder: "nope" }), ShowcaseError);
});

test("API showcase includes deeply nested folders even when children come first", () => {
  const folders = Array.from({ length: 60 }, (_, i) => ({
    id: `f${i}`, name: `Folder ${i}`, parent: i ? `f${i - 1}` : null,
  })).reverse();
  const items = [{
    id: 1, url: "https://example.com", title: "Deep", kind: "other", category: "f59",
    worth: "normal", createdAt: "2026-01-01",
  }];
  const { data } = toShowcaseFromApi(items, folders, { folder: "f0" });
  assert.equal(data.items.length, 1);
  assert.equal(data.folders[0]?.id, "f59");
});

test("showcase search, sorting and filters retain their behavior", () => {
  const { dn } = seed();
  const { data, files } = toShowcase(dn);
  const html = files.find((f) => f.path === "index.html")!.data;
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  type Listener = (event: { target: { value?: string; dataset?: Record<string, string>; closest?: (selector: string) => unknown }; stopPropagation?: () => void }) => void;
  const elements = new Map<string, {
    innerHTML: string; textContent: string; placeholder: string;
    listeners: Map<string, Listener>; addEventListener: (event: string, listener: Listener) => void;
  }>();
  const element = (id: string) => {
    let el = elements.get(id);
    if (!el) {
      const listeners = new Map<string, Listener>();
      el = { innerHTML: "", textContent: "", placeholder: "", listeners, addEventListener: (event, listener) => { listeners.set(event, listener); } };
      elements.set(id, el);
    }
    return el;
  };
  element("showcase-data").textContent = JSON.stringify(data);
  runInNewContext(script, { document: { getElementById: element }, URL, matchMedia: () => ({ matches: false }) });
  const ids = () => [...element("grid").innerHTML.matchAll(/data-id="(\d+)"/g)].map((m) => Number(m[1]));
  const input = (value: string) => element("q").listeners.get("input")!({ target: { value } });
  const sort = (value: string) => element("sort").listeners.get("change")!({ target: { value } });

  assert.deepEqual(ids(), [1, 5, 2]);
  input("ZERO cli");
  assert.deepEqual(ids(), [1], "search matches multiple case-insensitive terms across fields");
  input("missing");
  assert.deepEqual(ids(), []);
  assert.match(element("grid").innerHTML, /No matching items/);
  input("");
  sort("newest");
  assert.deepEqual(ids(), [5, 2, 1]);
  sort("stars");
  assert.deepEqual(ids(), [1, 5, 2]);
  element("folders").listeners.get("click")!({ target: { closest: () => ({ dataset: { folder: "agents" } }) } });
  assert.deepEqual(ids(), [2]);
  element("folders").listeners.get("click")!({ target: { closest: () => ({ dataset: { folder: "" } }) } });
  element("grid").listeners.get("click")!({
    target: { closest: (selector) => selector === "[data-tag]" ? { dataset: { tag: "agent" } } : null },
    stopPropagation: () => {},
  });
  assert.deepEqual(ids(), [2]);
});

test("CLI site export includes downvoted items like offline export while filtering unsafe items", async () => {
  const { home, dn } = seed();
  dn.store.vote(1, -1, "voter-a");
  dn.store.vote(1, -1, "voter-b");
  const outDir = join(mkdtempSync(join(tmpdir(), "driftnet-site-api-")), "docs");
  const requests: string[] = [];
  const ctx: Ctx = {
    env: { DRIFTNET_HOME: home },
    out: () => {},
    err: () => {},
    writeBytes: () => {},
    fetch: (async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname + url.search);
      if (url.pathname === "/api/items") {
        const items = dn.store.list({ clean: url.searchParams.get("all") !== "1", limit: 200 });
        return Response.json(items, { headers: { "x-total-count": String(items.length) } });
      }
      if (url.pathname === "/api/folders") return Response.json(dn.store.folders());
      if (url.pathname === "/api/ui") return Response.json({ locale: "zh-TW" });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch,
    isTTY: false,
    confirm: async () => false,
    open: () => {},
    sleep: async () => {},
  };
  assert.equal(await exportCmd(ctx, ["--format", "site", "-o", outDir]), 0);
  assert.ok(requests.some((url) => url.startsWith("/api/items?") && url.includes("all=1")));
  const apiData = JSON.parse(readFileSync(join(outDir, "data.json"), "utf8"));
  const localData = toShowcase(dn, { locale: "zh-TW", builtAt: apiData.builtAt }).data;
  assert.deepEqual(apiData, localData);
  assert.ok(apiData.items.some((i: { id: number }) => i.id === 1));
});

test("CLI `driftnet export --format site` writes index.html, data.json and .nojekyll offline", async () => {
  const { home } = seed();
  const outDir = join(mkdtempSync(join(tmpdir(), "driftnet-site-out-")), "docs");
  const out: string[] = [];
  const err: string[] = [];
  const ctx: Ctx = {
    env: { DRIFTNET_HOME: home },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    writeBytes: () => {},
    fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch,
    isTTY: false,
    confirm: async () => false,
    open: () => {},
    sleep: async () => {},
  };

  assert.equal(await exportCmd(ctx, ["--format", "site"]), 2, "-o is required for site");
  assert.equal(await exportCmd(ctx, ["--format", "site", "-o", outDir, "--folder", "nope"]), 2, "unknown folder returns 2");

  const code = await exportCmd(ctx, ["--format", "site", "-o", outDir, "--folder", "coding", "--title", "Coding Tools"]);
  assert.equal(code, 0);
  assert.ok(existsSync(join(outDir, "index.html")));
  assert.ok(existsSync(join(outDir, "data.json")));
  assert.ok(existsSync(join(outDir, ".nojekyll")));
  const parsed = JSON.parse(readFileSync(join(outDir, "data.json"), "utf8")) as { title: string; items: unknown[] };
  assert.equal(parsed.title, "Coding Tools");
  assert.equal(parsed.items.length, 2);
  assert.ok(out.some((l) => l.includes("built static showcase")));
});
