import { spawn } from "node:child_process";
import { createDriftnet, healthFor, loadPlugins, defaultDbPath, driftnetHome, loadHomeEnv } from "@driftnet/core";
import { startSlackSocket } from "./adapters/slack.ts";
import { startTelegram } from "./adapters/telegram.ts";
import { startDiscord } from "./adapters/discord.ts";
import { isPrivate, token, Tunnel } from "./access.ts";
import { createApp } from "./app.ts";
import { startDigestScheduler } from "./digest.ts";
import { Settings } from "./settings.ts";
import { applyPendingRestore, dbPathOf } from "./backup.ts";
import { checkForUpdate } from "./update.ts";

const env = process.env;
// Settings the environment itself provides (systemd, Docker, the shell) win over the file; the page shows them read-only.
const fromEnvironment = new Set(Object.keys(env).filter((k) => env[k] !== undefined));
const envFile = loadHomeEnv(env);
const plugins = await loadPlugins(env);
// A restore staged from the page is swapped in here, before the store opens the file.
await applyPendingRestore(dbPathOf(env)); // never throws: a bad staged file is set aside and the start goes on
const dn = createDriftnet();
const settings = new Settings(env, fromEnvironment);
const PORT = Number(env.PORT ?? 8787);
// Loopback by default: put a reverse proxy (Caddy, nginx, a tunnel) in front to expose it.
const HOST = env.DRIFTNET_HOST ?? "127.0.0.1";
/**
 * public  — anyone can read the catalogue; writes need DRIFTNET_TOKEN.
 * private — every read needs the token or the read-only key (the page asks once).
 * Both are read per request (see access.ts), so ⚙ Settings can change them live.
 */
if (isPrivate(env) && !token(env)) {
  console.error("DRIFTNET_ACCESS=private needs DRIFTNET_TOKEN to be set");
  process.exit(1);
}
if (!/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(HOST) && !token(env)) {
  console.warn(
    `⚠️  DRIFTNET_HOST=${HOST} is reachable from other machines and no admin password is set: anyone who can reach port ${PORT} can read and change your catalogue.\n` +
      `   Set DRIFTNET_TOKEN=<a long password> in ${driftnetHome(env)}/.env (or in the environment), or keep DRIFTNET_HOST on 127.0.0.1.`,
  );
}
const tunnel = new Tunnel(PORT);
process.on("exit", () => { tunnel.stop(); healthFor(dn.store).stop(); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { tunnel.stop(); process.exit(0); });

const server = createApp({ dn, env, settings, tunnel, plugins, envFile, port: PORT });

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${PORT} is already in use. Is driftnet already running? Open http://localhost:${PORT}, or set PORT in ${driftnetHome(env)}/.env.`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`driftnet on http://${HOST}:${PORT}  judge=${dn.engines.judge}  summarizer=${dn.engines.summarizer}`);
  for (const w of dn.warnings) console.warn(`⚠️  ${w}`);
  console.log(`settings: ${envFile ?? `none (create ${driftnetHome(env)}/.env, or open the page's ⚙ Settings)`}  data: ${env.DRIFTNET_DB ?? defaultDbPath(env)}`);
  if (plugins.length) console.log(`plugins: ${plugins.join(", ")}`);
  void dn.semantic.configure(env).then((line) => console.log(line), (e) => console.warn(`semantic search: off (${e instanceof Error ? e.message : "error"})`));
  healthFor(dn.store).start(env); // does nothing unless DRIFTNET_HEALTH=weekly (read live)
  void suggestLocalModel();
  // At most once a day (the time of the last try is in the database), 3 s timeout, never blocks start.
  void checkForUpdate(dn.store, env).catch(() => {});
  // First run in a terminal: open the page, where ⚙ Settings walks through the rest.
  if (!env.DRIFTNET_SERVICE && process.stdout.isTTY) console.log("Tip: `npx driftnet service install` starts driftnet at login");
  if (!envFile && process.stdout.isTTY && env.DRIFTNET_OPEN !== "0" && !env.CI) openBrowser(`http://localhost:${PORT}/`);
  if (env.TELEGRAM_BOT_TOKEN) startTelegram(dn, env.TELEGRAM_BOT_TOKEN);
  if (env.DISCORD_BOT_TOKEN) startDiscord(dn, env.DISCORD_BOT_TOKEN);
  if (env.LINE_CHANNEL_SECRET) console.log("[line] webhook at /webhooks/line");
  if (env.SLACK_APP_TOKEN && env.SLACK_BOT_TOKEN) startSlackSocket(dn, env.SLACK_APP_TOKEN, env.SLACK_BOT_TOKEN);
  else if (env.SLACK_SIGNING_SECRET) console.log("[slack] webhook at /webhooks/slack");
  // Reads its settings every tick, so turning the digest on in ⚙ Settings needs no restart.
  const stopDigest = startDigestScheduler(dn, env);
  process.on("exit", stopDigest);
});

function openBrowser(url: string): void {
  const [command, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(command, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // no browser here (a server); the URL is printed above
  }
}

/** Running with no model while Ollama sits right there: say how to use it. */
async function suggestLocalModel(): Promise<void> {
  if (env.DRIFTNET_LLM_PROVIDER) return;
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1000) });
    const { models } = (await res.json()) as { models?: { name: string }[] };
    if (!models?.length) return;
    console.log(
      `tip: Ollama is running locally. To summarise without any cloud model, add to ${driftnetHome(env)}/.env:\n` +
        `  DRIFTNET_LLM_PROVIDER=openai\n  DRIFTNET_LLM_BASE_URL=http://127.0.0.1:11434/v1\n  DRIFTNET_LLM_MODEL=${models[0]!.name}`,
    );
  } catch {
    // no Ollama — nothing to suggest
  }
}
