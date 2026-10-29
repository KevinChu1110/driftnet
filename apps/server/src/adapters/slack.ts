import { createHmac, timingSafeEqual } from "node:crypto";
import type { Driftnet } from "@driftnet/core";
import { handleChat, type ChatReply } from "./handle.ts";
import { reactionVote, rememberReply, voteOnReply } from "./reactions.ts";
import { slackBlocks, slackEscape, warnOnce } from "./rich.ts";

/** Overridable for tests and Slack-compatible servers. */
const api = (method: string) => `${process.env.SLACK_API_URL ?? "https://slack.com/api"}/${method}`;

/**
 * Slack Events API webhook: POST /webhooks/slack.
 * Needs SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN (scopes: channels:history,
 * groups:history, chat:write, reactions:read); subscribe to message.channels /
 * message.groups / reaction_added.
 */
export async function handleSlack(
  dn: Driftnet,
  rawBody: string,
  headers: { timestamp?: string; signature?: string },
  signingSecret: string,
  botToken: string,
): Promise<{ status: number; body?: string }> {
  const ts = Number(headers.timestamp);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return { status: 401 };
  const expected = Buffer.from(
    "v0=" + createHmac("sha256", signingSecret).update(`v0:${ts}:${rawBody}`).digest("hex"),
  );
  const given = Buffer.from(headers.signature ?? "");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { status: 401 };

  const payload = JSON.parse(rawBody) as any;
  if (payload.type === "url_verification") return { status: 200, body: payload.challenge };

  if (payload.type === "event_callback") onSlackEvent(dn, payload.event, botToken);
  // Ack within 3 s or Slack retries.
  return { status: 200 };
}

/**
 * A reaction on one of the bot's messages: 👍 / 👎 (+1, -1, thumbsup, thumbsdown)
 * votes on its items. Needs the reactions:read scope and the reaction_added
 * event. Removing a reaction is not undone. Returns the item ids voted on.
 */
export function onSlackReaction(dn: Driftnet, ev: any): number[] {
  if (ev?.type !== "reaction_added" || ev.item?.type !== "message" || !ev.user) return [];
  if (ev.item_user && ev.item_user === ev.user) return []; // the bot reacting to its own message
  const vote = reactionVote(ev.reaction);
  if (!vote) return [];
  return voteOnReply(dn, `slack:${ev.item.channel}:${ev.item.ts}`, `slack:${ev.user}`, vote);
}

async function post(botToken: string, body: unknown): Promise<{ ok?: boolean; error?: string; ts?: string; channel?: string }> {
  const res = await fetch(api("chat.postMessage"), {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return ((await res.json().catch(() => ({}))) ?? {}) as { ok?: boolean; error?: string; ts?: string; channel?: string };
}

/** Post a reply in a thread: Block Kit when the reply has it (with a plain text fallback), plain text if Slack refuses the blocks. */
export async function sendSlackReply(dn: Driftnet, botToken: string, channel: string, threadTs: string, reply: ChatReply): Promise<void> {
  let res: Awaited<ReturnType<typeof post>> | undefined;
  if (reply.rich?.items.length) {
    res = await post(botToken, {
      channel, thread_ts: threadTs, text: slackEscape(reply.text), blocks: slackBlocks(reply.rich), unfurl_links: false, unfurl_media: false,
    }).catch((err) => ({ ok: false, error: (err as Error).message }));
    if (!res.ok) {
      warnOnce("slack", res.error ?? "request failed");
      res = undefined;
    }
  }
  res ??= await post(botToken, { channel, thread_ts: threadTs, text: reply.text, unfurl_links: false });
  if (res.ok && res.ts) rememberReply(dn.store, `slack:${res.channel ?? channel}:${res.ts}`, reply.ids);
}

/** A message event from either transport: reply in a thread, ignore bots, edits and broadcasts. */
export function onSlackEvent(dn: Driftnet, ev: any, botToken: string): Promise<void> {
  if (ev?.type === "reaction_added") {
    return Promise.resolve().then(() => void onSlackReaction(dn, ev)).catch((err) => console.warn("[slack]", (err as Error).message));
  }
  if (ev?.type !== "message" || ev.subtype || ev.bot_id || !ev.text) return Promise.resolve();
  // Slack wraps links as <https://x|label>; unwrap before extracting.
  const text = String(ev.text).replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1");
  return Promise.resolve()
    .then(() => handleChat(dn, text, { platform: "slack", chatId: ev.channel, userId: ev.user }))
    .then(async (reply) => {
      if (!reply) return;
      await sendSlackReply(dn, botToken, ev.channel, ev.ts, reply);
    })
    .catch((err) => console.warn("[slack]", (err as Error).message));
}

/**
 * Slack Socket Mode: driftnet dials out over a WebSocket, so it works on a laptop
 * with no public URL. Needs an app-level token (xapp-…, scope connections:write)
 * in SLACK_APP_TOKEN, Socket Mode enabled, and the same bot token and event
 * subscriptions as the webhook setup.
 */
export function startSlackSocket(dn: Driftnet, appToken: string, botToken: string): () => void {
  let stopped = false;
  let ws: WebSocket | undefined;

  const connect = async () => {
    if (stopped) return;
    try {
      const res = (await (
        await fetch(api("apps.connections.open"), {
          method: "POST",
          headers: { authorization: `Bearer ${appToken}` },
        })
      ).json()) as { ok: boolean; url?: string; error?: string };
      if (!res.ok || !res.url) throw new Error(res.error ?? "no socket URL");
      ws = new WebSocket(res.url);
      ws.onmessage = (msg) => {
        try {
          const envelope = JSON.parse(String(msg.data)) as { type: string; envelope_id?: string; payload?: any };
          // Acknowledge first: Slack redelivers anything not acked within 3 s.
          if (envelope.envelope_id) ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          if (envelope.type === "events_api") onSlackEvent(dn, envelope.payload?.event, botToken);
          if (envelope.type === "disconnect") ws?.close();
        } catch (err) {
          console.warn("[slack] socket message:", (err as Error).message);
        }
      };
      ws.onopen = () => console.log("[slack] socket mode connected");
      ws.onclose = () => setTimeout(() => void connect(), 2000);
    } catch (err) {
      console.warn("[slack] socket mode:", (err as Error).message);
      setTimeout(() => void connect(), 15_000);
    }
  };
  void connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}

/** Post a message to a channel (a scheduled digest); throws when Slack refuses it. */
export async function sendSlackMessage(botToken: string, channel: string, text: string): Promise<void> {
  // Slack's control characters, so a card name can't become a mention or a link.
  const safe = slackEscape(text);
  const res = await fetch(api("chat.postMessage"), {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text: safe, unfurl_links: false, unfurl_media: false }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `Slack answered ${res.status}`);
}
