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
    queued: "⏳ Waiting for a summary (queued for your agent)",
    cached: (n: number) => `(already saved · shared ${n}×)`,
    footer: (id: number) => `#${id} · reply 👍${id} / 👎${id}`,
    noItem: (id: number) => `No item #${id}.`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — noted, similar items will cost less next time`,
    locale: "en",
  },
  "zh-TW": {
    injection: "⚠️ 內容含有針對 AI 的指令，不會提供給 agent",
    lowReputation: "⚠️ 此來源常被倒讚，未做摘要",
    mentions: "提到：",
    listSep: "、",
    queued: "⏳ 等待摘要（已排進 agent 的待整理佇列）",
    cached: (n: number) => `（已收錄過 · 分享 ${n} 次）`,
    footer: (id: number) => `#${id} · 回覆 👍${id} / 👎${id}`,
    noItem: (id: number) => `找不到 #${id}。`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — 收到，之後類似的內容會少花一點`,
    locale: "zh-TW",
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

/** Display names for the built-in shelves. Custom categories show their id. */
const CATEGORY_LABELS: Record<string, Record<Locale, string>> = {
  "coding-agent": { en: "Coding agents", "zh-TW": "AI 寫程式" },
  "agent-framework": { en: "Agent frameworks", "zh-TW": "Agent 框架" },
  "chat-assistant": { en: "Chat assistants", "zh-TW": "聊天助理" },
  "image-video": { en: "Image & video", "zh-TW": "圖片影片" },
  "design-frontend": { en: "Design & frontend", "zh-TW": "設計前端" },
  "audio-voice": { en: "Audio & voice", "zh-TW": "語音音訊" },
  automation: { en: "Automation", "zh-TW": "自動化" },
  "knowledge-rag": { en: "Knowledge & RAG", "zh-TW": "知識庫" },
  "model-infra": { en: "Models & infra", "zh-TW": "模型與基礎設施" },
  productivity: { en: "Productivity", "zh-TW": "生產力" },
  news: { en: "News", "zh-TW": "新聞動態" },
  learning: { en: "Learning", "zh-TW": "學習資源" },
  other: { en: "Other", "zh-TW": "其他" },
};

export const LOCALES = Object.keys(MESSAGES) as Locale[];

export function categoryLabel(id: string, locale: Locale = resolveLocale()): string {
  return CATEGORY_LABELS[id]?.[locale] ?? id;
}

/** Labels for every locale, for clients (the web page) that switch language themselves. */
export function categoryLabels(ids: string[]): Record<string, Record<Locale, string>> {
  return Object.fromEntries(
    ids.map((id) => [id, Object.fromEntries(LOCALES.map((l) => [l, categoryLabel(id, l)])) as Record<Locale, string>]),
  );
}
