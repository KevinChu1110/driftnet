import type { Driftnet, Item, Locale } from "@driftnet/core";

/**
 * Static Showcase exporter: turns the whole catalogue (or one folder subtree)
 * into a self-contained, searchable static website ready for GitHub Pages,
 * Cloudflare Pages or opening directly from disk.
 *
 * Privacy: trash, prompt-injection-flagged items, personal notes, chat
 * messages and internal proxy URLs never leave the machine.
 */

export interface ShowcaseFolder {
  id: string;
  parent: string | null;
  label: string;
  path: string[];
  count: number;
}

export interface ShowcaseItem {
  id: number;
  name: string;
  url: string;
  folder: string;
  folderLabel: string;
  kind: string;
  worth: string;
  oneLiner: string | null;
  demo: string | null;
  why: string | null;
  highlights: string[];
  useCases: string[];
  tryIt: string | null;
  tags: string[];
  stars: number | null;
  added: string;
}

export interface ShowcaseData {
  title: string;
  locale: Locale;
  builtAt: string;
  folders: ShowcaseFolder[];
  items: ShowcaseItem[];
}

export interface ShowcaseFile {
  path: string;
  data: string;
}

export interface ShowcaseResult {
  files: ShowcaseFile[];
  data: ShowcaseData;
}

export interface ShowcaseOptions {
  folder?: string;
  title?: string;
  locale?: Locale;
  builtAt?: string;
}

export class ShowcaseError extends Error {}

const safeHttpUrl = (raw: string | undefined): string => {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
};

/** Escape a JSON string so it can be embedded safely inside a `<script>` tag. */
function safeJsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Collect public-safe showcase data from a local Driftnet instance. */
export function buildShowcaseData(dn: Driftnet, opts: ShowcaseOptions = {}): ShowcaseData {
  const locale: Locale = opts.locale ?? "en";
  const allFolders = dn.store.folders();
  const byId = new Map(allFolders.map((f) => [f.id, f]));
  const labelOf = dn.folderLabeler(locale);

  let allowedFolders: Set<string> | null = null;
  let defaultTitle = "driftnet";

  if (opts.folder) {
    if (!byId.has(opts.folder)) {
      const ids = allFolders.map((f) => f.id).join(", ");
      throw new ShowcaseError(`unknown folder "${opts.folder}". Valid folders: ${ids}`);
    }
    allowedFolders = new Set<string>([opts.folder]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of allFolders) {
        if (f.parent && allowedFolders.has(f.parent) && !allowedFolders.has(f.id)) {
          allowedFolders.add(f.id);
          grew = true;
        }
      }
    }
    defaultTitle = labelOf(opts.folder);
  }

  const pathOf = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | null = id, guard = 0; cur && guard < 20; cur = byId.get(cur)?.parent ?? null, guard++) {
      out.unshift(labelOf(cur));
      if (opts.folder && cur === opts.folder) break;
    }
    return out;
  };

  const rawItems = dn.store.exportable().filter((i) => !allowedFolders || allowedFolders.has(i.category));
  const counts = new Map<string, number>();
  const items: ShowcaseItem[] = [];
  for (const i of rawItems) {
    const href = safeHttpUrl(i.summary?.primaryUrl || i.url);
    if (!href) continue;
    counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    items.push(toShowcaseItem(i, href, labelOf(i.category)));
  }

  const folders: ShowcaseFolder[] = allFolders
    .filter((f) => (!allowedFolders || allowedFolders.has(f.id)) && (counts.get(f.id) ?? 0) > 0)
    .map((f) => ({
      id: f.id,
      parent: opts.folder && f.id === opts.folder ? null : f.parent,
      label: labelOf(f.id),
      path: pathOf(f.id),
      count: counts.get(f.id) ?? 0,
    }));

  return {
    title: opts.title?.trim() || defaultTitle,
    locale,
    builtAt: opts.builtAt ?? new Date().toISOString(),
    folders,
    items,
  };
}

