import type { Route } from "../route.ts";

/** Free-standing notes. A feature owns its routes like this and app.ts concatenates them. */
export const routes: Route[] = [
  {
    method: "GET", pattern: "/api/notes", access: "read",
    handler: ({ send, url, app }) => send(200, app.dn.store.listNotes(url.searchParams.get("q") ?? undefined)),
  },
  {
    method: "NON_GET", pattern: /^\/api\/notes(?:\/(\d+))?$/, example: "/api/notes", access: "write",
    handler: async ({ req, m, send, json, app: { dn } }) => {
      const id = m[1] ? Number(m[1]) : undefined;
      if (req.method === "DELETE" && id) return dn.store.deleteNote(id) ? send(200, { ok: true }) : send(404, { error: "not found" });
      if ((req.method === "POST" && !id) || (req.method === "PUT" && id)) {
        const body = await json<{ title?: string; body?: string }>();
        const note = dn.store.saveNote({ ...(id ? { id } : {}), title: String(body.title ?? ""), body: String(body.body ?? "") });
        return note ? send(200, note) : send(404, { error: "not found" });
      }
      return send(405, { error: "method not allowed" });
    },
  },
];
