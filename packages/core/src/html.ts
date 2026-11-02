/**
 * Linear-time scanners for untrusted HTML and Markdown.
 *
 * driftnet reads whatever strangers paste into a chat, up to 1.5 MB a page. The
 * regexes these replace (`<meta\s[^>]*>`, `<p[^>]*>([\s\S]*?)<\/p>`, `\[[^\]]+\]\([^)]*\)`…)
 * are quadratic on input whose tags, blocks or brackets never close: a 1.5 MB
 * page of `<meta ` froze the whole process (HTTP, MCP and every chat bot with it)
 * for two minutes, and a README of blank lines for one. Everything here walks
 * forward with indexOf and remembers where it looked, so a tag that never closes
 * costs one scan of the text, not one scan per opener.
 *
 * Semantics follow the regexes they replace: a tag ends at the first `>`, a block
 * at the first `</name>` after its opener, a comment at the first `-->`; whatever
 * never closes is left as it was.
 */

/** ASCII-only lower case. Same length as the input, so indexes line up with the original. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * indexOf that remembers its last answer. A scanner asks "where is the next `>`"
 * at every tag; as long as it asks from positions that move forward (or back by a
 * few characters), the answers come from the cache and the whole walk is one
 * pass over the text, however many tags there are.
 */
export class Needle {
  private from = -1;
  private at = -1;

  constructor(private readonly hay: string, private readonly needle: string) {}

  /** Index of the first occurrence at or after `from`, or -1. */
  find(from: number): number {
    if (from < 0) from = 0;
    if (this.from >= 0 && from < this.from) {
      // A step back: only the gap can hold an occurrence the cache doesn't know.
      const stop = Math.min(this.hay.length, this.from + this.needle.length - 1);
      const i = this.hay.slice(from, stop).indexOf(this.needle);
      return i >= 0 ? from + i : this.at;
    }
    if (this.from >= 0 && (this.at < 0 || from <= this.at)) return this.at;
    this.from = from;
    this.at = this.hay.indexOf(this.needle, from);
    return this.at;
  }
}

export interface Tag {
  /** Lower-cased, without `<`, `/` or attributes: "meta", "img". */
  name: string;
  /** `</name …>` */
  closing: boolean;
  start: number;
  /** Just past the `>`. */
  end: number;
  /** The tag as written, `<` to `>` inclusive. */
  raw: string;
}

const isSpace = (c: string | undefined) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f" || c === "\v";
const isNameChar = (c: string | undefined) => c !== undefined && /[a-z0-9:-]/.test(c);

/** Walks `<name …>` and `</name>` tags in order. `lower` is the ASCII-lower-cased text, shared so callers can search it too. */
export class Tags {
  readonly lower: string;
  private readonly lt: Needle;
  private readonly gt: Needle;

  constructor(readonly html: string, lower?: string) {
    this.lower = lower ?? asciiLower(html);
    this.lt = new Needle(this.lower, "<");
    this.gt = new Needle(this.lower, ">");
  }

  /** The first tag starting at or after `from`, or null when no `>` is left to end one. */
  next(from: number): Tag | null {
    const { lower } = this;
    for (let i = this.lt.find(from); i >= 0; i = this.lt.find(i + 1)) {
      let p = i + 1;
      const closing = lower[p] === "/";
      if (closing) p++;
      if (!/[a-z]/.test(lower[p] ?? "")) continue;
      let q = p + 1;
      while (q - p < 64 && isNameChar(lower[q])) q++;
      const end = this.gt.find(q);
      if (end < 0) return null;
      return { name: lower.slice(p, q), closing, start: i, end: end + 1, raw: this.html.slice(i, end + 1) };
    }
    return null;
  }
}

