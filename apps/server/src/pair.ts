import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { Store } from "@driftnet/core";
import { foreignOrigin, isAdmin, isLocal, isPassword, isTrustedLocal, token } from "./access.ts";

type Reply = { status: number; body: unknown };

const create = z.object({
  name: z.string({ error: "name is required" }).trim().min(1, "name is required"),
  scope: z.enum(["read", "write"], { error: "scope must be read or write" }),
});
const claim = z.object({ code: z.string().min(16).max(128) });
const json = (req: IncomingMessage) => /^application\/json\b/.test(req.headers["content-type"] ?? "");

/**
 * Unlock a phone with a QR code. Pure over the store so it can be tested without HTTP.
 *
 *   POST /api/pair        { name, scope } -> { code, expiresAt }. Admin password only,
 *                         like token management: a leaked token must not mint devices.
 *   POST /api/pair/claim  { code } -> { id, name, scope, token }. No credentials: the
 *                         code is the credential, good once, for five minutes. Every
 *                         failure is the same bare 404 so nothing leaks.
 */
export function pairRoute(store: Store, env: NodeJS.ProcessEnv, req: IncomingMessage, action: "create" | "claim", body?: unknown, now = Date.now()): Reply {
  if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
  if (foreignOrigin(req)) return { status: 403, body: { error: "unauthorized" } };
  if (!json(req)) return { status: 415, body: { error: "send application/json" } };
  if (action === "claim") {
    const parsed = claim.safeParse(body ?? {});
    const made = parsed.success ? store.claimPairCode(parsed.data.code, now) : null;
    return made ? { status: 200, body: made } : { status: 404, body: { error: "not found" } };
  }
  const allowed = (isAdmin(req, env, store) || isTrustedLocal(req)) && (isPassword(req, env) || isTrustedLocal(req));
  if (!allowed || (!token(env) && !isLocal(req))) return { status: 403, body: { error: token(env) ? "unauthorized" : "set an admin password to pair a device remotely" } };
  const parsed = create.safeParse(body ?? {});
  if (!parsed.success) return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "bad request" } };
  return { status: 200, body: store.createPairCode(parsed.data, now) };
}
