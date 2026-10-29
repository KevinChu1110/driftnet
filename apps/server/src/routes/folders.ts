import { applyFolderTemplate, TemplateError, FolderError, LOCALES } from "@driftnet/core";
import { applySuggested, suggestFolders } from "../plan.ts";
import type { Route } from "../route.ts";

/** The reader's folder tree. Order matters: the specific POSTs come before the catch-all. */
export const routes: Route[] = [
  {
    method: "GET", pattern: "/api/folders", access: "read",
    handler: ({ send, app: { dn } }) => send(200, dn.store.folders().map((f) => ({ ...f, label: Object.fromEntries(LOCALES.map((l) => [l, dn.folderLabel(f.id, l)])) }))),
  },
  // An AI plan to tidy the tree: proposed for review (costs a model call), applied only for what the reader ticked.
  {
    method: "POST", pattern: /^\/api\/folders\/suggest(\/apply)?$/, example: "/api/folders/suggest", access: "write",
    handler: async ({ m, send, json, app: { dn, env } }) => {
      const out = !m[1] ? await suggestFolders(dn, env.DRIFTNET_LANGUAGE || "English") : applySuggested(dn, await json<unknown>());
      return send(out.status, out.body);
    },
  },
  // First run: swap the untouched starter folders for another template. 409 once the reader has put anything in.
  {
    method: "POST", pattern: "/api/folders/template", access: "write",
    handler: async ({ send, json, app: { dn } }) => {
      try {
        return send(200, { template: applyFolderTemplate(dn.store, String((await json<{ template?: string }>()).template ?? "")) });
      } catch (err) {
        if (err instanceof TemplateError) return send(err.message.startsWith("unknown") ? 400 : 409, { error: err.message });
        throw err;
      }
    },
  },
  {
    method: "NON_GET", pattern: /^\/api\/folders(?:\/([^/]+))?$/, example: "/api/folders", access: "write",
    handler: async ({ req, m, send, json, app: { dn } }) => {
      const id = m[1] ? decodeURIComponent(m[1]) : null;
      try {
        if (req.method === "POST" && !id) {
          const body = await json<{ name?: string; description?: string; parent?: string | null }>();
          return send(200, dn.store.createFolder({ name: String(body.name ?? ""), ...(body.description ? { description: String(body.description) } : {}), parent: body.parent ?? null }));
        }
        if (req.method === "PATCH" && id) {
          const body = await json<{ name?: string; description?: string; parent?: string | null; position?: number }>();
          return send(200, dn.store.updateFolder(id, body));
        }
        if (req.method === "DELETE" && id) {
          dn.store.deleteFolder(id);
          return send(200, { ok: true });
        }
      } catch (err) {
        if (err instanceof FolderError) return send(400, { error: err.message });
        throw err;
      }
      return send(405, { error: "method not allowed" });
    },
  },
];
