import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { driftnetHome } from "@driftnet/core";
import { BackupError, RESTORE_MAX_BYTES, applyPendingRestore, settingKeys, stageRestore, writeBackupFile } from "../backup.ts";
import { currentVersion } from "../update.ts";
import { parseArgs, UsageError } from "./args.ts";
import { call, errorOf, resolveConnection, ServerDown } from "./client.ts";
import type { Ctx } from "./commands.ts";

/** The database file the way the CLI finds it (no folder is created, unlike the server's own lookup). */
const dbFileOf = (env: NodeJS.ProcessEnv) => env.DRIFTNET_DB ?? join(driftnetHome(env), "driftnet.db");

/**
 * `driftnet backup [-o file] [--secrets]`: asks a running server (admin password), or, with
 * none running, reads the database file directly with the same VACUUM INTO snapshot.
 */
export async function backupCmd(ctx: Ctx, argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, { value: ["output"], bool: ["secrets"], short: { o: "output" } });
  if (positional.length) throw new UsageError("usage: driftnet backup [-o file] [--secrets]");
  const c = resolveConnection(flags, ctx.env);
  const secrets = !!flags.secrets;
  const out = typeof flags.output === "string" ? flags.output : `driftnet-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  let reply;
  try {
    if (secrets && !c.token) {
      // Only matters when a server answers; checked first so the message is about the password, not a refusal.
      await call(c, ctx.fetch, "GET", "/api/ui", { timeoutMs: 2000 });
      throw new UsageError("--secrets needs the admin password again: pass --token (or set DRIFTNET_TOKEN)");
    }
    reply = await call(c, ctx.fetch, "GET", `/api/backup${secrets ? "?secrets=1" : ""}`, {
      timeoutMs: 600_000, ...(secrets ? { headers: { "X-Driftnet-Confirm": c.token! } } : {}),
    });
  } catch (e) {
    if (!(e instanceof ServerDown)) throw e;
    ctx.err("(server not running; read the database directly)");
    try {
      const m = await writeBackupFile({ dbPath: dbFileOf(c.env), envFile: join(driftnetHome(c.env), ".env"), version: currentVersion(c.env), secrets }, out);
      ctx.out(`wrote ${out}: ${m.items} items, schema ${m.schema}, ${secrets ? "WITH passwords and keys" : "passwords and keys removed"}`);
      return 0;
    } catch (err) {
      if (!(err instanceof BackupError)) throw err;
      ctx.err(`driftnet: ${err.message}`);
      return 1;
    }
  }
  if (reply.status !== 200) { ctx.err(`driftnet: ${errorOf(reply)}`); return 1; }
  writeFileSync(out, reply.bytes, { mode: 0o600 });
  ctx.out(`wrote ${out} (${reply.bytes.length} bytes, ${secrets ? "WITH passwords and keys" : "passwords and keys removed"})`);
  return 0;
}

/**
 * `driftnet restore <file>`: only while no server runs (the swap replaces the database file).
 * The old database is kept as `<db>.before-restore-<time>`. The backup's settings are listed, not applied.
 */
export async function restoreCmd(ctx: Ctx, argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv, { bool: ["print-settings"] });
  if (positional.length !== 1) throw new UsageError("usage: driftnet restore <backup.zip> [--print-settings]");
  const file = positional[0]!;
  const c = resolveConnection(flags, ctx.env);
  try {
    await call(c, ctx.fetch, "GET", "/api/ui", { timeoutMs: 2000 });
    ctx.err(`driftnet: a server is running at ${c.url}. Stop it first (or use the page's Settings > Backup > Restore, then restart).`);
    return 1;
  } catch (e) {
    if (!(e instanceof ServerDown)) throw e;
  }
  if (!existsSync(file) || !statSync(file).isFile()) { ctx.err(`driftnet: cannot read ${file}`); return 1; }
  if (statSync(file).size > RESTORE_MAX_BYTES) { ctx.err(`driftnet: that file is larger than ${RESTORE_MAX_BYTES / 1024 / 1024} MB`); return 1; }
  const dbPath = dbFileOf(c.env);
  try {
    const checked = await stageRestore(file, dbPath);
    const done = applyPendingRestore(dbPath, () => {});
    ctx.out(`restored ${checked.items} items (schema ${checked.schema}, made by driftnet ${checked.manifest.driftnet})`);
    if (done?.before) ctx.out(`your previous database is kept as ${done.before}`);
    const keys = settingKeys(checked.settings);
    if (keys.length) {
      ctx.out(`the backup also holds ${keys.length} settings; they are NOT applied (${keys.join(", ")}). Add the ones you want to ${join(driftnetHome(c.env), ".env")}${flags["print-settings"] ? "" : "; --print-settings shows them"}.`);
      if (flags["print-settings"]) ctx.out(checked.settings.trimEnd());
    }
    return 0;
  } catch (err) {
    if (!(err instanceof BackupError)) throw err;
    ctx.err(`driftnet: ${err.message}`);
    return 1;
  }
}
