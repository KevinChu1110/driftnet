import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftnet, type Driftnet } from "@driftnet/core";
import { createApp } from "../src/app.ts";
import { ChatManager, type Report, type Starters } from "../src/chats.ts";
import { Settings, SettingsError } from "../src/settings.ts";

const TG = "123456789:AAH-fake_fake_fake_fake_fake_fake_fake";
const TG2 = "987654321:AAH-other_other_other_other_other_other";
const DISCORD = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.fake_fake_fake_fake_fake_fake_fake";
const LINE_SECRET = "0123456789abcdef0123456789abcdef";
const LINE_TOKEN = "A".repeat(120) + "=";

/** Fake adapters: they record what ran and hand the test their report callback. Nothing touches the network. */
function fakes() {
  const log: string[] = [];
  const reports: Record<string, Report> = {};
  const make = (name: string) => (_dn: Driftnet, ...args: unknown[]) => {
    const report = args.at(-1) as Report;
    const id = `${name}:${String(args[0]).slice(0, 3)}`;
    log.push(`start ${id}`);
    reports[name] = report;
    return () => log.push(`stop ${id}`);
  };
  const starters: Starters = { telegram: make("telegram"), discord: make("discord"), slack: make("slack") };
  return { log, reports, starters };
}

const dn = {} as Driftnet;

function settingsAt(env: NodeJS.ProcessEnv = {}, locked: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "driftnet-chats-"));
  Object.assign(env, { DRIFTNET_HOME: home });
  return { env, settings: new Settings(env, new Set(locked)) };
}

test("settings: chat tokens are accepted, write-only, and refused when they don't look like one", () => {
  const { env, settings } = settingsAt();
  settings.update({
    TELEGRAM_BOT_TOKEN: TG, DRIFTNET_TELEGRAM_CHATS: "-1001234567890, 42", DISCORD_BOT_TOKEN: DISCORD, DISCORD_CHANNELS: "123456789012345678",
    SLACK_APP_TOKEN: "xapp-1-A0-123-abcdef", SLACK_BOT_TOKEN: "xoxb-123-456-abcdef", LINE_CHANNEL_SECRET: LINE_SECRET, LINE_CHANNEL_ACCESS_TOKEN: LINE_TOKEN,
  });
  assert.equal(env.TELEGRAM_BOT_TOKEN, TG);
  const view = settings.view();
  const row = view.settings.find((s) => s.key === "TELEGRAM_BOT_TOKEN")!;
  assert.equal(row.group, "chats");
  assert.equal(row.secret, true);
  assert.equal("value" in row, false);
  for (const secret of [TG, DISCORD, LINE_SECRET, LINE_TOKEN, "xoxb-123-456-abcdef"]) assert.ok(!JSON.stringify(view).includes(secret));
  for (const bad of [
    { TELEGRAM_BOT_TOKEN: "hello" }, { TELEGRAM_BOT_TOKEN: "Bot " + TG }, { DISCORD_BOT_TOKEN: "client-secret-abc" },
    { SLACK_APP_TOKEN: "xoxb-123-456-abcdef" }, { SLACK_BOT_TOKEN: "xapp-1-A0-123-abcdef" }, { SLACK_SIGNING_SECRET: "nope" },
    { LINE_CHANNEL_SECRET: "short" }, { LINE_CHANNEL_ACCESS_TOKEN: "x" }, { DRIFTNET_TELEGRAM_CHATS: "my group" }, { DISCORD_CHANNELS: "general" },
  ]) {
    assert.throws(() => settings.update(bad), SettingsError, JSON.stringify(bad));
  }
  // The refusal never repeats the value.
  assert.throws(() => settings.update({ TELEGRAM_BOT_TOKEN: "secret-but-wrong" }), (e: Error) => !e.message.includes("secret-but-wrong"));
  settings.update({ TELEGRAM_BOT_TOKEN: null });
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
});

test("settings: a chat token set by the environment stays read-only", () => {
  const { settings } = settingsAt({ DISCORD_BOT_TOKEN: DISCORD }, ["DISCORD_BOT_TOKEN"]);
  assert.equal(settings.view().settings.find((s) => s.key === "DISCORD_BOT_TOKEN")!.locked, true);
  assert.throws(() => settings.update({ DISCORD_BOT_TOKEN: null }), /environment/);
});