function toShowcaseItem(i: Item, href: string, folderLabel: string): ShowcaseItem {
  const s = i.summary;
  return {
    id: i.id,
    name: s?.name ?? i.title,
    url: href,
    folder: i.category,
    folderLabel,
    kind: i.kind,
    worth: i.worth,
    oneLiner: s?.oneLiner ?? null,
    demo: s?.demo ?? null,
    why: s?.why ?? null,
    highlights: s?.highlights ?? [],
    useCases: s?.useCases ?? [],
    tryIt: s?.tryIt ?? null,
    tags: s?.tags ?? [],
    stars: i.stars ?? null,
    added: i.createdAt.slice(0, 10),
  };
}

/** Build the complete static showcase file set (`index.html`, `data.json`, `.nojekyll`). */
export function toShowcase(dn: Driftnet, opts: ShowcaseOptions = {}): ShowcaseResult {
  const data = buildShowcaseData(dn, opts);
  return {
    data,
    files: [
      { path: "index.html", data: renderShowcaseHtml(data) },
      { path: "data.json", data: JSON.stringify(data, null, 2) + "\n" },
      { path: ".nojekyll", data: "" },
    ],
  };
}

/** Build static showcase files directly from pre-fetched API data (used when exporting via HTTP). */
export function toShowcaseFromApi(
  rawItems: Array<{
    id: number; url: string; title: string; kind: string; category: string; worth: string;
    stars?: number | null; createdAt: string; flags?: string[]; trashedAt?: string | null;
    summary?: Item["summary"];
  }>,
  rawFolders: Array<{ id: string; parent: string | null; name: string | null }>,
  opts: ShowcaseOptions = {},
): ShowcaseResult {
  const locale: Locale = opts.locale ?? "en";
  const byId = new Map(rawFolders.map((f) => [f.id, f]));
  const labelOf = (id: string) => byId.get(id)?.name || id;

  let allowedFolders: Set<string> | null = null;
  let defaultTitle = "driftnet";
  if (opts.folder) {
    if (!byId.has(opts.folder)) {
      const ids = rawFolders.map((f) => f.id).join(", ");
      throw new ShowcaseError(`unknown folder "${opts.folder}". Valid folders: ${ids}`);
    }
    allowedFolders = new Set<string>([opts.folder]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of rawFolders) {
        if (f.parent && allowedFolders.has(f.parent) && !allowedFolders.has(f.id)) {
          allowedFolders.add(f.id);
          grew = true;
        }
      }
    }
    defaultTitle = labelOf(opts.folder);
  }

  const pathOf = (id: string): string[] => {
    const out: string[] = [];
    for (let cur: string | null = id, guard = 0; cur && guard < 20; cur = byId.get(cur)?.parent ?? null, guard++) {
      out.unshift(labelOf(cur));
      if (opts.folder && cur === opts.folder) break;
    }
    return out;
  };

  const counts = new Map<string, number>();
  const items: ShowcaseItem[] = [];
  for (const i of rawItems) {
    if (i.trashedAt || i.flags?.includes("injection")) continue;
    if (allowedFolders && !allowedFolders.has(i.category)) continue;
    const href = safeHttpUrl(i.summary?.primaryUrl || i.url);
    if (!href) continue;
    counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
    items.push({
      id: i.id,
      name: i.summary?.name ?? i.title,
      url: href,
      folder: i.category,
      folderLabel: labelOf(i.category),
      kind: i.kind,
      worth: i.worth,
      oneLiner: i.summary?.oneLiner ?? null,
      demo: i.summary?.demo ?? null,
      why: i.summary?.why ?? null,
      highlights: i.summary?.highlights ?? [],
      useCases: i.summary?.useCases ?? [],
      tryIt: i.summary?.tryIt ?? null,
      tags: i.summary?.tags ?? [],
      stars: i.stars ?? null,
      added: (i.createdAt ?? "").slice(0, 10),
    });
  }

  const folders: ShowcaseFolder[] = rawFolders
    .filter((f) => (!allowedFolders || allowedFolders.has(f.id)) && (counts.get(f.id) ?? 0) > 0)
    .map((f) => ({
      id: f.id,
      parent: opts.folder && f.id === opts.folder ? null : f.parent,
      label: labelOf(f.id),
      path: pathOf(f.id),
      count: counts.get(f.id) ?? 0,
    }));

  const data: ShowcaseData = {
    title: opts.title?.trim() || defaultTitle,
    locale,
    builtAt: opts.builtAt ?? new Date().toISOString(),
    folders,
    items,
  };
  return {
    data,
    files: [
      { path: "index.html", data: renderShowcaseHtml(data) },
      { path: "data.json", data: JSON.stringify(data, null, 2) + "\n" },
      { path: ".nojekyll", data: "" },
    ],
  };
}

