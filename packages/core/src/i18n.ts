/**
 * Strings the bot writes itself (summaries are written by the model in
 * DRIFTNET_LANGUAGE). Add a locale by adding an entry with the same keys.
 */
const MESSAGES = {
  en: {
    injection: "⚠️ Contains instructions aimed at AI — hidden from agent feeds",
    lowReputation: "⚠️ Source often voted down — not summarized",
    mentions: "Mentions: ",
    listSep: ", ",
    cached: (n: number) => `(already saved · shared ${n}×)`,
    footer: (id: number) => `#${id} · reply 👍${id} / 👎${id}`,
    noItem: (id: number) => `No item #${id}.`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — noted, similar items will cost less next time`,
  },
  "zh-TW": {
    injection: "⚠️ 內容含有針對 AI 的指令，不會提供給 agent",
    lowReputation: "⚠️ 此來源常被倒讚，未做摘要",
    mentions: "提到：",
    listSep: "、",
    cached: (n: number) => `（已收錄過 · 分享 ${n} 次）`,
    footer: (id: number) => `#${id} · 回覆 👍${id} / 👎${id}`,
    noItem: (id: number) => `找不到 #${id}。`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — 收到，之後類似的內容會少花一點`,
  },
} as const;

export type Locale = keyof typeof MESSAGES;
export type Messages = (typeof MESSAGES)[Locale];

/**
 * DRIFTNET_LOCALE wins; otherwise follow DRIFTNET_LANGUAGE so one setting
 * switches both the summaries and the bot's own words.
 */
export function resolveLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  const explicit = env.DRIFTNET_LOCALE;
  if (explicit && explicit in MESSAGES) return explicit as Locale;
  return /chinese|中文|zh/i.test(env.DRIFTNET_LANGUAGE ?? "") ? "zh-TW" : "en";
}

export function messages(locale: Locale = resolveLocale()): Messages {
  return MESSAGES[locale];
}
