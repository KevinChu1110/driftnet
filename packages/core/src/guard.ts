/**
 * Pollution guard. Everything driftnet stores is later read by people *and* by
 * agents (via MCP / the skill), so shared content is untrusted input: a post can
 * carry instructions aimed at whichever AI reads it next.
 *
 * This runs before any model sees the digest. It is deliberately cheap (regex,
 * no model), so it catches the common phrasings and nothing cleverer; Jev adds a
 * second, semantic check when it is enabled. A flag keeps the card out of what
 * agents are handed: a false alarm costs one card, a miss costs more.
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
  /(忽略|無視|忽視|无视|忽略).{0,10}(之前|先前|以上|上面|所有|你的).{0,6}(指令|指示|提示|规则|規則|设定|設定)/,
  /你(現在|从现在|從現在)(是|扮演|要扮演|必須).{0,20}(助理|AI|模型|助手)/,
  // Broader phrasings of the same attack: override / forget, "if you are an AI", addressed straight at the reader.
  /\b(forget|override|bypass|drop)\b.{0,30}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|rules|prompts?|guidelines|constraints)\b/i,
  /\b(if you are|attention|note to|message (?:for|to)|dear|hey)\b.{0,12}\b(an? )?(ai|llm|assistant|agent|chatbot|language model|crawler|summari[sz]er)\b/i,
  /\b(ai|llm|assistant|agent|chatbot|language model)\b.{0,25}\b(reading|processing|summari[sz]ing|crawling|parsing) (this|the following|the page)\b/i,
  // Asking the reader to leak what it holds, or to hide what it does.
  /\b(send|post|forward|upload|leak|reveal|print|output|repeat|exfiltrate)\b.{0,40}\b(your|the user'?s?|all) (system prompt|instructions|api[ _-]?keys?|secrets?|credentials|conversation|chat history|memory|environment variables?|\.env)\b/i,
  /\b(do not|don'?t|never) (tell|inform|mention|reveal|show|let)\b.{0,30}\b(the )?(user|human|owner|operator)\b/i,
  /\bwithout (asking|telling|informing|notifying|confirming with) (the )?(user|human|owner)\b/i,
  // Chat-template control tokens have no business in a web page.
  /<\|(im_start|im_end|system|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/i,
  /(不要|別|勿|不得)(告訴|讓|通知).{0,6}(使用者|用戶|用户|人類|主人)/,
  /(把|將|将).{0,12}(系統提示|系统提示|system prompt|api ?key|金鑰|密鑰|密钥|密碼|密码|token).{0,12}(發送|傳送|发送|传送|貼出|輸出|输出|洩漏|泄露|告訴|告诉)/i,
  /(如果你是|致|給|给)\s?(AI|人工智慧|人工智能|助理|助手|模型|agent)/i,
];

/** What the patterns see: compatibility forms folded (fullwidth letters, ligatures), runs of whitespace collapsed. The stored text is untouched. */
const forMatching = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ");

export interface GuardResult {
  text: string;
  flags: string[];
}

export function guard(text: string): GuardResult {
  const flags: string[] = [];
  const visible = text.replace(INVISIBLE, "");
  const cleaned = visible.replace(SMUGGLING, "");
  if (cleaned.length !== visible.length) flags.push("hidden-chars");
  const seen = forMatching(cleaned);
  if (INJECTION_PATTERNS.some((re) => re.test(seen))) flags.push("injection");
  return { text: cleaned, flags };
}
