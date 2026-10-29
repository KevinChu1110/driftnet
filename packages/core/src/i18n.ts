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
    alsoFound: "+ ",
    seenBefore: "(already saved)",
    cached: (n: number) => `(already saved · shared ${n}×)`,
    footer: (id: number) => `#${id} · reply 👍${id} / 👎${id}`,
    noItem: (id: number) => `No item #${id}.`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — noted, similar items will be skipped sooner`,
    digest: {
      title: (period: "daily" | "weekly") => (period === "daily" ? "Today in driftnet" : "This week in driftnet"),
      counts: (fresh: number, inbox: number) => `${fresh} new ${fresh === 1 ? "card" : "cards"} · ${inbox} waiting in the Inbox`,
      top: "Top picks",
      shared: "Most shared",
      sharedTimes: (n: number) => `shared ${n}×`,
      more: (n: number) => `+ ${n} more on the page`,
    },
    locale: "en",
  },
  "zh-TW": {
    injection: "⚠️ 內容含有針對 AI 的指令，不會提供給 agent",
    lowReputation: "⚠️ 此來源常被倒讚，未做摘要",
    mentions: "提到：",
    listSep: "、",
    queued: "⏳ 等待摘要（已排進 agent 的待整理佇列）",
    alsoFound: "＋ ",
    seenBefore: "（已收錄過）",
    cached: (n: number) => `（已收錄過 · 分享 ${n} 次）`,
    footer: (id: number) => `#${id} · 回覆 👍${id} / 👎${id}`,
    noItem: (id: number) => `找不到 #${id}。`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — 收到，之後類似的內容會更早被略過`,
    digest: {
      title: (period: "daily" | "weekly") => (period === "daily" ? "driftnet 今日" : "driftnet 本週"),
      counts: (fresh: number, inbox: number) => `新增 ${fresh} 張卡片 · 收件匣還有 ${inbox} 張待整理`,
      top: "精選",
      shared: "最多人分享",
      sharedTimes: (n: number) => `分享 ${n} 次`,
      more: (n: number) => `＋ 網頁上還有 ${n} 張`,
    },
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
  // Research template
  papers: { en: "Papers", "zh-TW": "論文" },
  articles: { en: "Articles", "zh-TW": "文章" },
  datasets: { en: "Datasets", "zh-TW": "資料集" },
  methods: { en: "Methods", "zh-TW": "方法" },
  "research-tools": { en: "Tools", "zh-TW": "研究工具" },
  "people-talks": { en: "People & talks", "zh-TW": "人物與演講" },
  "to-read": { en: "To read", "zh-TW": "待讀" },
  // Everyday template
  cooking: { en: "Cooking", "zh-TW": "料理" },
  travel: { en: "Travel", "zh-TW": "旅遊" },
  health: { en: "Health", "zh-TW": "健康" },
  money: { en: "Money", "zh-TW": "理財" },
  home: { en: "Home", "zh-TW": "居家" },
  entertainment: { en: "Entertainment", "zh-TW": "娛樂" },
  shopping: { en: "Shopping", "zh-TW": "購物" },
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
