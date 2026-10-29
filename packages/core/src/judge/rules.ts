import { readFileSync } from "node:fs";
import { WORTH, type Digest, type Kind } from "../types.ts";
import type { Judge, JudgeResult } from "./index.ts";

const KIND_NAMES = ["repo", "product", "video", "article", "post", "other"] as const;

export interface Rule {
  /** What the rule looks at. */
  test: (digest: Digest) => boolean;
  /** A folder id or name, resolved against the reader's folders when the judge runs. */
  folder: string;
  line: number;
}

/**
 * One rule per line, `pattern -> folder`; blank lines and `#` comments are skipped.
 *
 *   github.com/*          -> coding       host + path, `*` matches anything
 *   youtube.com           -> videos       a bare host also matches its subdomains
 *   kind:paper            -> reading      the kind the extractor found (repo, product, video, article, post, other)
 *   contains:recipe       -> cooking      a word or phrase in the title or text (case-insensitive)
 *
 * The first matching line wins. The folder is a folder id (`coding`) or a folder
 * name (`Coding`, `AI & Coding`). Lines that don't parse are returned in `errors`.
 */
export function parseRules(text: string): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const m = /^(.+?)\s*(?:->|→|=>)\s*(.+)$/.exec(line);
    if (!m) return void errors.push(`line ${i + 1}: expected "pattern -> folder"`);
    const pattern = m[1]!.trim();
    const folder = m[2]!.trim();
    let test: Rule["test"];
    if (/^kind:/i.test(pattern)) {
      const kind = pattern.slice(5).trim().toLowerCase();
      if (!(KIND_NAMES as readonly string[]).includes(kind)) return void errors.push(`line ${i + 1}: unknown kind "${kind}" (use ${KIND_NAMES.join(", ")})`);
      test = (d) => d.kind === (kind as Kind);
    } else if (/^contains:/i.test(pattern)) {
      const needle = pattern.slice(9).trim().toLowerCase();
      if (!needle) return void errors.push(`line ${i + 1}: contains: needs a word`);
      test = (d) => `${d.title}\n${d.text}`.toLowerCase().includes(needle);
    } else {
      const re = urlPattern(pattern);
      test = (d) => re.test(hostAndPath(d.url));
    }
    rules.push({ test, folder, line: i + 1 });
  });
  return { rules, errors };
}

/** host + path, lowercase host, no scheme, no leading www. */
function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname}`;
  } catch {
    return url.toLowerCase();
  }
}

function urlPattern(pattern: string): RegExp {
  const p = pattern.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const esc = p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  if (!p.includes("/")) {
    // A bare host: that host or any subdomain of it, any path.
    const host = esc.replace(/^\.\*\\\./, "(?:.*\\.)?");
    return new RegExp(`^(?:.*\\.)?${host}(?:/|$)`);
  }
  // Host and path: matched from the start (a prefix), with `*` for anything.
  return new RegExp(`^${esc}`);
}

/** The folder id a rule's target names: an id, or a folder name / the last segment of its path. */
function resolveFolder(target: string, categories: Record<string, string>): string | undefined {
  if (target in categories) return target;
  const want = target.trim().toLowerCase();
  for (const [id, text] of Object.entries(categories)) {
    // categories values read "Parent › Name — description"
    const path = text.split(" — ")[0]!;
    const name = path.split(" › ").pop()!.trim().toLowerCase();
    if (name === want || path.trim().toLowerCase() === want) return id;
  }
  return undefined;
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "your", "tools", "tool", "any", "anything", "into", "how", "are"]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9][a-z0-9+#.-]{2,}/g) ?? []) if (!STOP.has(w)) out.add(w);
  for (const run of lower.match(/[㐀-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}

export interface RulesJudgeOptions {
  /** The rules file text, if any. */
  rules?: string;
}

/**
 * A judge that costs nothing: no model, no network. It files a link by (1) the
 * rules file, then (2) how many words of the page's title and outline appear in
 * a folder's name and description. When neither says anything it answers null,
 * and the pipeline falls back to the model, or to "other".
 * It can't tell good from bad, so `worth` is always "normal" and the model
 * (when there is one) still writes the summary.
 */
export class RulesJudge implements Judge {
  readonly name = "rules";
  private readonly rules: Rule[];
  readonly errors: string[];

  constructor(opts: RulesJudgeOptions = {}) {
    const parsed = parseRules(opts.rules ?? "");
    this.rules = parsed.rules;
    this.errors = parsed.errors;
  }

  async judge(digest: Digest, _note: string | undefined, categories: Record<string, string>): Promise<JudgeResult | null> {
    const base = { isAiTool: 0.5, kind: digest.kind, worth: WORTH[2], engine: "rules" } as const;
    for (const rule of this.rules) {
      if (!rule.test(digest)) continue;
      const folder = resolveFolder(rule.folder, categories);
      // A rule that names a folder the reader no longer has doesn't match; later rules still can.
      if (folder) return { judgement: { ...base, category: folder, confidence: 1 } };
    }
    const mine = words(`${digest.title} ${digest.text.slice(0, 1500)}`);
    if (!mine.size) return null;
    let best: { id: string; hits: number } | undefined;
    for (const [id, text] of Object.entries(categories)) {
      if (id === "other") continue;
      const theirs = words(`${id.replace(/-/g, " ")} ${text}`);
      let hits = 0;
      for (const w of mine) if (theirs.has(w)) hits++;
      if (hits > (best?.hits ?? 0)) best = { id, hits };
    }
    if (!best || best.hits < 2) return null;
    return { judgement: { ...base, category: best.id, confidence: Math.min(0.75, 0.4 + best.hits * 0.1) } };
  }
}

/** DRIFTNET_JUDGE_RULES is a file path; an unreadable file means "no rules", with a warning. */
export function loadRulesFile(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    console.warn(`[driftnet] DRIFTNET_JUDGE_RULES ${path} can't be read; the rules judge uses folder descriptions only`);
    return "";
  }
}
