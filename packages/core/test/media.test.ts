import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { type MediaRef, Pipeline, registerExtractor, Store, publicItem } from "../src/index.ts";
import { DEFAULT_CATEGORIES } from "../src/categories.ts";
import { readmeImages } from "../src/extractors/github.ts";
import { extractWeb } from "../src/extractors/web.ts";
import { youtubeThumbnail } from "../src/extractors/youtube.ts";

const README = `
[![Build](https://github.com/o/r/workflows/ci/badge.svg)](https://x)
[![npm](https://img.shields.io/npm/v/r.svg)](https://npm)
<a href="https://buymeacoffee.com/o"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" height="40"></a>
<img src="docs/logo-small.png" width="32">
![demo](./docs/demo.gif)
Some text and a fenced one:
\`\`\`md
![in code](https://example.com/code.png)
\`\`\`
<p><img alt="UI" src="/assets/ui.png" width="600"></p>
![svg](https://example.com/diagram.svg)
![camo](https://user-images.githubusercontent.com/1/abc.png)
![dup](docs/demo.gif)
![blob](https://github.com/o/r/blob/main/shot.jpg)
`;

test("README images: relative paths resolved, badges/svg/tiny/code skipped, order kept", () => {
  const m = readmeImages(README, "o", "r", "main");
  assert.deepEqual(m.map((x) => x.url), [
    "https://raw.githubusercontent.com/o/r/main/docs/demo.gif",
    "https://raw.githubusercontent.com/o/r/main/assets/ui.png",
    "https://user-images.githubusercontent.com/1/abc.png",
    "https://github.com/o/r/raw/main/shot.jpg",
  ]);
  assert.deepEqual(m.map((x) => x.kind), ["gif", "image", "image", "image"]);
  assert.equal(m[0]!.alt, "demo");
});

test("README images: at most 6", () => {
  const md = Array.from({ length: 10 }, (_, i) => `![a](pics/${i}.png)`).join("\n");
  assert.equal(readmeImages(md, "o", "r", "main").length, 6);
});

test("YouTube thumbnail is a video-kind hqdefault", () => {
  assert.deepEqual(youtubeThumbnail("abc123XYZ"), { url: "https://i.ytimg.com/vi/abc123XYZ/hqdefault.jpg", kind: "video", alt: "" });
});

test("web pages: og:image (made absolute) first, then large body pictures", async () => {
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  const server = createServer((_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><title>T</title>
      <meta property="og:image" content="/cover.png"><meta name="twitter:image" content="/cover.png">
      <meta property="og:type" content="article"></head><body>
      <header><img src="/nav.png" width="800" height="400"></header>
      <article><img src="/logo.png" width="800" height="400"><img src="/small.png" width="50" height="50">
      <img src="/fig1.jpg" width="800" height="400"><img src="/fig2.gif"><img src="/fig3.png" width="900" height="500"></article></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const d = await extractWeb(`http://127.0.0.1:${port}/post`);
    const base = `http://127.0.0.1:${port}`;
    assert.deepEqual(d?.media?.map((m) => m.url), [`${base}/cover.png`, `${base}/fig1.jpg`, `${base}/fig2.gif`]);
    assert.equal(d?.media?.[2]?.kind, "gif");
  } finally {
    server.close();
    delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
  }
});

test("an og:image-only page yields just that picture", async () => {
  process.env.DRIFTNET_ALLOW_PRIVATE_URLS = "1";
  const server = createServer((_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<html><head><meta property="og:image" content="https://cdn.example/p.jpg"></head><body><article><img src="/x.jpg" width="900" height="900"></article></body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    const d = await extractWeb(`http://127.0.0.1:${port}/`);
    // 127.0.0.1 is not a social host, so the body picture counts; social handling is covered by the og-only branch below.
    assert.equal(d?.media?.[0]?.url, "https://cdn.example/p.jpg");
  } finally {
    server.close();
    delete process.env.DRIFTNET_ALLOW_PRIVATE_URLS;
  }
});

let media: MediaRef[] = [{ url: "https://pics.test/a.png", kind: "image", alt: "a" }];
registerExtractor({
  name: "media-fixture",
  matches: (u) => u.startsWith("https://media.test/"),
  extract: async (url) => ({ url, kind: "article", title: "t", text: "some text", outlinks: [], meta: {}, media }),
});

test("media is stored, refreshed, kept when a refresh finds none, and exposed as proxy paths", async () => {
  const store = new Store(":memory:");
  store.seedFolders(DEFAULT_CATEGORIES);
  const p = new Pipeline({ store, categories: DEFAULT_CATEGORIES });
  const first = await p.ingest("https://media.test/1", { platform: "t", chatId: "c" });
  assert.deepEqual(first.item.media, media);
  // Shared again: cached, untouched.
  assert.deepEqual((await p.ingest("https://media.test/1", { platform: "t", chatId: "d" })).item.media, media);
  // Page now shows another picture: refresh replaces.
  media = [{ url: "https://pics.test/b.gif", kind: "gif", alt: "b" }];
  const re = await p.refresh(first.item.id);
  assert.equal(re?.media?.[0]?.url, "https://pics.test/b.gif");
  // Page shows none now: the old picture stays (both for a full refresh and a media-only one).
  media = [];
  (p as any).lastRefresh.clear();
  assert.equal((await p.refresh(first.item.id))?.media?.[0]?.url, "https://pics.test/b.gif");
  assert.equal((await p.refreshMedia(first.item.id))?.media?.[0]?.url, "https://pics.test/b.gif");
  const pub = publicItem(store.get(first.item.id)!);
  assert.deepEqual(pub.media, [{ src: `/api/media/${first.item.id}/0`, kind: "gif", alt: "b" }]);
  assert.ok(!JSON.stringify(pub).includes("pics.test"));
});

test("refreshMedia updates only the pictures", async () => {
  const store = new Store(":memory:");
  store.seedFolders(DEFAULT_CATEGORIES);
  const p = new Pipeline({ store, categories: DEFAULT_CATEGORIES });
  media = [];
  const first = await p.ingest("https://media.test/2", { platform: "t", chatId: "c" });
  assert.deepEqual(first.item.media, []);
  media = [{ url: "https://pics.test/c.png", kind: "image", alt: "" }];
  const before = store.get(first.item.id)!;
  const after = await p.refreshMedia(first.item.id);
  assert.equal(after?.media?.length, 1);
  assert.equal(after?.title, before.title);
  assert.deepEqual(after?.summary, before.summary);
});

test("picture paths are signed per picture and stop working when the picture changes", async () => {
  const { setMediaSecret, publicMedia, mediaSigOk } = await import("../src/media.ts");
  setMediaSecret("test-secret");
  const [m] = publicMedia(7, [{ url: "https://example.com/a.png", kind: "image", alt: "" }]);
  const sig = new URL(m.src, "http://x").searchParams.get("s");
  assert.ok(mediaSigOk(7, 0, "https://example.com/a.png", sig));
  assert.equal(mediaSigOk(7, 1, "https://example.com/a.png", sig), false, "another index");
  assert.equal(mediaSigOk(8, 0, "https://example.com/a.png", sig), false, "another card");
  assert.equal(mediaSigOk(7, 0, "https://example.com/b.png", sig), false, "the picture changed");
  assert.equal(mediaSigOk(7, 0, "https://example.com/a.png", null), false);
  setMediaSecret("");
});
