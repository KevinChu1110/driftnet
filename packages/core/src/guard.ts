/**
 * Pollution guard. Everything driftnet stores is later read by people *and* by
 * agents (via MCP / the skill), so shared content is untrusted input: a post can
 * carry instructions aimed at whichever AI reads it next.
 *
 * This runs before any model sees the digest. It is deliberately cheap (regex,
 * no model); Jev adds a second, semantic check when it is enabled.
 */

/**
 * Invisible formatting: zero-width spaces, word joiners, BOM. Facebook and
 * Threads posts use U+200B to keep blank lines, so these are stripped silently.
 * U+200D (zero-width joiner) is kept: emoji such as 🙅🏻‍♀️ are built with it.
 */
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u2060-\u2064\uFEFF]/gu;

/**
 * Characters that can smuggle text past a human reader: bidi overrides, and
 * Unicode tag characters outside emoji flag sequences (which start with 🏴).
 * These are stripped and flagged.
 */
const SMUGGLING = /[\u202A-\u202E\u2066-\u2069]|(?<!\u{1F3F4}[\u{E0020}-\u{E007E}]*)[\u{E0000}-\u{E007F}]/gu;

const INJECTION_PATTERNS = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (your|the|all) (instructions|rules|system prompt)/i,
  /\byou are now\b.{0,40}\b(assistant|ai|model|gpt|claude)/i,
  /\b(system|developer) prompt\b.{0,40}\b(reveal|print|show|override)/i,
  /<\/?(system|instructions?|assistant)>/i,
  /\bnew instructions?:/i,
  /(忽略|無視|忽視).{0,10}(之前|先前|以上|上面).{0,6}(指令|指示|提示)/,
  /你(現在|从现在|從現在)(是|扮演).{0,20}(助理|AI|模型)/,
];

export interface GuardResult {
  text: string;
  flags: string[];
}

export function guard(text: string): GuardResult {
  const flags: string[] = [];
  const visible = text.replace(INVISIBLE, "");
  const cleaned = visible.replace(SMUGGLING, "");
  if (cleaned.length !== visible.length) flags.push("hidden-chars");
  if (INJECTION_PATTERNS.some((re) => re.test(cleaned))) flags.push("injection");
  return { text: cleaned, flags };
}
