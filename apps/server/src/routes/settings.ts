import type { IncomingMessage } from "node:http";
import { createProvider } from "@driftnet/core";
import { isLocal, isPrivate, newKey, readKey, strength, token } from "../access.ts";
import { SettingsError } from "../settings.ts";
import { pairRoute } from "../pair.ts";
import { tokenRoute } from "../tokens.ts";
import { dbPathOf, restorePending } from "../backup.ts";
import type { App, Route } from "../route.ts";

const SETTINGS_HINT = "settings can only be changed from this machine; set an admin password to change them remotely";

/** What the settings page needs to show the access panel and the "Connect an AI" cards. */
function accessView(req: IncomingMessage, { env, tunnel }: App) {
  return {
    access: {
      local: isLocal(req),
      private: isPrivate(env),
      passwordSet: !!token(env),
      readKey: readKey(env) ?? null,
      publicUrl: env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL || null,
      tunnel: { available: tunnel.available(), running: tunnel.running, url: tunnel.url, error: tunnel.error },
    },
  };
}

/**
 * The settings page can point the model at another URL with your key, so these
 * routes are "password" (the dispatcher refuses anyone else) and on top of that
 * need a same-origin request with a JSON body. The JSON content type forces a
 * CORS preflight, which this server never grants.
 */
const shapeDenied = (app: App, hint?: string) => ({ error: token(app.env) ? "unauthorized" : hint ?? "unauthorized" });

export const routes: Route[] = [
  {
    method: ["GET", "PUT"], pattern: "/api/settings", access: "password", noPasswordHint: SETTINGS_HINT,
    handler: async ({ req, send, json, app }) => {
      const { env, dn, settings, tunnel, plugins } = app;
      if (!app.settingsShape(req)) return send(403, shapeDenied(app, SETTINGS_HINT));
      if (req.method === "PUT") {
        try {
          const values = (await json<{ values?: Record<string, unknown> }>()).values ?? {};
          // Private needs a password to exist afterwards, or nobody could read anything.
          const nextToken = "DRIFTNET_TOKEN" in values ? values.DRIFTNET_TOKEN : token(env);
          const nextAccess = "DRIFTNET_ACCESS" in values ? values.DRIFTNET_ACCESS : env.DRIFTNET_ACCESS;
          if (nextAccess === "private" && !nextToken) throw new SettingsError("private access needs an admin password");
          if (values.DRIFTNET_TOKEN === null && tunnel.running) throw new SettingsError("turn the public URL off before removing the password");
          if (typeof values.DRIFTNET_TOKEN === "string" && values.DRIFTNET_TOKEN.trim() && tunnel.running && strength(values.DRIFTNET_TOKEN.trim()) === "weak") {
            throw new SettingsError("while the public URL is open, the password must not be weak");
          }
          // A half-filled model (no model name, no key) would stop driftnet from starting next time: refuse it now.
          const changed = settings.update(values, (next) => {
            try { createProvider(next); } catch (err) { throw new SettingsError(`model: ${(err as Error).message}`); }
          });
          if (changed.length) {
            dn.reconfigure(env);
            app.chats?.sync(); // restarts only the bots whose keys changed
          }
          return send(200, { ...settings.view(), changed, engines: dn.engines, chats: app.chats?.status() ?? null });
        } catch (err) {
          if (err instanceof SettingsError) return send(400, { error: err.message });
          throw err;
        }
      }
      return send(200, { ...settings.view(), engines: dn.engines, chats: app.chats?.status() ?? null, plugins, restorePending: restorePending(dbPathOf(env)), ...accessView(req, app) });
    },
  },
  // Agent tokens: one named key per agent. Admin password only, never a token itself (tokenRoute adds the per-method rules).
  {
    method: "*", pattern: /^\/api\/agent-tokens(?:\/([^/]+))?$/, example: "/api/agent-tokens", access: "password",
    noPasswordHint: "set an admin password to manage agent tokens remotely",
    handler: async ({ req, m, send, json, app: { dn, env } }) => {
      const id = m[1] ? decodeURIComponent(m[1]) : null;
      const body = req.method === "POST" && !id ? await json<unknown>() : undefined;
      const r = tokenRoute(dn.store, env, req, id, body);
      return send(r.status, r.body);
    },
  },
  // Unlock a phone, step 1: the password makes a one-time code.
  {
    method: "*", pattern: "/api/pair", access: "password", noPasswordHint: "set an admin password to pair a device remotely",
    handler: async ({ req, send, json, app: { dn, env } }) => {
      const body = req.method === "POST" ? await json<unknown>() : undefined;
      const r = pairRoute(dn.store, env, req, "create", body);
      return send(r.status, r.body);
    },
  },
  // Step 2: the phone swaps the code for its own token. The code is the credential and carries no header, so a wrong guess is counted by hand.
  {
    method: "*", pattern: "/api/pair/claim", access: "public",
    handler: async ({ req, send, json, app }) => {
      if (app.throttled(req)) return send(429, { error: "too many wrong codes; try again in 15 minutes" });
      const body = req.method === "POST" ? await json<unknown>() : undefined;
      const r = pairRoute(app.dn.store, app.env, req, "claim", body);
      if (r.status === 404) app.miss(req);
      return send(r.status, r.body);
    },
  },
  // A fresh read-only key; the old one stops working at once.
  {
    method: "POST", pattern: "/api/read-key", access: "password",
    handler: ({ req, send, app }) => {
      if (!app.settingsShape(req)) return send(403, shapeDenied(app));
      try {
        app.settings.update({ DRIFTNET_READ_KEY: newKey() });
        return send(200, { ...app.settings.view(), ...accessView(req, app) });
      } catch (err) {
        if (err instanceof SettingsError) return send(400, { error: err.message });
        throw err;
      }
    },
  },
  // The public URL: a Cloudflare quick tunnel, only with a password, and the catalogue goes private.
  {
    method: "POST", pattern: "/api/tunnel", access: "password",
    handler: async ({ req, send, json, app }) => {
      const { env, tunnel, settings } = app;
      if (!app.settingsShape(req)) return send(403, shapeDenied(app));
      const { on } = await json<{ on?: boolean }>();
      try {
        if (!on) {
          tunnel.stop();
          delete env.DRIFTNET_TUNNEL_URL;
        } else {
          if (!token(env)) throw new SettingsError("set an admin password first");
          if (strength(token(env)!) === "weak") throw new SettingsError("choose a stronger password before opening a public URL");
          if (!tunnel.available()) throw new SettingsError("cloudflared is not installed");
          const lock: Record<string, string> = {};
          if (!isPrivate(env)) lock.DRIFTNET_ACCESS = "private";
          if (!readKey(env)) lock.DRIFTNET_READ_KEY = newKey();
          settings.update(lock);
          env.DRIFTNET_TUNNEL_URL = await tunnel.start();
          console.log(`[tunnel] public URL: ${env.DRIFTNET_TUNNEL_URL}`);
        }
        return send(200, { ...settings.view(), ...accessView(req, app) });
      } catch (err) {
        if (err instanceof SettingsError) return send(400, { error: err.message });
        return send(502, { error: (err as Error).message });
      }
    },
  },
];
