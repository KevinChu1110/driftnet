import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "@driftnet/core";
import { foreignOrigin, isAdmin, isLocal, isPassword, isTrustedLocal, token } from "./access.ts";

type Reply = { status: number; body: unknown };

const create = z.object({
  name: z.string({ error: "name is required" }).trim().min(1, "name is required"),
  scope: z.enum(["read", "write"], { error: "scope must be read or write" }),
});

/**
 * /api/agent-tokens. Pure over the store so it can be tested without HTTP.
 *
 *   GET    /api/agent-tokens            list (revoked ones too, for 30 days)
 *   POST   /api/agent-tokens            { name, scope } -> the only response with the token
 *   DELETE /api/agent-tokens/:id        revoke
 *   DELETE /api/agent-tokens/:id?purge=1  remove a revoked token from the list
 *
 * Admin password only, never a token itself: a leaked token must not mint
 * tokens. With no password set, only this machine may.
 */
export function tokenRoute(store: Store, env: NodeJS.ProcessEnv, req: IncomingMessage, id: string | null, body?: unknown): Reply {
  const allowed = !foreignOrigin(req) && (isAdmin(req, env, store) || isTrustedLocal(req)) && (isPassword(req, env) || isTrustedLocal(req));
  if (!allowed || (!token(env) && !isLocal(req))) return { status: 403, body: { error: token(env) ? "unauthorized" : "set an admin password to manage agent tokens remotely" } };
  const method = req.method ?? "GET";
  if (method === "GET" && !id) return { status: 200, body: store.listAgentTokens() };
  if (method === "POST" && !id) {
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) return { status: 415, body: { error: "send application/json" } };
    const parsed = create.safeParse(body ?? {});
    if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "bad request" } };
    return { status: 200, body: store.createAgentToken(parsed.data) };
  }
  if (method === "DELETE" && id) {
    if (new URL(req.url ?? "/", "http://x").searchParams.get("purge")) {
      if (store.deleteAgentToken(id)) return { status: 200, body: { ok: true } };
      const exists = store.listAgentTokens().some((t) => t.id === id);
      return exists ? { status: 409, body: { error: "revoke the token before removing it" } } : { status: 404, body: { error: "not found" } };
    }
    return store.revokeAgentToken(id) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "not found" } };
  }
  return { status: 405, body: { error: "method not allowed" } };
}