test("manager: starts a bot, restarts it when its keys change, and stops it when cleared", () => {
  const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: TG };
  const { log, reports, starters } = fakes();
  const m = new ChatManager(dn, env, starters);
  assert.deepEqual(m.sync(), ["telegram"]);
  assert.deepEqual(log, ["start telegram:123"]);
  assert.equal(m.status().telegram.state, "starting");
  reports.telegram!("connected", "@drift_bot");
  assert.deepEqual(m.status().telegram, { state: "connected", name: "@drift_bot" });

  assert.deepEqual(m.sync(), [], "nothing changed: nothing restarts");
  env.DISCORD_BOT_TOKEN = DISCORD; // another platform: telegram is left alone
  m.sync();
  assert.deepEqual(log, ["start telegram:123", "start discord:MTI"]);

  const old = reports.telegram!;
  env.TELEGRAM_BOT_TOKEN = TG2;
  assert.deepEqual(m.sync(), ["telegram"]);
  assert.deepEqual(log.slice(2), ["stop telegram:123", "start telegram:987"]);
  old("connected", "@old_bot"); // the replaced adapter can't overwrite the new one's status
  assert.equal(m.status().telegram.state, "starting");

  env.DRIFTNET_TELEGRAM_CHATS = "42"; // read at start, so it restarts too
  m.sync();
  assert.deepEqual(log.slice(4), ["stop telegram:987", "start telegram:987"]);

  delete env.TELEGRAM_BOT_TOKEN;
  assert.deepEqual(m.sync(), ["telegram"]);
  assert.deepEqual(log.slice(6), ["stop telegram:987"]);
  assert.deepEqual(m.status().telegram, { state: "off" });

  m.stopAll();
  assert.equal(log.at(-1), "stop discord:MTI");
});

test("manager: errors are shown without the token; webhook platforms and half-filled ones get a status", () => {
  const env: NodeJS.ProcessEnv = { TELEGRAM_BOT_TOKEN: TG, LINE_CHANNEL_SECRET: LINE_SECRET, SLACK_APP_TOKEN: "xapp-1-A0-123-abcdef" };
  const { log, reports, starters } = fakes();
  const m = new ChatManager(dn, env, starters);
  m.sync();
  reports.telegram!("error", `request to https://api.telegram.org/bot${TG}/getMe failed`);
  const s = m.status();
  assert.equal(s.telegram.state, "error");
  assert.ok(!s.telegram.error!.includes(TG));
  assert.deepEqual(s.line, { state: "error", error: "also needs LINE_CHANNEL_ACCESS_TOKEN" });
  assert.deepEqual(s.slack, { state: "error", error: "also needs SLACK_BOT_TOKEN" });
  assert.equal(s.discord.state, "off");

  env.LINE_CHANNEL_ACCESS_TOKEN = LINE_TOKEN;
  env.SLACK_BOT_TOKEN = "xoxb-123-456-abcdef";
  m.sync();
  assert.equal(m.status().line.state, "webhook");
  assert.equal(m.status().slack.state, "starting", "app + bot token: socket mode");
  assert.ok(log.includes("start slack:xap"));

  // A starter that throws is an error, not a crash.
  const broken = new ChatManager(dn, { DISCORD_BOT_TOKEN: DISCORD }, { ...starters, discord: () => { throw new Error("boom"); } });
  broken.sync();
  assert.deepEqual(broken.status().discord, { state: "error", error: "boom" });
});

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test("PUT /api/settings restarts the changed bot at once; GET shows the status, never the token", async () => {
  const PASSWORD = "chats-test-password-1A!";
  const env: NodeJS.ProcessEnv = { DRIFTNET_HOME: mkdtempSync(join(tmpdir(), "driftnet-chats-")), DRIFTNET_JUDGE: "off", DRIFTNET_TOKEN: PASSWORD };
  const realDn = createDriftnet(env);
  const { log, starters } = fakes();
  const chats = new ChatManager(realDn, env, starters);
  chats.sync();
  const server = createApp({ dn: realDn, env, chats, port: 0 });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${PASSWORD}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.9" };
  const put = (values: Record<string, unknown>) => fetch(`${base}/api/settings`, { method: "PUT", headers, body: JSON.stringify({ values }) });

  let res = await put({ TELEGRAM_BOT_TOKEN: TG });
  assert.equal(res.status, 200);
  let body = await res.json() as { chats: Record<string, { state: string }> };
  assert.equal(body.chats.telegram!.state, "starting");
  assert.deepEqual(log, ["start telegram:123"]);
  assert.ok(!JSON.stringify(body).includes(TG));

  res = await put({ TELEGRAM_BOT_TOKEN: "not a token" });
  assert.equal(res.status, 400);
  assert.deepEqual(log, ["start telegram:123"], "a refused value changes nothing");

  res = await put({ TELEGRAM_BOT_TOKEN: null });
  assert.equal(res.status, 200);
  assert.deepEqual(log, ["start telegram:123", "stop telegram:123"]);

  body = await (await fetch(`${base}/api/settings`, { headers })).json() as typeof body;
  assert.equal(body.chats.telegram!.state, "off");
  // Without the password the status is not readable either.
  assert.equal((await fetch(`${base}/api/settings`, { headers: { "x-forwarded-for": "203.0.113.10" } })).status, 403);
});
