import assert from "node:assert/strict";
import { test } from "node:test";
import { clipTokens, estimateTokens, outlineHtml, outlineMarkdown } from "../src/digest.ts";

test("token estimate treats CJK as one token per character", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("中文字"), 3);
  assert.equal(estimateTokens("AI 工具"), 3);
});

test("clipTokens keeps whole lines within the budget", () => {
  const text = "line one is here\nline two is here\nline three is here";
  assert.equal(clipTokens(text, 10), "line one is here\nline two is here");
  assert.equal(clipTokens(text, 9), "line one is here");
  assert.ok(estimateTokens(clipTokens("中".repeat(500), 100)) <= 101);
});

test("outlineHtml keeps the skeleton and drops boilerplate", () => {
  const html = `<html><body>
    <nav><a href="/">Home</a> <a href="/blog">Blog</a></nav>
    <div class="cookie"><p>We use cookies to improve your experience.</p></div>
    <main>
      <p>Home &gt; Tools &gt; Inkwave</p>
      <h1>Inkwave</h1><p>A 4v4 turf-war ink shooter built on three.js with touch controls.</p>
      <h2>Install</h2><p>Run npm install and open the dev server in your browser to play.</p>
      ${"<p>Filler paragraph that goes on about nothing in particular for quite a while.</p>".repeat(40)}
      <h2>License</h2><p>MIT licensed, fork of an earlier community project.</p>
      <p>© 2026 Inkwave. All rights reserved.</p>
    </main><footer><p>Subscribe to our newsletter</p></footer></body></html>`;
  const out = outlineHtml(html, 120);
  assert.match(out, /^# Inkwave\nA 4v4 turf-war/);
  assert.match(out, /## Install\nRun npm install/);
  assert.match(out, /## License\nMIT licensed/); // skeleton survives even though filler comes first
  assert.doesNotMatch(out, /cookies|Subscribe|All rights reserved|Home > Tools/);
  assert.ok(estimateTokens(out) <= 120);
});

test("outlineMarkdown drops badges, HTML, code and tables", () => {
  const md = `<p align="center"><strong>Quickstart</strong> &middot; <strong>Docs</strong></p>
# Paperclip
The open-source app everyone uses to manage agents at work.

\`\`\`bash
npx paperclip init
\`\`\`

| a | b |
|---|---|
| 1 | 2 |

## Features
- Org charts and budgets for agents
- Bring your own agent`;
  const out = outlineMarkdown(md, 200);
  assert.equal(out, "# Paperclip\nThe open-source app everyone uses to manage agents at work.\n## Features\n- Org charts and budgets for agents\n- Bring your own agent");
});