/** A tag's attributes, lower-cased names, first one wins, entities not decoded. Quoted values end at their quote, unquoted ones at whitespace. */
export function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = raw.length - (raw.endsWith(">") ? 1 : 0);
  let i = 1;
  if (raw[i] === "/") i++;
  while (i < n && isNameChar(raw[i]!.toLowerCase())) i++;
  while (i < n) {
    while (i < n && (isSpace(raw[i]) || raw[i] === "/")) i++;
    if (i >= n) break;
    const s = i;
    while (i < n && !isSpace(raw[i]) && raw[i] !== "=" && raw[i] !== "/") i++;
    const name = raw.slice(s, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < n && isSpace(raw[i])) i++;
    let value = "";
    if (raw[i] === "=") {
      i++;
      while (i < n && isSpace(raw[i])) i++;
      const q = raw[i];
      if (q === '"' || q === "'") {
        const j = raw.indexOf(q, i + 1);
        if (j < 0 || j >= n) { value = raw.slice(i + 1, n); i = n; } else { value = raw.slice(i + 1, j); i = j + 1; }
      } else {
        const s2 = i;
        while (i < n && !isSpace(raw[i])) i++;
        value = raw.slice(s2, i);
      }
    }
    if (!(name in out)) out[name] = value;
  }
  return out;
}

/** `<name` at `i` that a regex `<name[\s>]` would accept. */
function openerAt(lower: string, name: string, from: number, open: Needle): number {
  for (let i = open.find(from); i >= 0; i = open.find(i + 1)) {
    const c = lower[i + 1 + name.length];
    if (c === ">" || isSpace(c)) return i;
  }
  return -1;
}

/**
 * `<name …>…</name>` blocks of the given names, in order and without overlap, as
 * `/<(a|b)[\s>][\s\S]*?<\/\1>/gi` finds them: the first closer after an opener ends
 * it, an opener with no closer anywhere after it is skipped. [start, end).
 */
export function* blocks(lower: string, names: readonly string[], from = 0): Generator<[number, number]> {
  // `next`: the first opener at or after the last query, so each name's search only ever moves forward.
  const items = names.map((name) => ({ name, open: new Needle(lower, `<${name}`), close: new Needle(lower, `</${name}>`), dead: false, next: -1 }));
  let pos = from;
  for (;;) {
    let best: (typeof items)[number] | undefined;
    let at = -1;
    for (const it of items) {
      if (it.dead) continue;
      if (it.next < pos) {
        it.next = openerAt(lower, it.name, pos, it.open);
        if (it.next < 0) { it.dead = true; continue; }
      }
      if (at < 0 || it.next < at) { at = it.next; best = it; }
    }
    if (!best) return;
    const j = best.close.find(at + 1 + best.name.length);
    if (j < 0) { best.dead = true; continue; }
    const end = j + best.name.length + 3;
    yield [at, end];
    pos = end;
  }
}

/** Removes every `<name …>…</name>` block of the given names. */
export function stripBlocks(html: string, names: readonly string[], replacement = " "): string {
  const parts: string[] = [];
  let pos = 0;
  for (const [s, e] of blocks(asciiLower(html), names)) {
    parts.push(html.slice(pos, s), replacement);
    pos = e;
  }
  if (!parts.length) return html;
  parts.push(html.slice(pos));
  return parts.join("");
}

/** The first `<name …>…</name>` block of any of the names, or null. */
export function firstBlock(html: string, names: readonly string[]): string | null {
  for (const [s, e] of blocks(asciiLower(html), names)) return html.slice(s, e);
  return null;
}

/** `<body …>` to the last `</body>` (as the greedy `/<body[\s>][\s\S]*<\/body>/i`), or null. */
export function bodyBlock(html: string): string | null {
  const lower = asciiLower(html);
  const i = openerAt(lower, "body", 0, new Needle(lower, "<body"));
  const j = lower.lastIndexOf("</body>");
  return i >= 0 && j > i ? html.slice(i, j + 7) : null;
}

/** Removes `<!-- … -->`; a comment that never closes stays. */
export function stripComments(s: string, replacement = " "): string {
  return stripBetween(s, "<!--", "-->", () => replacement);
}

/** Removes ``` fenced blocks (or replaces each through `replace`); an odd last fence stays. */
export function stripFences(md: string, replace: (block: string) => string = () => ""): string {
  return stripBetween(md, "```", "```", replace);
}