const HTML_LANG: Record<Locale, string> = {
  en: "en",
  "zh-TW": "zh-Hant",
  "zh-CN": "zh-Hans",
  ja: "ja",
  ko: "ko",
  es: "es",
};

const SHOWCASE_DESC: Record<Locale, (title: string, n: number) => string> = {
  en: (t, n) => `${t} — ${n} curated links and tools, organised with driftnet.`,
  "zh-TW": (t, n) => `${t} — ${n} 個精選連結與工具，使用 driftnet 整理。`,
  "zh-CN": (t, n) => `${t} — ${n} 个精选链接与工具，使用 driftnet 整理。`,
  ja: (t, n) => `${t} — driftnet で整理された厳選リンク・ツール ${n} 件。`,
  ko: (t, n) => `${t} — driftnet으로 정리한 엄선 링크와 도구 ${n}개.`,
  es: (t, n) => `${t} — ${n} enlaces y herramientas seleccionados, organizados con driftnet.`,
};

/** Self-contained, searchable, responsive static HTML showcase page. */
export function renderShowcaseHtml(data: ShowcaseData): string {
  const lang = HTML_LANG[data.locale] ?? "en";
  const title = escHtml(data.title);
  const desc = (SHOWCASE_DESC[data.locale] ?? SHOWCASE_DESC.en)(data.title, data.items.length);

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${escHtml(desc)}">
<meta name="generator" content="driftnet (https://github.com/KevinChu1110/driftnet)">
<style>
  :root {
    --bg: #f8f9fb; --surface: #ffffff; --border: #e5e7eb; --text: #111827; --muted: #6b7280;
    --accent: #2563eb; --accent-soft: #eff6ff; --chip: #f3f4f6; --must: #b45309; --must-bg: #fef3c7;
    --shadow: 0 1px 2px rgba(0,0,0,.05);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b0f17; --surface: #111827; --border: #1f2937; --text: #f3f4f6; --muted: #9ca3af;
      --accent: #60a5fa; --accent-soft: rgba(96,165,250,.14); --chip: #1f2937; --must: #fbbf24; --must-bg: rgba(251,191,36,.14);
      --shadow: 0 1px 3px rgba(0,0,0,.35);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b0f17; --surface: #111827; --border: #1f2937; --text: #f3f4f6; --muted: #9ca3af;
    --accent: #60a5fa; --accent-soft: rgba(96,165,250,.14); --chip: #1f2937; --must: #fbbf24; --must-bg: rgba(251,191,36,.14);
    --shadow: 0 1px 3px rgba(0,0,0,.35);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif; background: var(--bg); color: var(--text); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 20px 64px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
  header h1 { margin: 0; font-size: 26px; letter-spacing: -.02em; }
  .sub { color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 10px; }
  .controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
  .search { flex: 1 1 260px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); font: inherit; }
  .search:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  select, .btn { padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--text); font: inherit; font-size: 14px; cursor: pointer; }
  .btn:hover { border-color: var(--accent); }
  .folders { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; }
  .pill { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 999px; padding: 5px 12px; font-size: 13px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .pill.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .pill .n { opacity: .75; font-size: 12px; }
  .active-tag { display: inline-flex; align-items: center; gap: 6px; margin-bottom: 14px; font-size: 13px; color: var(--muted); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 8px; cursor: pointer; transition: border-color .15s, transform .15s; }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
  .card-title { font-weight: 600; font-size: 16px; color: var(--text); line-height: 1.3; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: var(--chip); color: var(--muted); white-space: nowrap; }
  .badge.must { background: var(--must-bg); color: var(--must); font-weight: 600; }
  .one { margin: 0; font-size: 14px; color: var(--text); }
  .why { margin: 0; font-size: 13px; color: var(--muted); }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: auto; padding-top: 4px; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); border: 0; cursor: pointer; }
  .meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted); margin-top: 2px; }
  .empty { text-align: center; padding: 48px 16px; color: var(--muted); }
  dialog { border: 1px solid var(--border); border-radius: 14px; background: var(--surface); color: var(--text); max-width: 620px; width: calc(100% - 32px); padding: 22px; box-shadow: 0 20px 50px rgba(0,0,0,.25); }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  .dlg-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
  .dlg-head h2 { margin: 0; font-size: 20px; }
  .dlg-sec { margin: 12px 0; }
  .dlg-sec h3 { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .dlg-sec ul { margin: 4px 0 0 18px; padding: 0; }
  .try { background: var(--chip); padding: 8px 10px; border-radius: 8px; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-x: auto; display: block; }
  .dlg-actions { display: flex; gap: 10px; margin-top: 16px; align-items: center; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--border); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; font-size: 13px; color: var(--muted); }
  .powered { font-weight: 500; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title">${title}</h1>
    <div class="sub">
      <span id="count"></span>
      <button type="button" class="btn" id="theme-btn" aria-label="Toggle theme">◐</button>
    </div>
  </header>
  <div class="controls">
    <input type="search" class="search" id="q" autocomplete="off">
    <select id="sort" aria-label="Sort"></select>
  </div>
  <div class="folders" id="folders" role="tablist"></div>
  <div id="tag-bar"></div>
  <main class="grid" id="grid"></main>
  <footer>
    <span id="updated"></span>
    <span class="powered">Built with <a href="https://github.com/KevinChu1110/driftnet" target="_blank" rel="noopener noreferrer">driftnet</a></span>
  </footer>
</div>
<dialog id="dlg"><div id="dlg-body"></div></dialog>
<script id="showcase-data" type="application/json">${safeJsonScript(data)}</script>
<script>
(() => {
  const DATA = JSON.parse(document.getElementById("showcase-data").textContent);
  const STRINGS = {
    en: {
      search: "Search tools, summaries, tags or URLs…", all: "All", sortBest: "Best first", sortNewest: "Newest", sortStars: "Most stars",
      items: (n) => n + (n === 1 ? " item" : " items"), updated: (d) => "Updated " + d, empty: "No matching items.",
      must: "Must-see", demo: "What you'll see", why: "Why it's here", highlights: "Highlights", useCases: "Use cases", tryIt: "Try it",
      open: "Open link ↗", close: "Close", tagFilter: (t) => "Tag: #" + t, clear: "Clear",
    },
    "zh-TW": {
      search: "搜尋名稱、摘要、標籤或網址…", all: "全部", sortBest: "精選優先", sortNewest: "最新加入", sortStars: "最多星星",
      items: (n) => n + " 張卡片", updated: (d) => "更新於 " + d, empty: "找不到符合的項目。",
      must: "必看", demo: "你會看到", why: "為什麼值得看", highlights: "重點", useCases: "適用情境", tryIt: "快速試用",
      open: "開啟連結 ↗", close: "關閉", tagFilter: (t) => "標籤：#" + t, clear: "清除",
    },
    "zh-CN": {
      search: "搜索名称、摘要、标签或网址…", all: "全部", sortBest: "精选优先", sortNewest: "最新加入", sortStars: "最多星标",
      items: (n) => n + " 张卡片", updated: (d) => "更新于 " + d, empty: "找不到匹配的项目。",
      must: "必看", demo: "你会看到", why: "为什么值得看", highlights: "要点", useCases: "适用场景", tryIt: "快速试用",
      open: "打开链接 ↗", close: "关闭", tagFilter: (t) => "标签：#" + t, clear: "清除",
    },
    ja: {
      search: "ツール名・要約・タグ・URL を検索…", all: "すべて", sortBest: "おすすめ順", sortNewest: "新着順", sortStars: "スター数順",
      items: (n) => n + " 件", updated: (d) => "更新日: " + d, empty: "一致する項目がありません。",
      must: "必見", demo: "内容", why: "おすすめの理由", highlights: "ポイント", useCases: "活用シーン", tryIt: "試してみる",
      open: "リンクを開く ↗", close: "閉じる", tagFilter: (t) => "タグ: #" + t, clear: "クリア",
    },
    ko: {
      search: "이름, 요약, 태그 또는 URL 검색…", all: "전체", sortBest: "추천순", sortNewest: "최신순", sortStars: "스타순",
      items: (n) => n + "개 항목", updated: (d) => "업데이트: " + d, empty: "일치하는 항목이 없습니다.",
      must: "필독", demo: "주요 내용", why: "추천 이유", highlights: "핵심 포인트", useCases: "활용 사례", tryIt: "사용해 보기",
      open: "링크 열기 ↗", close: "닫기", tagFilter: (t) => "태그: #" + t, clear: "지우기",
    },
    es: {
      search: "Buscar herramientas, resúmenes, etiquetas o URLs…", all: "Todo", sortBest: "Destacados", sortNewest: "Más recientes", sortStars: "Más estrellas",
      items: (n) => n + (n === 1 ? " elemento" : " elementos"), updated: (d) => "Actualizado " + d, empty: "No hay elementos que coincidan.",
      must: "Imprescindible", demo: "Qué verás", why: "Por qué está aquí", highlights: "Puntos clave", useCases: "Casos de uso", tryIt: "Pruébalo",
      open: "Abrir enlace ↗", close: "Cerrar", tagFilter: (t) => "Etiqueta: #" + t, clear: "Limpiar",
    },
  };
  const T = STRINGS[DATA.locale] || STRINGS.en;
  const WORTH = { "must-see": 3, normal: 2, low: 1, skip: 0 };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const safeUrl = (u) => { try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:" ? p.href : "#"; } catch { return "#"; } };
  const fmtStars = (n) => n == null ? "" : "★ " + (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\\.0$/, "") + "k" : n);

  const state = { q: "", folder: "", tag: "", sort: "best" };
  $("q").placeholder = T.search;
  $("sort").innerHTML = [["best", T.sortBest], ["newest", T.sortNewest], ["stars", T.sortStars]]
    .map(([v, l]) => '<option value="' + v + '">' + esc(l) + "</option>").join("");
  $("updated").textContent = T.updated((DATA.builtAt || "").slice(0, 10));

  function matches(it) {
    if (state.folder && it.folder !== state.folder) return false;
    if (state.tag && !(it.tags || []).includes(state.tag)) return false;
    if (!state.q) return true;
    const hay = [it.name, it.oneLiner, it.demo, it.why, it.url, it.folderLabel, ...(it.highlights || []), ...(it.tags || [])].join(" ").toLowerCase();
    return state.q.toLowerCase().split(/\\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function sorted(list) {
    return [...list].sort((a, b) => {
      if (state.sort === "newest") return (b.added || "").localeCompare(a.added || "") || b.id - a.id;
      if (state.sort === "stars") return (b.stars ?? -1) - (a.stars ?? -1) || b.id - a.id;
      return (WORTH[b.worth] ?? 0) - (WORTH[a.worth] ?? 0) || (b.added || "").localeCompare(a.added || "") || b.id - a.id;
    });
  }

  function renderFolders() {
    if (DATA.folders.length <= 1) { $("folders").innerHTML = ""; return; }
    const pills = [{ id: "", label: T.all, count: DATA.items.length }, ...DATA.folders];
    $("folders").innerHTML = pills.map((f) =>
      '<button type="button" class="pill' + (state.folder === f.id ? " on" : "") + '" data-folder="' + esc(f.id) + '">' +
      esc(f.label) + ' <span class="n">' + f.count + "</span></button>"
    ).join("");
  }

  function render() {
    const list = sorted(DATA.items.filter(matches));
    $("count").textContent = T.items(list.length);
    $("tag-bar").innerHTML = state.tag
      ? '<div class="active-tag">' + esc(T.tagFilter(state.tag)) + ' <button type="button" class="btn" id="clear-tag">' + esc(T.clear) + "</button></div>"
      : "";
    if (!list.length) {
      $("grid").innerHTML = '<div class="empty">' + esc(T.empty) + "</div>";
      return;
    }
    $("grid").innerHTML = list.map((it) => {
      const host = (() => { try { return new URL(it.url).hostname.replace(/^www\\./, ""); } catch { return ""; } })();
      const badge = it.worth === "must-see" ? '<span class="badge must">★ ' + esc(T.must) + "</span>" : '<span class="badge">' + esc(it.folderLabel) + "</span>";
      const tags = (it.tags || []).slice(0, 5).map((t) => '<button type="button" class="tag" data-tag="' + esc(t) + '">#' + esc(t) + "</button>").join("");
      return '<article class="card" tabindex="0" data-id="' + it.id + '">' +
        '<div class="card-top"><a class="card-title" href="' + esc(safeUrl(it.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(it.name) + "</a>" + badge + "</div>" +
        (it.oneLiner ? '<p class="one">' + esc(it.oneLiner) + "</p>" : "") +
        (it.why ? '<p class="why">' + esc(it.why) + "</p>" : "") +
        (tags ? '<div class="tags">' + tags + "</div>" : "") +
        '<div class="meta"><span>' + esc(host) + "</span><span>" + esc([fmtStars(it.stars), it.added].filter(Boolean).join(" · ")) + "</span></div>" +
      "</article>";
    }).join("");
  }

  function openModal(id) {
    const it = DATA.items.find((x) => x.id === id);
    if (!it) return;
    const sec = (h, body) => body ? '<div class="dlg-sec"><h3>' + esc(h) + "</h3>" + body + "</div>" : "";
    $("dlg-body").innerHTML =
      '<div class="dlg-head"><h2>' + esc(it.name) + '</h2><button type="button" class="btn" id="dlg-close">' + esc(T.close) + "</button></div>" +
      (it.oneLiner ? '<p class="one">' + esc(it.oneLiner) + "</p>" : "") +
      sec(T.demo, it.demo ? "<p>" + esc(it.demo) + "</p>" : "") +
      sec(T.why, it.why ? "<p>" + esc(it.why) + "</p>" : "") +
      sec(T.highlights, it.highlights?.length ? "<ul>" + it.highlights.map((h) => "<li>" + esc(h) + "</li>").join("") + "</ul>" : "") +
      sec(T.useCases, it.useCases?.length ? "<ul>" + it.useCases.map((u) => "<li>" + esc(u) + "</li>").join("") + "</ul>" : "") +
      sec(T.tryIt, it.tryIt ? '<code class="try">' + esc(it.tryIt) + "</code>" : "") +
      '<div class="dlg-actions"><a class="btn primary" href="' + esc(safeUrl(it.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(T.open) + "</a>" +
      '<span class="sub">' + esc([it.folderLabel, fmtStars(it.stars), it.added].filter(Boolean).join(" · ")) + "</span></div>";
    $("dlg").showModal();
  }

  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  $("folders").addEventListener("click", (e) => {
    const b = e.target.closest("[data-folder]");
    if (!b) return;
    state.folder = b.dataset.folder;
    renderFolders();
    render();
  });
  $("tag-bar").addEventListener("click", (e) => {
    if (e.target.id === "clear-tag") { state.tag = ""; render(); }
  });
  $("grid").addEventListener("click", (e) => {
    const tag = e.target.closest("[data-tag]");
    if (tag) { e.stopPropagation(); state.tag = tag.dataset.tag; render(); return; }
    if (e.target.closest("a")) return;
    const card = e.target.closest("[data-id]");
    if (card) openModal(Number(card.dataset.id));
  });
  $("grid").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset?.id) openModal(Number(e.target.dataset.id));
  });
  $("dlg").addEventListener("click", (e) => {
    if (e.target === $("dlg") || e.target.id === "dlg-close") $("dlg").close();
  });
  $("theme-btn").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "light" : "dark";
  });

  renderFolders();
  render();
})();
</script>
</body>
</html>
`;
}
