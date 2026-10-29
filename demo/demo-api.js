// driftnet web demo: a stand-in for the server's JSON API, running inside the page.
// Loaded before the real page script (see scripts/build-demo.mjs). It wraps window.fetch and answers /api/* from
// the snapshot in data.js. Reads follow the server's rules (list filters, sort, X-Total-Count); writes (stars,
// notes, moves, trash, folders, votes, undo) are kept in memory and in sessionStorage so a refresh keeps them.
// What cannot work without a server (adding a link, settings, export, AI tidy ...) answers with a friendly toast.
(() => {
  "use strict";
  const DATA = window.DRIFTNET_DEMO_DATA;
  const REPO = "https://github.com/KevinChu1110/driftnet#-quick-start";
  const MSG = {
    en: "This is a demo — run `npx driftnet` to use it for real.",
    "zh-TW": "這是線上展示，要實際使用請執行 `npx driftnet`。",
  };
  const BANNER = {
    en: ["Demo: changes stay in your browser", "Install →"],
    "zh-TW": ["展示版：你的操作只留在這個瀏覽器", "立即安裝 →"],
  };
  const WORTH = ["skip", "low", "normal", "must-see"];
  const SAVE = "driftnet-demo-state";

  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const ssGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const ssSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private window: keep it in memory only */ } };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  /** The page's language: what the visitor chose, else the browser's. */
  const lang = () => {
    const saved = lsGet("driftnet-locale");
    if (saved === "en" || saved === "zh-TW") return saved;
    return /^zh/i.test(navigator.language || "") ? "zh-TW" : "en";
  };

  // ── State ──────────────────────────────────────────────────────────────
  // ov: what the visitor changed per card (shared by both languages, cards have the same ids in each);
  // folders: the tree per language (a created or renamed folder has one name, in the language it was made in).
  let st;
  try { st = JSON.parse(ssGet(SAVE) ?? "null"); } catch { st = null; }
  if (!st || typeof st !== "object") st = {};
  st.ov ??= {}; st.folders ??= {}; st.notes ??= []; st.nextNote ??= 1; st.undo ??= {}; st.votes ??= {};
  const save = () => ssSet(SAVE, JSON.stringify(st));
  const folderList = () => (st.folders[lang()] ??= clone(DATA[lang()].folders.map(({ count, ...f }) => f)));
  const ovOf = (id) => (st.ov[id] ??= {});

  const baseItems = () => DATA[lang()].items;
  /** A card as the server would serve it, with the visitor's changes on top. */
  function view(base) {
    const o = st.ov[base.id] ?? {};
    const folders = folderList();
    const category = o.category && folders.some((f) => f.id === o.category) ? o.category : base.category;
    const it = { ...base, favorite: o.favorite ?? base.favorite, category, placed: o.placed ?? base.placed };
    const note = o.note !== undefined ? o.note : base.note;
    if (note) it.note = note; else delete it.note;
    if (o.trashedAt) it.trashedAt = o.trashedAt; else delete it.trashedAt;
    return it;
  }
  const allItems = () => baseItems().map(view);
  const find = (id) => baseItems().find((i) => i.id === id);
  const live = (i) => !i.trashedAt;
  const netVotes = (id) => Object.values(st.votes[id] ?? {}).reduce((n, v) => n + v, 0);
  const clean = (i) => !(i.flags ?? []).includes("injection") && netVotes(i.id) > -2;

  const descendants = (id) => {
    const all = folderList(); const out = [id];
    for (let k = 0; k < out.length; k++) for (const f of all) if (f.parent === out[k]) out.push(f.id);
    return out;
  };
  const folderOut = () => {
    const items = allItems().filter(live);
    return [...folderList()].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)).map((f) => ({
      ...f, count: items.filter((i) => i.category === f.id).length, uses: f.uses ?? 0,
      label: f.label ?? { en: f.name ?? f.id, "zh-TW": f.name ?? f.id },
    }));
  };

  // ── Reads ──────────────────────────────────────────────────────────────
  const searchText = (i) => {
    const s = i.summary ?? {};
    return [s.name, s.oneLiner, s.demo, s.why, ...(s.highlights ?? []), ...(s.tags ?? []), ...(s.useCases ?? []), i.title, i.url, i.note, JSON.stringify(i.said ?? [])]
      .filter(Boolean).join("\n").toLowerCase();
  }
  function listItems(p) {
    const view_ = p.get("view");
    let list = allItems().filter((i) => (view_ === "trash" ? !!i.trashedAt : !i.trashedAt));
    if (view_ === "favorites") list = list.filter((i) => i.favorite);
    if (view_ === "inbox") list = list.filter((i) => !i.placed);
    const health = (p.get("health") ?? "").split(",").filter(Boolean);
    if (health.length) list = list.filter((i) => health.includes(i.health));
    if (p.get("category")) { const ids = descendants(p.get("category")); list = list.filter((i) => ids.includes(i.category)); }
    if (p.get("kind")) list = list.filter((i) => i.kind === p.get("kind"));
    if (p.get("since")) list = list.filter((i) => i.createdAt >= p.get("since"));
    const mw = WORTH.indexOf(p.get("minWorth"));
    if (mw >= 0) list = list.filter((i) => WORTH.indexOf(i.worth) >= mw);
    if (p.get("all") !== "1") list = list.filter(clean);
    const terms = (p.get("q") ?? "").slice(0, 200).split(/\s+/).map((t) => t.replace(/"/g, "").toLowerCase()).filter(Boolean).slice(0, 8);
    if (terms.length) list = list.filter((i) => { const hay = searchText(i); return terms.every((t) => hay.includes(t)); });
    const w = (i) => WORTH.indexOf(i.worth);
    const sort = p.get("sort");
    list.sort(view_ === "trash" ? (a, b) => (b.trashedAt > a.trashedAt ? 1 : -1)
      : view_ === "inbox" || sort === "newest" ? (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id)
      : sort === "shared" ? (a, b) => b.shareCount - a.shareCount || w(b) - w(a) || (b.updatedAt > a.updatedAt ? 1 : -1)
      : (a, b) => w(b) - w(a) || (b.updatedAt > a.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    const total = list.length;
    const off = Math.max(0, Number(p.get("offset") ?? 0) || 0);
    const lim = Math.min(500, Math.max(1, Number(p.get("limit") ?? 200) || 200));
    const keep = view_ === "inbox";
    return { total, items: list.slice(off, off + lim).map((i) => { if (!keep) delete i.suggestions; return i; }) };
  }
  function stats() {
    const all = allItems(); const on = all.filter(live);
    const byCategory = {};
    for (const i of on) byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
    const ok = on.filter(clean);
    return {
      items: on.length, shares: on.reduce((n, i) => n + (i.shareCount ?? 0), 0), favorites: on.filter((i) => i.favorite).length,
      trash: all.length - on.length, byCategory, inbox: ok.filter((i) => !i.placed).length,
      review: ok.filter((i) => ["dead", "archived", "stale"].includes(i.health)).length, engines: { judge: "heuristic", summarizer: "off" },
    };
  }
  function ui() {
    const categories = {};
    for (const f of folderOut()) categories[f.id] = f.label;
    return { ...DATA[lang()].ui, locale: lang(), categories, summaries: true, role: "admin", local: false, passwordSet: false, setup: false };
  }
  const notesList = (q) => {
    const t = (q ?? "").toLowerCase();
    return [...st.notes].filter((n) => !t || `${n.title}\n${n.body}`.toLowerCase().includes(t)).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  };

  // ── Writes ─────────────────────────────────────────────────────────────
  class Bad extends Error { constructor(m, status = 400) { super(m); this.status = status; } }
  const snap = (id) => clone(st.ov[id] ?? {});
  const restoreOv = (id, o) => { if (Object.keys(o).length) st.ov[id] = o; else delete st.ov[id]; };
  const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

  function bulk(body) {
    const ids = [...new Set(Array.isArray(body?.ids) ? body.ids.filter((n) => Number.isInteger(n) && find(n)) : [])];
    if (!ids.length) throw new Bad("expected { ids: item ids, action: move | trash | restore | favorite | unfavorite, folder? }");
    const a = body.action;
    if (a === "move" && !folderList().some((f) => f.id === body.folder)) throw new Bad(`no folder ${body.folder}`, 404);
    const previous = ids.map((id) => ({ id, ov: snap(id) }));
    for (const id of ids) {
      const o = ovOf(id);
      if (a === "move") { o.category = body.folder; o.placed = true; }
      else if (a === "trash") o.trashedAt = stamp();
      else if (a === "restore") delete o.trashedAt;
      else if (a === "favorite") o.favorite = true;
      else if (a === "unfavorite") o.favorite = false;
      else throw new Bad("unknown action");
    }
    const undo = Math.random().toString(36).slice(2, 10);
    st.undo[undo] = { previous };
    const keys = Object.keys(st.undo); for (const k of keys.slice(0, -20)) delete st.undo[k];
    return { ok: true, undo, count: ids.length };
  }
  function undo(body) {
    const s = st.undo[body?.undo];
    if (!s) throw new Bad("nothing to undo: unknown or expired id", 404);
    for (const { id, ov } of s.previous) restoreOv(id, ov);
    delete st.undo[body.undo];
    return { ok: true, count: s.previous.length };
  }
  const sameName = (f, name) => [f.name, f.id, ...(f.label ? Object.values(f.label) : [])].filter(Boolean).some((x) => String(x).toLowerCase() === name.toLowerCase());
  function createFolder(b) {
    const folders = folderList();
    const name = String(b.name ?? "").trim().slice(0, 60);
    if (!name || /^\.+$/.test(name)) throw new Bad("a folder needs a name");
    const parent = b.parent || null;
    if (parent && !folders.some((f) => f.id === parent)) throw new Bad(`no folder ${parent}`);
    if (folders.some((f) => (f.parent ?? null) === parent && sameName(f, name))) throw new Bad(`there is already a folder called “${name}” here`);
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    let id = base.length >= 2 ? base : `f-${Math.random().toString(36).slice(2, 8)}`;
    while (folders.some((f) => f.id === id)) id = `${base || "f"}-${Math.random().toString(36).slice(2, 6)}`;
    const position = Math.max(-1, ...folders.filter((f) => (f.parent ?? null) === parent).map((f) => f.position)) + 1;
    const f = { id, parent, name, description: String(b.description ?? "").trim().slice(0, 300), position, builtin: false, uses: 0, label: { en: name, "zh-TW": name } };
    folders.push(f);
    return f;
  }
  function patchFolder(id, b) {
    const folders = folderList(); const f = folders.find((x) => x.id === id);
    if (!f) throw new Bad(`no folder ${id}`);
    if (b.parent !== undefined && b.parent !== null) {
      if (!folders.some((x) => x.id === b.parent)) throw new Bad(`no folder ${b.parent}`);
      if (descendants(id).includes(b.parent)) throw new Bad("a folder can't go inside itself");
    }
    if (b.name !== undefined && (!String(b.name).trim() || /^\.+$/.test(String(b.name).trim()))) throw new Bad("a folder needs a name");
    if (b.name !== undefined) { f.name = String(b.name).trim().slice(0, 60); f.label = { en: f.name, "zh-TW": f.name }; }
    if (b.description !== undefined) f.description = String(b.description).trim().slice(0, 300);
    if (b.parent !== undefined) f.parent = b.parent;
    if (b.position !== undefined) f.position = Number(b.position);
    return f;
  }
  function deleteFolder(id) {
    const folders = folderList(); const f = folders.find((x) => x.id === id);
    if (id === "other") throw new Bad("“other” catches everything unsorted and can't be deleted");
    if (!f) throw new Bad(`no folder ${id}`);
    const up = f.parent ?? "other";
    for (const i of baseItems()) {
      const cur = view(i).category;
      if (cur === id) { const o = ovOf(i.id); o.category = up; }
    }
    for (const x of folders) if (x.parent === id) x.parent = f.parent;
    st.folders[lang()] = folders.filter((x) => x.id !== id);
  }

  // ── Routing ────────────────────────────────────────────────────────────
  let toastOnUnsupported = true;
  function handle(method, url, body) {
    const p = url.pathname; let m;
    const ok = (data, headers) => ({ status: 200, data, headers });
    try {
      if (method === "GET") {
        if (p === "/api/stats") return ok(stats());
        if (p === "/api/ui") return ok(ui());
        if (p === "/api/folders") return ok(folderOut());
        if (p === "/api/categories") return ok(Object.fromEntries(folderList().map((f) => [f.id, f.description])));
        if (p === "/api/notes") return ok(notesList(url.searchParams.get("q")));
        if (p === "/api/items") { const r = listItems(url.searchParams); return ok(r.items, { "X-Total-Count": String(r.total) }); }
        if ((m = /^\/api\/items\/(\d+)$/.exec(p))) { const i = find(Number(m[1])); return i ? ok(view(i)) : { status: 404, data: { error: "not found" } }; }
        if (/^\/api\/media\//.test(p)) return { status: 404, data: { error: "not found" } };
      } else {
        if (p === "/api/items/bulk") return ok(bulk(body));
        if (p === "/api/items/bulk/undo") return ok(undo(body));
        if ((m = /^\/api\/items\/(\d+)\/(trash|restore|favorite|unfavorite)$/.exec(p))) {
          const id = Number(m[1]); if (!find(id)) return { status: 404, data: { error: "not found" } };
          bulk({ ids: [id], action: m[2] }); return ok(view(find(id)));
        }
        if ((m = /^\/api\/items\/(\d+)\/move$/.exec(p))) {
          const id = Number(m[1]); if (!find(id)) return { status: 404, data: { error: "not found" } };
          bulk({ ids: [id], action: "move", folder: String(body?.folder ?? "") }); return ok(view(find(id)));
        }
        if ((m = /^\/api\/items\/(\d+)\/note$/.exec(p)) && method === "PUT") {
          const id = Number(m[1]); if (!find(id)) return { status: 404, data: { error: "not found" } };
          ovOf(id).note = String(body?.note ?? "").slice(0, 2000); return ok(view(find(id)));
        }
        if ((m = /^\/api\/items\/(\d+)\/feedback$/.exec(p))) {
          const id = Number(m[1]); if (!find(id)) return { status: 404, data: { error: "not found" } };
          if (body?.vote !== "up" && body?.vote !== "down") throw new Bad('vote must be "up" or "down"');
          (st.votes[id] ??= {}).you = body.vote === "up" ? 1 : -1; return ok({ ok: true });
        }
        if (p === "/api/folders" && method === "POST") return ok(folderOut().find((f) => f.id === createFolder(body ?? {}).id));
        if ((m = /^\/api\/folders\/([^/]+)$/.exec(p)) && !["suggest", "template"].includes(m[1])) {
          const id = decodeURIComponent(m[1]);
          if (method === "PATCH") { patchFolder(id, body ?? {}); return ok(folderOut().find((f) => f.id === id)); }
          if (method === "DELETE") { deleteFolder(id); return ok({ ok: true }); }
        }
        if (p === "/api/notes" && method === "POST") {
          const n = { id: st.nextNote++, title: String(body?.title ?? ""), body: String(body?.body ?? ""), createdAt: stamp(), updatedAt: stamp() };
          st.notes.push(n); return ok(n);
        }
        if ((m = /^\/api\/notes\/(\d+)$/.exec(p))) {
          const n = st.notes.find((x) => x.id === Number(m[1]));
          if (!n) return { status: 404, data: { error: "not found" } };
          if (method === "DELETE") { st.notes = st.notes.filter((x) => x !== n); return ok({ ok: true }); }
          if (method === "PUT") { n.title = String(body?.title ?? ""); n.body = String(body?.body ?? ""); n.updatedAt = stamp(); return ok(n); }
        }
      }
    } catch (err) {
      if (err instanceof Bad) return { status: err.status, data: { error: err.message } };
      throw err;
    } finally { save(); }
    // Everything else needs a real server: adding a link, settings, tokens, pairing, import, export, refresh, AI tidy ...
    return { status: 501, data: { error: MSG[lang()] }, unsupported: true };
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  let hideTimer;
  /** The page's own toast element, so the message looks like any other the page shows. */
  function demoToast() {
    const t = document.getElementById("toast"), text = document.getElementById("toast-text");
    if (!t || !text) return;
    text.textContent = MSG[lang()];
    const u = document.getElementById("toast-undo"); if (u) u.hidden = true;
    t.classList.add("show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (text.textContent === MSG[lang()]) t.classList.remove("show"); }, 6000);
  }

  // ── fetch ──────────────────────────────────────────────────────────────
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    // Under /driftnet/ the page may ask for /api/x (absolute) or ./api/x: the shim only cares about what follows "/api/".
    const at = url.pathname.indexOf("/api/");
    if (url.origin !== location.origin || at < 0) return realFetch(input, init);
    const clean_ = new URL(url.href); clean_.pathname = url.pathname.slice(at);
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const r = handle((init.method ?? "GET").toUpperCase(), clean_, body);
    if (r.unsupported && toastOnUnsupported) setTimeout(demoToast, 60);
    return new Response(JSON.stringify(r.data), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  };

  // Things that open a dialog full of server settings: say so up front instead of showing a broken dialog.
  const BLOCKED = '[data-settings], [data-connect], [data-export], [data-suggest], [data-login], [data-connect-empty]';
  document.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest(BLOCKED) : null;
    if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    demoToast();
  }, true);
  document.addEventListener("submit", (e) => {
    if (e.target instanceof Element && e.target.id === "add-form") { e.preventDefault(); e.stopImmediatePropagation(); demoToast(); }
  }, true);

  // ── Banner ─────────────────────────────────────────────────────────────
  function banner() {
    const bar = document.createElement("div");
    bar.id = "demo-banner";
    bar.setAttribute("role", "note");
    bar.style.cssText = "display:flex;gap:10px;justify-content:center;align-items:center;flex-wrap:wrap;padding:6px 16px;font:600 13px/1.4 system-ui,sans-serif;background:#2459e0;color:#fff;text-align:center";
    const span = document.createElement("span");
    const a = document.createElement("a");
    a.href = REPO; a.target = "_blank"; a.rel = "noopener";
    a.style.cssText = "color:#fff;text-decoration:underline;white-space:nowrap";
    bar.append(span, a);
    const paint = () => { const [t, l] = BANNER[lang()]; span.textContent = t; a.textContent = l; };
    paint();
    document.body.prepend(bar);
    new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }
  if (document.body) banner(); else document.addEventListener("DOMContentLoaded", banner);
})();