function stripBetween(s: string, open: string, close: string, replace: (block: string) => string): string {
  const o = new Needle(s, open);
  const c = new Needle(s, close);
  const parts: string[] = [];
  let pos = 0;
  for (let i = o.find(0); i >= 0; i = o.find(pos)) {
    const j = c.find(i + open.length);
    if (j < 0) break;
    parts.push(s.slice(pos, i), replace(s.slice(i, j + close.length)));
    pos = j + close.length;
  }
  if (!parts.length) return s;
  parts.push(s.slice(pos));
  return parts.join("");
}

/** Removes every `<…>` (as `/<[^>]+>/g`): from a `<` to the next `>`; `<>` and a `<` with no `>` after it stay. */
export function stripTags(s: string, replacement = " "): string {
  const lt = new Needle(s, "<");
  const gt = new Needle(s, ">");
  const parts: string[] = [];
  let pos = 0;
  for (let i = lt.find(0); i >= 0; ) {
    const j = gt.find(i + 1);
    if (j < 0) break;
    if (j === i + 1) { i = lt.find(i + 1); continue; }
    parts.push(s.slice(pos, i), replacement);
    pos = j + 1;
    i = lt.find(pos);
  }
  if (!parts.length) return s;
  parts.push(s.slice(pos));
  return parts.join("");
}

// --- Markdown links ----------------------------------------------------------------------------

/** `[![alt](img)](link)` removed (as `/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g`). */
export function stripLinkedBadges(md: string): string {
  const lb = new Needle(md, "[![");
  const rb = new Needle(md, "]");
  const rp = new Needle(md, ")");
  const parts: string[] = [];
  let pos = 0;
  for (let i = lb.find(0); i >= 0; i = lb.find(pos > i ? pos : i + 1)) {
    const j1 = rb.find(i + 3);
    if (j1 < 0) break;
    if (md[j1 + 1] !== "(") continue;
    const k1 = rp.find(j1 + 2);
    if (k1 < 0) break;
    if (md[k1 + 1] !== "]" || md[k1 + 2] !== "(") continue;
    const k2 = rp.find(k1 + 3);
    if (k2 < 0) break;
    parts.push(md.slice(pos, i));
    pos = k2 + 1;
  }
  if (!parts.length) return md;
  parts.push(md.slice(pos));
  return parts.join("");
}

/** Every `![alt](src)` image, in order (as `/!\[([^\]]*)\]\(([^)]*)\)/g`): [start, end) and the raw parts. */
export function* markdownImages(md: string): Generator<{ start: number; end: number; alt: string; inner: string }> {
  const lb = new Needle(md, "![");
  const rb = new Needle(md, "]");
  const rp = new Needle(md, ")");
  let pos = 0;
  for (let i = lb.find(0); i >= 0; i = lb.find(pos > i ? pos : i + 1)) {
    const j = rb.find(i + 2);
    if (j < 0) break;
    if (md[j + 1] !== "(") continue;
    const k = rp.find(j + 2);
    if (k < 0) break;
    yield { start: i, end: k + 1, alt: md.slice(i + 2, j), inner: md.slice(j + 2, k) };
    pos = k + 1;
  }
}

/** `![alt](src)` removed. */
export function stripImages(md: string): string {
  const parts: string[] = [];
  let pos = 0;
  for (const { start, end } of markdownImages(md)) {
    parts.push(md.slice(pos, start));
    pos = end;
  }
  if (!parts.length) return md;
  parts.push(md.slice(pos));
  return parts.join("");
}

/** `[text](href)` → `text` (as `/\[([^\]]+)\]\([^)]*\)/g`; an empty `[]` stays). */
export function unlinkLinks(md: string): string {
  const lb = new Needle(md, "[");
  const rb = new Needle(md, "]");
  const rp = new Needle(md, ")");
  const parts: string[] = [];
  let pos = 0;
  for (let i = lb.find(0); i >= 0; i = lb.find(pos > i ? pos : i + 1)) {
    const j = rb.find(i + 1);
    if (j < 0) break;
    if (j === i + 1 || md[j + 1] !== "(") continue;
    const k = rp.find(j + 2);
    if (k < 0) break;
    parts.push(md.slice(pos, i), md.slice(i + 1, j));
    pos = k + 1;
  }
  if (!parts.length) return md;
  parts.push(md.slice(pos));
  return parts.join("");
}
