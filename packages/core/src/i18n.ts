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
    working: "⏳ Reading this one (a video takes a while) — the reply follows in a moment",
    needsPage: "⏳ The site showed nothing to an anonymous visitor; send it from the Chrome extension while logged in, or share it again later",
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
    rich: {
      open: "Open",
      worth: "Worth",
      folder: "Folder",
      tags: "Tags",
      worthName: { skip: "Skip", low: "Low", normal: "Worth a look", "must-see": "Must-see" },
      unknownVote: "Unknown vote",
    },
    locale: "en",
  },
  "zh-TW": {
    injection: "⚠️ 內容含有針對 AI 的指令，不會提供給 agent",
    lowReputation: "⚠️ 此來源常被倒讚，未做摘要",
    mentions: "提到：",
    listSep: "、",
    queued: "⏳ 等待摘要（已排進 agent 的待整理佇列）",
    working: "⏳ 讀取中（影片要多花一點時間），稍後補上回覆",
    needsPage: "⏳ 這個網站沒給匿名訪客看內容；請登入後用 Chrome 擴充功能送一次，或晚點再分享",
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
    rich: {
      open: "開啟",
      worth: "價值",
      folder: "資料夾",
      tags: "標籤",
      worthName: { skip: "略過", low: "普通", normal: "值得一看", "must-see": "必看" },
      unknownVote: "無法辨識的投票",
    },
    locale: "zh-TW",
  },
  "zh-CN": {
    injection: "⚠️ 内容包含针对 AI 的指令，不会提供给 agent",
    lowReputation: "⚠️ 此来源常被踩，未做摘要",
    mentions: "提到：",
    listSep: "、",
    queued: "⏳ 等待摘要（已加入 agent 的待整理队列）",
    working: "⏳ 正在读取（视频需要多一点时间），稍后补上回复",
    needsPage: "⏳ 该网站未向匿名访客显示内容；请登录后用 Chrome 扩展再发一次，或稍后再分享",
    alsoFound: "＋ ",
    seenBefore: "（已收录过）",
    cached: (n: number) => `（已收录过 · 分享 ${n} 次）`,
    footer: (id: number) => `#${id} · 回复 👍${id} / 👎${id}`,
    noItem: (id: number) => `找不到 #${id}。`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — 收到，之后类似的内容会更早被跳过`,
    digest: {
      title: (period: "daily" | "weekly") => (period === "daily" ? "driftnet 今日" : "driftnet 本周"),
      counts: (fresh: number, inbox: number) => `新增 ${fresh} 张卡片 · 收件箱还有 ${inbox} 张待整理`,
      top: "精选",
      shared: "最多人分享",
      sharedTimes: (n: number) => `分享 ${n} 次`,
      more: (n: number) => `＋ 网页上还有 ${n} 张`,
    },
    rich: {
      open: "打开",
      worth: "价值",
      folder: "文件夹",
      tags: "标签",
      worthName: { skip: "跳过", low: "一般", normal: "值得一看", "must-see": "必看" },
      unknownVote: "无法识别的投票",
    },
    locale: "zh-CN",
  },
  ja: {
    injection: "⚠️ AI 向けの指示が含まれているため、エージェントへの提供から除外しました",
    lowReputation: "⚠️ 低評価の多いソースのため、要約をスキップしました",
    mentions: "言及: ",
    listSep: "、",
    queued: "⏳ 要約待ち（エージェントのキューに追加済み）",
    working: "⏳ 読み込み中（動画は少し時間がかかります）— まもなく返信します",
    needsPage: "⏳ 匿名アクセスでは内容が表示されませんでした。ログイン中に Chrome 拡張機能から送信するか、後でもう一度共有してください",
    alsoFound: "+ ",
    seenBefore: "（保存済み）",
    cached: (n: number) => `（保存済み · ${n}回共有）`,
    footer: (id: number) => `#${id} · 返信で 👍${id} / 👎${id}`,
    noItem: (id: number) => `#${id} が見つかりません。`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — 記録しました。今後類似アイテムは早めにスキップされます`,
    digest: {
      title: (period: "daily" | "weekly") => (period === "daily" ? "今日の driftnet" : "今週の driftnet"),
      counts: (fresh: number, inbox: number) => `新着 ${fresh} 件 · 受信トレイに未整理 ${inbox} 件`,
      top: "おすすめ",
      shared: "よく共有された項目",
      sharedTimes: (n: number) => `${n}回共有`,
      more: (n: number) => `ほか ${n} 件をページで表示`,
    },
    rich: {
      open: "開く",
      worth: "おすすめ度",
      folder: "フォルダ",
      tags: "タグ",
      worthName: { skip: "スキップ", low: "低", normal: "要チェック", "must-see": "必見" },
      unknownVote: "不明な投票",
    },
    locale: "ja",
  },
  ko: {
    injection: "⚠️ AI를 겨냥한 지시가 포함되어 있어 에이전트 피드에서 숨겼습니다",
    lowReputation: "⚠️ 비추천이 많은 출처라 요약하지 않았습니다",
    mentions: "언급: ",
    listSep: ", ",
    queued: "⏳ 요약 대기 중 (에이전트 대기열에 추가됨)",
    working: "⏳ 읽는 중입니다 (영상은 시간이 조금 걸립니다) — 곧 답장할게요",
    needsPage: "⏳ 비로그인 방문자에게 내용이 보이지 않습니다. 로그인한 상태에서 Chrome 확장 프로그램으로 보내거나 나중에 다시 공유해 주세요",
    alsoFound: "+ ",
    seenBefore: "(이미 저장됨)",
    cached: (n: number) => `(이미 저장됨 · ${n}회 공유)`,
    footer: (id: number) => `#${id} · 답장으로 👍${id} / 👎${id}`,
    noItem: (id: number) => `#${id} 항목을 찾을 수 없습니다.`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — 반영했습니다. 앞으로 비슷한 항목은 더 빨리 건너뜁니다`,
    digest: {
      title: (period: "daily" | "weekly") => (period === "daily" ? "오늘의 driftnet" : "이번 주 driftnet"),
      counts: (fresh: number, inbox: number) => `새 카드 ${fresh}개 · 받은함 정리 대기 ${inbox}개`,
      top: "주요 추천",
      shared: "가장 많이 공유됨",
      sharedTimes: (n: number) => `${n}회 공유`,
      more: (n: number) => `페이지에서 ${n}개 더 보기`,
    },
    rich: {
      open: "열기",
      worth: "가치",
      folder: "폴더",
      tags: "태그",
      worthName: { skip: "건너뛰기", low: "낮음", normal: "볼 만함", "must-see": "필독" },
      unknownVote: "알 수 없는 투표",
    },
    locale: "ko",
  },
  es: {
    injection: "⚠️ Contiene instrucciones dirigidas a la IA — oculto de los feeds de agentes",
    lowReputation: "⚠️ Fuente votada negativamente con frecuencia — no resumida",
    mentions: "Menciones: ",
    listSep: ", ",
    queued: "⏳ Esperando resumen (en cola para tu agente)",
    working: "⏳ Leyendo esto (un video tarda un poco) — la respuesta llega en un momento",
    needsPage: "⏳ El sitio no mostró contenido a un visitante anónimo; envíalo desde la extensión de Chrome con tu sesión iniciada o compártelo más tarde",
    alsoFound: "+ ",
    seenBefore: "(ya guardado)",
    cached: (n: number) => `(ya guardado · compartido ${n}×)`,
    footer: (id: number) => `#${id} · responde 👍${id} / 👎${id}`,
    noItem: (id: number) => `No existe el elemento #${id}.`,
    votedUp: (id: number) => `👍 #${id}`,
    votedDown: (id: number) => `👎 #${id} — anotado, los elementos similares se omitirán antes`,
    digest: {
      title: (period: "daily" | "weekly") => (period === "daily" ? "Hoy en driftnet" : "Esta semana en driftnet"),
      counts: (fresh: number, inbox: number) => `${fresh} ${fresh === 1 ? "tarjeta nueva" : "tarjetas nuevas"} · ${inbox} en la bandeja de entrada`,
      top: "Destacados",
      shared: "Más compartidos",
      sharedTimes: (n: number) => `compartido ${n}×`,
      more: (n: number) => `+ ${n} más en la página`,
    },
    rich: {
      open: "Abrir",
      worth: "Valor",
      folder: "Carpeta",
      tags: "Etiquetas",
      worthName: { skip: "Omitir", low: "Bajo", normal: "Vale la pena", "must-see": "Imprescindible" },
      unknownVote: "Voto desconocido",
    },
    locale: "es",
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
  const lang = env.DRIFTNET_LANGUAGE ?? "";
  if (/simplified|简体|簡體|zh[-_]?cn|zh[-_]?hans|china|\bprc\b/i.test(lang)) return "zh-CN";
  if (/traditional|繁體|繁体|繁中|taiwan|zh[-_]?tw|zh[-_]?hant|chinese|中文|\bzh\b/i.test(lang)) return "zh-TW";
  if (/japanese|日本語|日本|\bja\b/i.test(lang)) return "ja";
  if (/korean|한국어|한국|\bko\b/i.test(lang)) return "ko";
  if (/spanish|español|espanol|castellano|\bes\b/i.test(lang)) return "es";
  return "en";
}

