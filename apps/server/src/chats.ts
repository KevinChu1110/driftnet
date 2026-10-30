import type { Driftnet } from "@driftnet/core";
import { startDiscord } from "./adapters/discord.ts";
import { startSlackSocket } from "./adapters/slack.ts";
import { startTelegram } from "./adapters/telegram.ts";

export type ChatPlatform = "telegram" | "discord" | "slack" | "line";
export const CHAT_PLATFORMS: readonly ChatPlatform[] = ["telegram", "discord", "slack", "line"];

/**
 * off: no token. starting: dialling out. connected: the platform answered (name: the bot's).
 * webhook: nothing to dial, messages arrive at /webhooks/<platform>. error: the last thing that went wrong.
 */
export interface ChatStatus {
  state: "off" | "starting" | "connected" | "webhook" | "error";
  error?: string;
  name?: string;
}

/** What an adapter calls to say how it is doing. */
export type Report = (state: "connected" | "error", detail?: string) => void;

/** How each dialling adapter starts; tests pass fakes so nothing touches the network. */
export interface Starters {
  telegram: (dn: Driftnet, token: string, report: Report) => () => void;
  discord: (dn: Driftnet, token: string, report: Report) => () => void;
  slack: (dn: Driftnet, appToken: string, botToken: string, report: Report) => () => void;
}

export const realStarters: Starters = { telegram: startTelegram, discord: startDiscord, slack: startSlackSocket };

/** The settings each platform reads at start; a change to any of them restarts it. */
export const CHAT_KEYS: Record<ChatPlatform, readonly string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN", "DRIFTNET_TELEGRAM_CHATS"],
  discord: ["DISCORD_BOT_TOKEN"],
  slack: ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  line: ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN"],
};

interface Running { sig: string; stop?: () => void; status: ChatStatus }

/**
 * Starts, stops and restarts the chat bots from the current settings, so a token
 * pasted in ⚙ Settings works without restarting driftnet. LINE and Slack's
 * webhook mode read their keys per request; they only get a status here.
 */
export class ChatManager {
  private running = new Map<ChatPlatform, Running>();

  constructor(private readonly dn: Driftnet, private readonly env: NodeJS.ProcessEnv, private readonly starters: Starters = realStarters) {}

  /** Bring every platform in line with the settings. Returns the platforms that were (re)started or stopped. */
  sync(): ChatPlatform[] {
    const touched: ChatPlatform[] = [];
    for (const p of CHAT_PLATFORMS) {
      const sig = JSON.stringify(CHAT_KEYS[p].map((k) => this.env[k] ?? ""));
      const old = this.running.get(p);
      if (old?.sig === sig) continue;
      if (old?.stop) this.stopQuietly(p, old.stop);
      const cur: Running = { sig, status: { state: "off" } };
      this.running.set(p, cur);
      try {
        this.start(p, cur);
      } catch (err) {
        cur.status = { state: "error", error: this.clean((err as Error).message) };
      }
      if (old || cur.status.state !== "off") touched.push(p);
    }
    return touched;
  }

  status(): Record<ChatPlatform, ChatStatus> {
    return Object.fromEntries(CHAT_PLATFORMS.map((p) => [p, { ...(this.running.get(p)?.status ?? { state: "off" }) }])) as Record<ChatPlatform, ChatStatus>;
  }

  stopAll(): void {
    for (const [p, r] of this.running) if (r.stop) this.stopQuietly(p, r.stop);
    this.running.clear();
  }

  private start(p: ChatPlatform, cur: Running): void {
    const e = this.env;
    // Reports from an adapter that was replaced since are dropped.
    const report: Report = (state, detail) => {
      if (this.running.get(p) !== cur) return;
      cur.status = state === "connected" ? { state, ...(detail ? { name: detail } : {}) } : { state, error: this.clean(detail ?? "failed") };
    };
    const dial = (stop: () => void) => { cur.status = { state: "starting" }; cur.stop = stop; };
    const missing = (...keys: string[]) => { cur.status = { state: "error", error: `also needs ${keys.join(" and ")}` }; };
    if (p === "telegram" && e.TELEGRAM_BOT_TOKEN) dial(this.starters.telegram(this.dn, e.TELEGRAM_BOT_TOKEN, report));
    if (p === "discord" && e.DISCORD_BOT_TOKEN) dial(this.starters.discord(this.dn, e.DISCORD_BOT_TOKEN, report));
    if (p === "slack") {
      if (e.SLACK_APP_TOKEN && e.SLACK_BOT_TOKEN) dial(this.starters.slack(this.dn, e.SLACK_APP_TOKEN, e.SLACK_BOT_TOKEN, report));
      else if (e.SLACK_SIGNING_SECRET && e.SLACK_BOT_TOKEN) cur.status = { state: "webhook" };
      else if (e.SLACK_APP_TOKEN || e.SLACK_SIGNING_SECRET) missing("SLACK_BOT_TOKEN");
      else if (e.SLACK_BOT_TOKEN) missing("SLACK_APP_TOKEN");
    }
    if (p === "line") {
      if (e.LINE_CHANNEL_SECRET && e.LINE_CHANNEL_ACCESS_TOKEN) cur.status = { state: "webhook" };
      else if (e.LINE_CHANNEL_SECRET) missing("LINE_CHANNEL_ACCESS_TOKEN");
      else if (e.LINE_CHANNEL_ACCESS_TOKEN) missing("LINE_CHANNEL_SECRET");
    }
    if (cur.stop) console.log(`[chats] ${p} starting`);
  }

  private stopQuietly(p: ChatPlatform, stop: () => void): void {
    try { stop(); } catch (err) { console.warn(`[chats] stopping ${p}:`, (err as Error).message); }
    console.log(`[chats] ${p} stopped`);
  }

  /** An error the page shows: one line, and never a token, even if a library put one in the message. */
  private clean(msg: string): string {
    let out = msg.replace(/\s+/g, " ").trim().slice(0, 300);
    for (const k of Object.values(CHAT_KEYS).flat().filter((x) => /TOKEN|SECRET/.test(x))) {
      const v = this.env[k];
      if (v && v.length >= 8) out = out.split(v).join("…");
    }
    return out;
  }
}
