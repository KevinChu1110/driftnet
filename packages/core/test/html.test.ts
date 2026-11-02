import assert from "node:assert/strict";
import { test } from "node:test";
import { attrs, bodyBlock, firstBlock, Needle, stripBlocks, stripComments, stripFences, stripImages, stripLinkedBadges, stripTags, Tags, unlinkLinks } from "../src/html.ts";
import { metaTags } from "../src/extractors/http.ts";
import { outlineHtml, outlineMarkdown } from "../src/digest.ts";
import { cleanReadme, readmeImages } from "../src/extractors/github.ts";
import { pageImages } from "../src/extractors/web.ts";

// The regexes the scanners replace, kept here as the reference for what they must still do on ordinary input.
const legacy = {
  stripTags: (s: string) => s.replace(/<[^>]+>/g, " "),
  stripComments: (s: string) => s.replace(/<!--[\s\S]*?-->/g, " "),
  stripBlocks: (s: string) => s.replace(/<(script|style|nav|pre)[\s>][\s\S]*?<\/\1>/gi, " "),
  firstBlock: (s: string) => /<(article|main)[\s>][\s\S]*?<\/\1>/i.exec(s)?.[0] ?? null,
  bodyBlock: (s: string) => /<body[\s>][\s\S]*<\/body>/i.exec(s)?.[0] ?? null,
  metaTags(html: string) {
    const out: Record<string, string> = {};
    for (const m of html.matchAll(/<meta\s[^>]*>/gi)) {
      const key = /(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1]?.toLowerCase();
      const value = /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1];
      if (key && value && !(key in out)) out[key] = value;
    }
    const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
    if (title && !out["title"]) out["title"] = title.trim();
    return out;
  },
  links: (md: string) => md
    .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"),
  fences: (md: string) => md.replace(/```[\s\S]*?```/g, (b) => (b.length > 10 ? "…" : b)),
};

const HTML_CASES = [
  "<p>plain</p>",
  "a <b>bold</b> and <i>it</i> <> <<x>> <a<b> end",
  "no tags at all",
  "<unclosed tag here",
  "text <!-- a --> more <!-- unclosed",
  "<!---->x<!-- -- -->y<!-->z",
  "<script>x</script> keep <SCRIPT type=a>y</SCRIPT> <scripts>not</scripts> <style\n>z</style>",
  "<script>outer <script>inner</script> tail</script>",
  "<script>never closes <style>s</style>",
  "<pre>a</pre><nav>b</nav><pre>c",
  "<article>first</article><main>m</main>",
  "<main>m</main><article>a</article>",
  "<article>open <main>in</main> no close",
  "<articles>x</articles><main>y</main>",
  "<body>one</body> two </body>",
  "<BODY class=x>b</BODY>",
  "</body><body>late</body>",
  "no body here",
];

test("scanners match the regexes they replace on ordinary input", () => {
  for (const s of HTML_CASES) {
    assert.equal(stripTags(s), legacy.stripTags(s), `stripTags: ${s}`);
    assert.equal(stripComments(s), legacy.stripComments(s), `stripComments: ${s}`);
    assert.equal(stripBlocks(s, ["script", "style", "nav", "pre"]), legacy.stripBlocks(s), `stripBlocks: ${s}`);
    assert.equal(firstBlock(s, ["article", "main"]), legacy.firstBlock(s), `firstBlock: ${s}`);
    assert.equal(bodyBlock(s), legacy.bodyBlock(s), `bodyBlock: ${s}`);
  }
});

test("metaTags: property/name/itemprop, first wins, title, entities, odd spacing", () => {
  const html = `<html><head><TITLE> A &amp; B </TITLE>
    <meta property="og:title" content="First">
    <meta property="og:title" content="Second">
    <meta name='description' content='desc &#39;q&#39;'/>
    <meta itemprop = "x" content = "y" >
    <meta content="before" name="order">
    <meta name="empty" content="">
    <meta charset="utf-8">
    <meta name="noval">
    <title>second title</title></head></html>`;
  assert.deepEqual(metaTags(html), { "og:title": "First", description: "desc 'q'", x: "y", order: "before", title: "A & B" });
  for (const s of ["<title>t</title>", "<title>t<b>x</b></title>", "<title>only", "<title id=1>x</title><meta name=\"title\" content=\"m\">"]) {
    const want = legacy.metaTags(s);
    assert.deepEqual(metaTags(s), want, s);
  }
  // Unquoted values are valid HTML; the regex needed quotes.
  assert.deepEqual(metaTags("<meta name=a content=b>"), { a: "b" });
});