export function messages(locale: Locale = resolveLocale()): Messages {
  return MESSAGES[locale];
}

/** Display names for the built-in shelves. Custom categories show their id. */
const CATEGORY_LABELS: Record<string, Record<Locale, string>> = {
  "coding-agent": { en: "Coding agents", "zh-TW": "AI 寫程式", "zh-CN": "AI 编程", ja: "コーディングエージェント", ko: "코딩 에이전트", es: "Agentes de código" },
  "agent-framework": { en: "Agent frameworks", "zh-TW": "Agent 框架", "zh-CN": "Agent 框架", ja: "エージェントフレームワーク", ko: "에이전트 프레임워크", es: "Frameworks de agentes" },
  "chat-assistant": { en: "Chat assistants", "zh-TW": "聊天助理", "zh-CN": "聊天助手", ja: "チャットアシスタント", ko: "채팅 어시스턴트", es: "Asistentes de chat" },
  "image-video": { en: "Image & video", "zh-TW": "圖片影片", "zh-CN": "图片视频", ja: "画像・動画", ko: "이미지·영상", es: "Imagen y video" },
  "design-frontend": { en: "Design & frontend", "zh-TW": "設計前端", "zh-CN": "设计前端", ja: "デザイン・フロントエンド", ko: "디자인·프론트엔드", es: "Diseño y frontend" },
  "audio-voice": { en: "Audio & voice", "zh-TW": "語音音訊", "zh-CN": "语音音频", ja: "音声・オーディオ", ko: "오디오·음성", es: "Audio y voz" },
  automation: { en: "Automation", "zh-TW": "自動化", "zh-CN": "自动化", ja: "自動化", ko: "자동화", es: "Automatización" },
  "knowledge-rag": { en: "Knowledge & RAG", "zh-TW": "知識庫", "zh-CN": "知识库", ja: "ナレッジ・RAG", ko: "지식베이스·RAG", es: "Conocimiento y RAG" },
  "model-infra": { en: "Models & infra", "zh-TW": "模型與基礎設施", "zh-CN": "模型与基础设施", ja: "モデル・インフラ", ko: "모델·인프라", es: "Modelos e infraestructura" },
  productivity: { en: "Productivity", "zh-TW": "生產力", "zh-CN": "生产力", ja: "生産性", ko: "생산성", es: "Productividad" },
  news: { en: "News", "zh-TW": "新聞動態", "zh-CN": "新闻动态", ja: "ニュース", ko: "뉴스", es: "Noticias" },
  learning: { en: "Learning", "zh-TW": "學習資源", "zh-CN": "学习资源", ja: "学習リソース", ko: "학습 자료", es: "Aprendizaje" },
  other: { en: "Other", "zh-TW": "其他", "zh-CN": "其他", ja: "その他", ko: "기타", es: "Otros" },
  // Research template
  papers: { en: "Papers", "zh-TW": "論文", "zh-CN": "论文", ja: "論文", ko: "논문", es: "Artículos científicos" },
  articles: { en: "Articles", "zh-TW": "文章", "zh-CN": "文章", ja: "記事", ko: "아티클", es: "Artículos" },
  datasets: { en: "Datasets", "zh-TW": "資料集", "zh-CN": "数据集", ja: "データセット", ko: "데이터셋", es: "Conjuntos de datos" },
  methods: { en: "Methods", "zh-TW": "方法", "zh-CN": "方法", ja: "手法", ko: "방법론", es: "Métodos" },
  "research-tools": { en: "Tools", "zh-TW": "研究工具", "zh-CN": "研究工具", ja: "研究ツール", ko: "연구 도구", es: "Herramientas" },
  "people-talks": { en: "People & talks", "zh-TW": "人物與演講", "zh-CN": "人物与演讲", ja: "人物・講演", ko: "인물·강연", es: "Personas y charlas" },
  "to-read": { en: "To read", "zh-TW": "待讀", "zh-CN": "待读", ja: "あとで読む", ko: "읽을거리", es: "Por leer" },
  // Everyday template
  cooking: { en: "Cooking", "zh-TW": "料理", "zh-CN": "料理", ja: "料理", ko: "요리", es: "Cocina" },
  travel: { en: "Travel", "zh-TW": "旅遊", "zh-CN": "旅游", ja: "旅行", ko: "여행", es: "Viajes" },
  health: { en: "Health", "zh-TW": "健康", "zh-CN": "健康", ja: "健康", ko: "건강", es: "Salud" },
  money: { en: "Money", "zh-TW": "理財", "zh-CN": "理财", ja: "マネー", ko: "재테크", es: "Finanzas" },
  home: { en: "Home", "zh-TW": "居家", "zh-CN": "居家", ja: "暮らし", ko: "생활·홈", es: "Hogar" },
  entertainment: { en: "Entertainment", "zh-TW": "娛樂", "zh-CN": "娱乐", ja: "エンタメ", ko: "엔터테인먼트", es: "Entretenimiento" },
  shopping: { en: "Shopping", "zh-TW": "購物", "zh-CN": "购物", ja: "ショッピング", ko: "쇼핑", es: "Compras" },
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
