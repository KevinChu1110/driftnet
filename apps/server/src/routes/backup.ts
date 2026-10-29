import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { same, token } from "../access.ts";
import { BackupError, RESTORE_MAX_BYTES, TooBig, buildBackup, dbPathOf, removeDir, settingKeys, stageRestore, workDir } from "../backup.ts";
import { currentVersion } from "../update.ts";
import type { Route } from "../route.ts";

/** Same-origin only: the page's own request, never another website's (a restore replaces everything). */
const sameOrigin = (headers: Record<string, string | string[] | undefined>) => {
  const origin = headers.origin;
  const host = headers.host ?? "";
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
};

let restoring = false;

/**
 * Backup and restore. Both are "password": the admin password itself (or this machine with no
 * password set), never a read key or an agent token, because a backup is the whole catalogue
 * (and, on request, its secrets) and a restore replaces it.
 */
export const routes: Route[] = [
  {
    method: "GET", pattern: "/api/backup", access: "password",
    noPasswordHint: "set an admin password to download a backup remotely",
    handler: async ({ req, res, url, send, app: { env, settings } }) => {
      const secrets = url.searchParams.get("secrets") === "1";
      // Secrets come out only when the password is given a second time, in its own header (never in the URL).
      if (secrets && !same(req.headers["x-driftnet-confirm"] as string | undefined, token(env))) {
        return send(403, { error: token(env) ? "to include passwords and keys, send the admin password again in the X-Driftnet-Confirm header" : "set an admin password before including passwords and keys in a backup" });
      }
      let built;
      try {
        built = await buildBackup({ dbPath: dbPathOf(env), envFile: settings.file, version: currentVersion(env), secrets });
      } catch (err) {
        if (err instanceof BackupError) return send(400, { error: err.message });
        throw err;
      }
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="driftnet-backup-${day}.zip"`,
        "cache-control": "no-store",
        "x-driftnet-backup-secrets": secrets ? "included" : "removed",
        "x-content-type-options": "nosniff",
      });
      res.on("close", built.cleanup);
      try {
        await pipeline(Readable.from(built.stream()), res);
      } catch {
        res.destroy();
      } finally {
        built.cleanup();
      }
    },
  },
  {
    method: "POST", pattern: "/api/backup/restore", access: "password",
    noPasswordHint: "set an admin password to restore a backup remotely",
    handler: async ({ req, send, app: { env } }) => {
      // application/zip is not a "simple" content type, so a page on another site can't send it without a preflight this server never grants.
      if (!sameOrigin(req.headers) || !/^application\/zip\b/.test(req.headers["content-type"] ?? "")) return send(403, { error: token(env) ? "unauthorized" : "send the zip from this page or with Content-Type: application/zip" });
      const declared = Number(req.headers["content-length"] ?? 0);
      if (declared > RESTORE_MAX_BYTES) return send(413, { error: `backup is larger than ${RESTORE_MAX_BYTES / 1024 / 1024} MB` });
      if (restoring) return send(409, { error: "a restore is already running" });
      const dbPath = dbPathOf(env);
      let dir: string | undefined;
      try {
        dir = workDir(dbPath, "upload"); // may throw (no space, no permission): the flag is not set yet, and always cleared below
        restoring = true;
        const file = join(dir, "upload.zip");
        let size = 0;
        await pipeline(req, async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > RESTORE_MAX_BYTES) throw new TooBig(`backup is larger than ${RESTORE_MAX_BYTES / 1024 / 1024} MB`);
            yield chunk;
          }
        }, createWriteStream(file, { mode: 0o600 }));
        const checked = await stageRestore(file, dbPath);
        return send(200, {
          ok: true,
          restartRequired: true,
          manifest: checked.manifest,
          items: checked.items,
          // Shown, never applied: a settings file could point the model at another URL or load a plugin.
          settings: checked.settings,
          settingKeys: settingKeys(checked.settings),
        });
      } catch (err) {
        if (err instanceof BackupError) return send(err instanceof TooBig ? 413 : 400, { error: err.message });
        throw err;
      } finally {
        restoring = false;
        if (dir) removeDir(dir);
      }
    },
  },
];