test("attrs: quotes, no quotes, duplicates, self-closing, a tag cut off without its >", () => {
  assert.deepEqual(attrs(`<img SRC="a.png" width=640 alt='it"s' data-x hidden/>`), { src: "a.png", width: "640", alt: 'it"s', "data-x": "", hidden: "" });
  assert.deepEqual(attrs(`<a href="x" href="y">`), { href: "x" });
  assert.deepEqual(attrs(`<meta content="unterminated`), { content: "unterminated" });
  assert.deepEqual(attrs(`<br>`), {});
});

test("Tags walks open and close tags and stops when no > is left", () => {
  const t = new Tags(`x<P id=1>a</p><img src=a><!doctype><1bad><br/>tail<open`);
  const seen: string[] = [];
  for (let tag = t.next(0); tag; tag = t.next(tag.end)) seen.push(`${tag.closing ? "/" : ""}${tag.name}`);
  assert.deepEqual(seen, ["p", "/p", "img", "br"]);
});

test("Needle: forward queries are cached, a step back still answers right", () => {
  const n = new Needle("a>b>>c", ">");
  assert.equal(n.find(0), 1);
  assert.equal(n.find(1), 1);
  assert.equal(n.find(2), 3);
  assert.equal(n.find(4), 4);
  assert.equal(n.find(1), 1);
  assert.equal(n.find(5), -1);
  assert.equal(n.find(0), 1);
});

test("markdown links: linked badges and images go, links keep their text, as before", () => {
  const cases = [
    "[![b](i)](l) [t](u) ![i](s) [](e) [x] (y) [n](o",
    "[![a](x more](link) tail",
    "![](empty) [[nested]](z) [a [b](c)",
    "no brackets",
    "[unclosed ![img](s) and (parens) ]",
    "text ) [a](b) ) ![c](d)",
  ];
  for (const md of cases) assert.equal(unlinkLinks(stripImages(stripLinkedBadges(md))), legacy.links(md), md);
  for (const md of ["```a``` b ```c", "x```y```z```w```", "no fence", "``` only"]) {
    assert.equal(stripFences(md, (b) => (b.length > 10 ? "…" : b)), legacy.fences(md), md);
  }
});

test("cleanReadme and outlineMarkdown on a README with the usual noise", () => {
  const md = `<p align="center"><a href="x"><img src="logo.png" width="100"></a></p>
<!-- hidden -->
[![Build](https://ci/badge.svg)](https://ci) [![npm](https://img.shields.io/x.svg)](https://npm)
# Tool
See the [docs](https://docs) for everything about it and ![shot](shot.png).
-
\`\`\`sh
npm i tool
\`\`\`
<pre>kept</pre>`;
  const clean = cleanReadme(md);
  // <pre> goes with <p…> as it always did (the tag prefix is what counts); its text stays.
  assert.equal(clean, "# Tool\nSee the docs for everything about it and .\n\n```sh\nnpm i tool\n```\nkept");
  // The outline keeps paragraphs of 6+ tokens; "kept" alone is too short, as it always was.
  assert.equal(outlineMarkdown(clean, 100), "# Tool\nSee the docs for everything about it and .");
});

test("outlineHtml: the block right after a heading, unclosed tags skipped, nested blocks as before", () => {
  const html = `<body><p>Lead paragraph that is long enough to count as a block of text.</p>
    <h2>Title</h2><p>Para one is also long enough to be counted here.<p>Para two, which the regex swallowed too.</p>
    <li>item</li><h3>Never closes<p>after unclosed heading, long enough to count as text again.</p></body>`;
  assert.equal(
    outlineHtml(html, 200),
    "Lead paragraph that is long enough to count as a block of text.\n## Title\nPara one is also long enough to be counted here. Para two, which the regex swallowed too.\n- item\nafter unclosed heading, long enough to count as text again.",
  );
});

