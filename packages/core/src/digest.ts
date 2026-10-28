import { decodeEntities } from "./extractors/http.ts";

/**
 * Structure first, prose second (the idea behind agent browsers such as Moli):
 * a model judging a link needs the page's skeleton — title, section headings,
 * the opening of each section, key list items — not its full text. Outlines are
 * built without a model and capped in tokens, so a page costs the same whether
 * it is a 200-word post or a 20,000-word manual.
 */

/** Default token budget for the content part of a digest. */
export function digestBudget(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DRIFTNET_DIGEST_TOKENS);
  const base = Number.isFinite(n) && n >= 100 ? n : 350;
  // Detailed summaries get twice the page to read.
  return env.DRIFTNET_SUMMARY_DEPTH?.trim().toLowerCase() === "detailed" ? base * 2 : base;
}

const CJK = /[぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]/g;

/**
 * Rough token count without a tokenizer: CJK characters are about one token
 * each, other text about four characters per token. Character budgets cost
 * Chinese pages four times what they cost English ones; this does not.
 */
export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

/** Keep whole lines while they fit the budget; cut the first line that doesn't. */
export function clipTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  const out: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) {
      const room = budget - used;
      if (room > 20) out.push(cutToTokens(line, room) + "…");
      break;
    }
    out.push(line);
    used += cost;
  }
  return out.join("\n");
}

function cutToTokens(line: string, budget: number): string {
  let used = 0;
  let i = 0;
  for (; i < line.length && used < budget; i++) used += /[぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]/.test(line[i]!) ? 1 : 0.25;
  return line.slice(0, i);
}

interface Block {
  kind: "heading" | "text" | "item";
  text: string;
}

/** Cookie banners, newsletter boxes, sign-in prompts, footers. */
const BOILERPLATE =
  /cookie|subscribe|newsletter|sign (in|up)|log ?in|all rights reserved|©|copyright|privacy policy|terms of (use|service)|版權所有|訂閱|登入|註冊|隱私權|服務條款|廣告|分享到|上一篇|下一篇/i;

/**
 * Pick blocks within the budget: every heading with the block right after it
 * first (the skeleton), then the remaining blocks in page order. Output keeps
 * the page's order.
 */
function select(blocks: Block[], budget: number): string {
  const seen = new Set<string>();
  const unique = blocks.filter((b) => {
    const key = b.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const render = (b: Block) => b.text;
  const chosen = new Set<number>();
  let used = 0;
  const take = (i: number) => {
    const cost = estimateTokens(render(unique[i]!)) + 1;
    if (chosen.has(i) || used + cost > budget) return false;
    chosen.add(i);
    used += cost;
    return true;
  };

  // Pass 1: skeleton — headings and the first block under each.
  unique.forEach((b, i) => {
    if (b.kind !== "heading") return;
    take(i);
    const next = unique.findIndex((n, j) => j > i && n.kind !== "heading");
    if (next > i && !unique.slice(i + 1, next).some((n) => n.kind === "heading")) take(next);
  });
  // The very first text block is usually the summary; never drop it for a footer.
  const lead = unique.findIndex((b) => b.kind !== "heading");
  if (lead >= 0) take(lead);
  // Pass 2: fill with the rest, in order.
  unique.forEach((_, i) => take(i));

  const lines = unique.filter((_, i) => chosen.has(i)).map(render);
  // A block too big for the budget on its own still deserves a clipped mention.
  if (!lines.length && unique.length) return clipTokens(render(unique[0]!), budget);
  return lines.join("\n");
}

/** Boilerplate is short ("Sign in", "© 2026 Acme"); a long line that mentions login is content. */
const keepText = (text: string) =>
  text.length >= 2 &&
  !(text.length < 100 && BOILERPLATE.test(text)) &&
  (text.match(/ [>›»\/] /g)?.length ?? 0) < 2 && // breadcrumbs
  !(text.length < 100 && /^[^·|•]{1,25}([·|•][^·|•]{1,25})+$/.test(text)); // menus: "Docs · Blog · GitHub"

/** HTML page → outline within `budget` tokens. Falls back to plain text for div-soup pages. */
export function outlineHtml(html: string, budget: number): string {
  const body = (
    /<(article|main)[\s>][\s\S]*?<\/\1>/i.exec(html)?.[0] ??
    /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ??
    html
  )
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template|pre)[\s>][\s\S]*?<\/\1>/gi, " ");

  const blocks: Block[] = [];
  for (const m of body.matchAll(/<(h[1-4]|p|li|blockquote|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1]!.toLowerCase();
    const text = inlineText(m[2]!);
    if (!keepText(text)) continue;
    if (tag.startsWith("h")) blocks.push({ kind: "heading", text: `${"#".repeat(Number(tag[1]))} ${text}` });
    else if (tag === "li") {
      if (text.length <= 200) blocks.push({ kind: "item", text: `- ${text}` });
    } else if (estimateTokens(text) >= 8) blocks.push({ kind: "text", text });
  }
  if (blocks.some((b) => b.kind !== "heading")) return select(blocks, budget);

  // No semantic markup: visible text, minus boilerplate lines, clipped.
  const plain = inlineText(body.replace(/<br\s*\/?>|<\/(div|p|li|h\d|tr|section)>/gi, "\n"), true)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && keepText(l));
  return clipTokens([...new Set(plain)].join("\n"), budget);
}

/** README / Markdown → outline within `budget` tokens. Code blocks and tables are left out. */
export function outlineMarkdown(md: string, budget: number): string {
  const lines = md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    const text = decodeEntities(para.join(" ")).replace(/\s+/g, " ").trim();
    if (text && keepText(text) && estimateTokens(text) >= 6) blocks.push({ kind: "text", text });
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const text = decodeEntities(heading[2]!).replace(/[#*_`]/g, "").trim();
      if (keepText(text)) blocks.push({ kind: "heading", text: `${heading[1]} ${text}` });
    } else if (item) {
      flush();
      const text = decodeEntities(item[1]!).replace(/[*_`]/g, "").trim();
      if (text.length <= 200 && keepText(text)) blocks.push({ kind: "item", text: `- ${text}` });
    } else if (!line || line.startsWith("|") || /^[-=*_]{3,}$/.test(line)) {
      flush();
    } else {
      para.push(line.replace(/[*_`]/g, ""));
    }
  }
  flush();
  return select(blocks, budget);
}

function inlineText(html: string, keepNewlines = false): string {
  const text = decodeEntities(html.replace(/<[^>]+>/g, " "));
  return keepNewlines ? text.replace(/[ \t\f\v]+/g, " ") : text.replace(/\s+/g, " ").trim();
}
