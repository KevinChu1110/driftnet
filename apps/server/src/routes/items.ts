import { join } from "node:path";
import { BlockedUrl, HistoryError, ItemError, RefreshBusy, RefreshTooSoon, canonicalize, FolderError, HEALTH, healthFor, type Health, suggestionsFor, driftnetHome, WORTH, publicItem, type Kind, type IngestResult, type PageContent, type Worth } from "@driftnet/core";
import { bulkAction, bulkUndo } from "../bulk.ts";
import { agentBrief, leaseRow } from "../brief.ts";
import { actorOf, isAdmin, token } from "../access.ts";
import { loadMedia, MediaError } from "../media.ts";
import { BadRequest, type Route } from "../route.ts";

/** An ingest result as served: pictures become proxy paths, also for the repos found inside. */
export function pubResult(r: IngestResult): unknown {
  return { ...r, item: publicItem(r.item), ...(r.related ? { related: r.related.map(pubResult) } : {}) };
}

const NEEDS_PASSWORD = "unauthorized (set an admin password)";

/** Cards: listing, one card, its picture, and what the reader or an agent does to it. */
export const routes: Route[] = [
  {
    method: "GET", pattern: "/api/items", access: "read",
    handler: async ({ url, send, app: { dn } }) => {
      const p = url.searchParams;
      // Time-boxed (1.5 s) and cached; null (off, slow, down) means exactly the keyword search of before.
      const semantic = p.get("q") && !["newest", "shared"].includes(p.get("sort") ?? "") ? await dn.semantic.queryVec(p.get("q")!) : null;
      const minWorth = p.get("minWorth");
      const healthFilter = (p.get("health") ?? "").split(",").filter((h): h is Health => (HEALTH as readonly string[]).includes(h));
      const counted: { total?: number } = {};
      const list = dn.store.list({
        ...(semantic ? { semantic } : {}),
        ...(p.get("q") ? { q: p.get("q")! } : {}),
        ...(p.get("category") ? { category: p.get("category")! } : {}),
        ...(p.get("kind") ? { kind: p.get("kind") as Kind } : {}),
        ...(minWorth && (WORTH as readonly string[]).includes(minWorth) ? { minWorth: minWorth as Worth } : {}),
        ...(p.get("since") ? { since: p.get("since")! } : {}),
        ...(p.get("view") === "favorites" || p.get("view") === "trash" || p.get("view") === "inbox" ? { view: p.get("view") as "favorites" | "trash" | "inbox" } : {}),
        ...(healthFilter.length ? { health: healthFilter } : {}),
        ...(["best", "newest", "shared"].includes(p.get("sort") ?? "") ? { sort: p.get("sort") as "best" | "newest" | "shared" } : {}),
        clean: p.get("all") !== "1",
        limit: Number(p.get("limit") ?? 200),
        offset: Number(p.get("offset") ?? 0),
      }, counted);
      // Tools found inside each item (repos a post named or linked), by name.
      const names = new Map(list.map((i) => [i.id, i.summary?.name ?? i.title]));
      const found = new Map<number, { id: number; name: string }[]>();
      for (const { parent, child } of dn.store.foundLinks()) {
        if (!names.has(parent)) continue;
        const name = names.get(child) ?? dn.store.get(child)?.summary?.name ?? dn.store.get(child)?.title;
        if (name && !dn.store.get(child)?.trashedAt) found.set(parent, [...(found.get(parent) ?? []), { id: child, name }]);
      }
      // What people wrote around the link when they shared it.
      const said = dn.store.chatNotes(list.map((i) => i.id));
      // The Inbox offers each card its best folders (the stored picks, or keyword overlap when there are none).
      const choices = p.get("view") === "inbox" ? dn.categories : null;
      return send(200, list.map((i) => ({ ...publicItem(i), ...(choices ? { suggestions: suggestionsFor(i, choices) } : {}), found: found.get(i.id) ?? [], said: said.get(i.id) ?? [] })),
        undefined, { "X-Total-Count": String(counted.total ?? list.length) });
    },
  },
  {
    method: "GET", pattern: /^\/api\/items\/(\d+)$/, example: "/api/items/1", access: "read",
    handler: ({ m, send, app: { dn } }) => {
      const item = dn.store.get(Number(m[1]));
      return item ? send(200, { ...publicItem(item), related: item.flags.includes("injection") ? [] : dn.semantic.related(item.id, 5) }) : send(404, { error: "not found" });
    },
  },
  // A card's picture, through the proxy (same read rule as the card itself). The stored URL never reaches the page.
  {
    method: "GET", pattern: /^\/api\/media\/(\d+)\/(\d+)$/, example: "/api/media/1/0", access: "read",
    handler: async ({ m, res, send, app: { dn, env } }) => {
      const ref = dn.store.get(Number(m[1]))?.media?.[Number(m[2])];
      if (!ref) return send(404, { error: "not found" });
      try {
        const media = await loadMedia(join(driftnetHome(env), "media"), ref.url, { blockDomains: env.DRIFTNET_BLOCK_DOMAINS });
        res.writeHead(200, {
          "content-type": media.type, "content-length": media.bytes.length, "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
        });
        return res.end(media.bytes);
      } catch (err) {
        if (err instanceof MediaError) return send(err.status, { error: err.message });
        if (err instanceof BlockedUrl) return send(502, { error: err.message });
        throw err;
      }
    },
  },
  // Many cards at once (multi-select in the page); each call is one transaction and returns what undo needs.
  {
    method: "POST", pattern: /^\/api\/items\/bulk(\/undo)?$/, example: "/api/items/bulk", access: "write",
    handler: async ({ req, m, send, json, app: { dn, env } }) => {
      const body = await json<unknown>();
      const out = !m[1] ? bulkAction(dn.store, body, actorOf(req, env, dn.store)) : bulkUndo(dn.store, body, Date.now(), actorOf(req, env, dn.store));
      return send(out.status, out.body);
    },
  },
  // Fetch a card's page again and redo its summary; the reader's note, stars, shares and chosen folder stay.
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/refresh$/, example: "/api/items/1/refresh", access: "write",
    handler: async ({ m, send, app: { dn } }) => {
      const id = Number(m[1]);
      if (!dn.store.get(id)) return send(404, { error: "not found" });
      try {
        const item = await dn.pipeline.refresh(id);
        return item ? send(200, publicItem(item)) : send(404, { error: "not found" });
      } catch (err) {
        if (err instanceof RefreshBusy) return send(409, { error: err.message });
        if (err instanceof RefreshTooSoon) return send(429, { error: err.message });
        if (err instanceof BlockedUrl) return send(422, { error: err.message });
        console.warn(`[driftnet] refresh ${id} failed:`, (err as Error).message);
        return send(502, { error: (err as Error).message });
      }
    },
  },
  // Re-extract only the card's pictures (no summary, no model): the cheap way to backfill older cards.
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/media\/refresh$/, example: "/api/items/1/media/refresh", access: "write",
    handler: async ({ m, send, app: { dn } }) => {
      const id = Number(m[1]);
      try {
        const item = await dn.pipeline.refreshMedia(id);
        return item ? send(200, publicItem(item)) : send(404, { error: "not found" });
      } catch (err) {
        if (err instanceof BlockedUrl) return send(422, { error: err.message });
        console.warn(`[driftnet] media refresh ${id} failed:`, (err as Error).message);
        return send(502, { error: (err as Error).message });
      }
    },
  },
  // Check one card's link now (dead / archived / stale / moved / ok); the weekly job does the same in batches.
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/health$/, example: "/api/items/1/health", access: "write",
    handler: async ({ m, send, app: { dn } }) => {
      const item = dn.store.get(Number(m[1]));
      if (!item) return send(404, { error: "not found" });
      const checked = await healthFor(dn.store).check(item);
      return checked ? send(200, publicItem(checked)) : send(404, { error: "not found" });
    },
  },
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/move$/, example: "/api/items/1/move", access: "write",
    handler: async ({ req, m, send, json, app: { dn, env } }) => {
      const { folder } = await json<{ folder?: string }>();
      try {
        return dn.store.moveItem(Number(m[1]), String(folder ?? ""), actorOf(req, env, dn.store))
          ? send(200, publicItem(dn.store.get(Number(m[1]))!))
          : send(404, { error: "not found" });
      } catch (err) {
        if (err instanceof FolderError) return send(400, { error: err.message });
        throw err;
      }
    },
  },
  {
    method: "PUT", pattern: /^\/api\/items\/(\d+)\/note$/, example: "/api/items/1/note", access: "write",
    handler: async ({ req, m, send, json, app: { dn, env } }) => {
      const { note } = await json<{ note?: string }>();
      const id = Number(m[1]);
      return dn.store.setNote(id, String(note ?? ""), actorOf(req, env, dn.store)) ? send(200, publicItem(dn.store.get(id)!)) : send(404, { error: "not found" });
    },
  },
  // The tag list is replaced as a whole ([] clears it).
  {
    method: "PUT", pattern: /^\/api\/items\/(\d+)\/tags$/, example: "/api/items/1/tags", access: "write",
    handler: async ({ req, m, send, json, app: { dn, env } }) => {
      const { tags } = await json<{ tags?: unknown }>();
      if (!Array.isArray(tags)) throw new BadRequest("tags must be an array of strings");
      try {
        const item = dn.store.setTags(Number(m[1]), tags as string[], actorOf(req, env, dn.store));
        return item ? send(200, publicItem(item)) : send(404, { error: "not found" });
      } catch (err) {
        if (err instanceof ItemError) return send(422, { error: err.message });
        throw err;
      }
    },
  },
  // Delete a card for good: only from the trash, and its history goes with it.
  {
    method: "DELETE", pattern: /^\/api\/items\/(\d+)$/, example: "/api/items/1", access: "write",
    handler: ({ m, send, app: { dn } }) => {
      try {
        return dn.store.purgeItem(Number(m[1])) ? send(200, { ok: true }) : send(404, { error: "not found" });
      } catch (err) {
        if (err instanceof ItemError) return send(409, { error: err.message });
        throw err;
      }
    },
  },
  // Empty the trash: every trashed card, in one transaction.
  {
    method: "DELETE", pattern: "/api/trash", access: "write",
    handler: ({ send, app: { dn } }) => send(200, { ok: true, removed: dn.store.purgeTrash() }),
  },
  // What this card looked like before each of its last 20 changes (same read rule as the card), and putting one back.
  {
    method: "GET", pattern: /^\/api\/items\/(\d+)\/history$/, example: "/api/items/1/history", access: "read",
    handler: ({ req, m, send, app: { dn, env } }) => {
      const id = Number(m[1]);
      if (!dn.store.get(id)) return send(404, { error: "not found" });
      // The reader's private note is for admins only; a read key sees what else changed.
      const admin = isAdmin(req, env, dn.store);
      return send(200, dn.store.history(id).map((h) => {
        if (admin || !("note" in h.before)) return h;
        const { note: _note, ...before } = h.before;
        return { ...h, before };
      }));
    },
  },
  {
    method: "DELETE", pattern: /^\/api\/items\/(\d+)\/history$/, example: "/api/items/1/history", access: "write",
    handler: ({ m, send, app: { dn } }) => {
      const id = Number(m[1]);
      return dn.store.get(id) ? send(200, { ok: true, removed: dn.store.forgetHistory(id) }) : send(404, { error: "not found" });
    },
  },
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/history\/(\d+)\/restore$/, example: "/api/items/1/history/1/restore", access: "write",
    handler: ({ req, m, send, app: { dn, env } }) => {
      try {
        return send(200, publicItem(dn.store.restoreVersion(Number(m[1]), Number(m[2]), actorOf(req, env, dn.store))));
      } catch (err) {
        if (err instanceof HistoryError) return send(err.status, { error: err.message });
        throw err;
      }
    },
  },
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/feedback$/, example: "/api/items/1/feedback", access: "write",
    handler: async ({ req, m, send, json, app: { dn, env } }) => {
      const id = Number(m[1]);
      if (!dn.store.get(id)) return send(404, { error: "not found" });
      const body = await json<{ vote?: unknown; reason?: unknown }>();
      if (body.vote !== "up" && body.vote !== "down") throw new BadRequest('vote must be "up" or "down"');
      const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined;
      dn.store.vote(id, body.vote === "up" ? 1 : -1, actorOf(req, env, dn.store) ?? "admin", reason);
      return send(200, { ok: true });
    },
  },
  // Library actions from the web page: trash / restore / favorite / unfavorite.
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/(trash|restore|favorite|unfavorite)$/, example: "/api/items/1/trash", access: "write",
    handler: ({ req, m, send, app: { dn, env } }) => {
      const id = Number(m[1]);
      const action = m[2];
      const actor = actorOf(req, env, dn.store);
      const ok =
        action === "trash" || action === "restore"
          ? dn.store.setTrashed(id, action === "trash", actor)
          : dn.store.setFavorite(id, action === "favorite", actor);
      return ok ? send(200, publicItem(dn.store.get(id)!)) : send(404, { error: "not found" });
    },
  },
  {
    method: "POST", pattern: "/api/ingest", access: "write",
    handler: async ({ send, json, app: { dn } }) => {
      const body = await json<{
        text?: string; url?: string; note?: string; chat?: string; platform?: string; page?: PageContent;
      }>();
      const ctx = {
        platform: /^[a-z0-9-]{1,32}$/.test(body.platform ?? "") ? body.platform! : "http",
        chatId: String(body.chat ?? "api").slice(0, 64),
      };
      // A single URL with what the browser saw on it (the Chrome extension).
      const url = body.page && body.url ? canonicalize(body.url) : null;
      if (url) {
        const page: PageContent = {
          ...(typeof body.page!.title === "string" ? { title: body.page!.title.slice(0, 300) } : {}),
          ...(typeof body.page!.text === "string" ? { text: body.page!.text.slice(0, 20_000) } : {}),
          ...(Array.isArray(body.page!.links) ? { links: body.page!.links.filter((l) => typeof l === "string").slice(0, 50) } : {}),
        };
        const note = body.note?.slice(0, 1000);
        try {
          return send(200, [pubResult(await dn.pipeline.ingest(url, { ...ctx, ...(note ? { note } : {}) }, 0, page))]);
        } catch (err) {
          if (err instanceof BlockedUrl) return send(422, { error: err.message });
          throw err;
        }
      }
      const text = [body.url, body.text, body.note].filter(Boolean).join(" ");
      return send(200, (await dn.pipeline.ingestMessage(text, ctx)).map(pubResult));
    },
  },
  // The agent queue. Always needs the password: taking work leases items.
  {
    method: "POST", pattern: "/api/pending", access: "write", denied: NEEDS_PASSWORD,
    handler: async ({ req, send, json, app: { dn, env } }) => {
      if (!token(env)) return send(401, { error: NEEDS_PASSWORD });
      const body = await json<{ limit?: number; agent?: string }>();
      const agent = `agent:${String(body.agent ?? "http").slice(0, 40)}`;
      const items = dn.store.claimPending(agent, Number(body.limit ?? 5), 30, actorOf(req, env, dn.store));
      return send(200, {
        pending: dn.store.pendingCount(),
        brief: agentBrief(dn, items.length),
        language: env.DRIFTNET_LANGUAGE || "English",
        categories: Object.keys(dn.categories),
        folders: dn.categories,
        ...(env.DRIFTNET_SUMMARY_RULES?.trim() ? { rules: env.DRIFTNET_SUMMARY_RULES.trim() } : {}),
        items: items.map((i) => leaseRow(dn, i)),
      });
    },
  },
  {
    method: "POST", pattern: /^\/api\/items\/(\d+)\/enrich$/, example: "/api/items/1/enrich", access: "write", denied: NEEDS_PASSWORD,
    handler: async ({ m, send, json, app: { dn, env } }) => {
      if (!token(env)) return send(401, { error: NEEDS_PASSWORD });
      const body = await json<Record<string, unknown>>();
      const agent = `agent:${String(body.agent ?? "http").slice(0, 40)}`;
      delete body.agent;
      const r = await dn.pipeline.enrich(Number(m[1]), body, agent);
      return r.ok ? send(200, pubResult(r.result)) : send(422, { error: r.error });
    },
  },
];