test("pageImages and readmeImages read attributes the same way", () => {
  const html = `<html><head><meta property="og:image" content="/og.png"></head><body><main>
    <img src="/small.png" width=100 height=100><img src="/big.jpg" width="800px" height="400" alt="A &amp; B">
    <IMG SRC='/second.webp'><img src="/third.png"></main></body></html>`;
  const meta = metaTags(html);
  assert.deepEqual(pageImages(html, "https://x.test/p", meta, false, false).map((m) => [m.url, m.alt]), [
    ["https://x.test/og.png", ""], ["https://x.test/big.jpg", "A & B"], ["https://x.test/second.webp", ""],
  ]);
  // width="100%" is not a pixel size (the regex read it as 10 and dropped the picture as tiny); 5 KB of "source" is not a picture.
  const md = `<img src="a.png" width="100%"> <img src="b.png" width="32"> ![c](c.png "title") ![d](<d.png>) ![e](${"x".repeat(5000)})`;
  assert.deepEqual(readmeImages(md, "o", "r", "main").map((m) => m.url), [
    "https://raw.githubusercontent.com/o/r/main/a.png",
    "https://raw.githubusercontent.com/o/r/main/c.png",
    "https://raw.githubusercontent.com/o/r/main/d.png",
  ]);
});

const MB = 1_500_000;
const timed = (label: string, fn: () => unknown, limitMs = 1500) => {
  const t = performance.now();
  fn();
  const ms = performance.now() - t;
  assert.ok(ms < limitMs, `${label} took ${ms.toFixed(0)} ms`);
};

test("1.5 MB of tags, blocks, comments or brackets that never close is handled in linear time", () => {
  const fill = (unit: string) => unit.repeat(Math.ceil(MB / unit.length));
  timed("metaTags <meta ", () => metaTags(fill("<meta ")));
  timed("metaTags <title", () => metaTags(fill("<title>")));
  timed("outlineHtml <div><p>", () => outlineHtml(fill("<div><p>"), 350));
  timed("outlineHtml <article>", () => outlineHtml(fill("<article>"), 350));
  timed("outlineHtml <script>", () => outlineHtml(fill("<script>"), 350));
  timed("outlineHtml <!--", () => outlineHtml(fill("<!-- "), 350));
  timed("outlineHtml <<<<", () => outlineHtml(fill("<"), 350));
  timed("outlineHtml <br ", () => outlineHtml(fill("<br \n"), 350));
  timed("pageImages <img ", () => pageImages(`<main>${fill("<img ")}`, "https://x.test/", {}, false, false));
  timed("pageImages <a href", () => pageImages(`<main>${fill("<a href='#")}`, "https://x.test/", {}, false, false));
  timed("cleanReadme [![", () => cleanReadme(fill("[![")));
  timed("cleanReadme ![a](", () => cleanReadme(fill("![a](")));
  timed("cleanReadme [a](", () => cleanReadme(fill("[a](")));
  timed("cleanReadme blank lines", () => cleanReadme(fill("\n")));
  timed("cleanReadme <p", () => cleanReadme(fill("<p ")));
  timed("cleanReadme ```", () => cleanReadme(fill("``` ")));
  timed("readmeImages ![a](x y", () => readmeImages(fill("![a](x y"), "o", "r", "main"));
  timed("readmeImages <img ", () => readmeImages(fill("<img "), "o", "r", "main"));
  timed("outlineMarkdown <<<<", () => outlineMarkdown(fill("<"), 350));
});

test("a bookmark file whose tags never close is parsed in linear time", async () => {
  const { parseHtml } = await import("../src/import.ts");
  timed("parseHtml <a ", () => parseHtml("<a ".repeat(Math.ceil(MB / 3))));
  timed("parseHtml <dd>", () => parseHtml(`<a href="https://x.test/">x</a>${"<dd>".repeat(Math.ceil(MB / 4))}`));
  timed("parseHtml <h3>", () => parseHtml("<h3>".repeat(Math.ceil(MB / 4))));
});
