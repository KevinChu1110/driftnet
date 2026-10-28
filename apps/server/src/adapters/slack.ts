import { createHmac, timingSafeEqual } from "node:crypto";
import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

/**
 * Slack Events API webhook: POST /webhooks/slack.
 * Needs SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN (scopes: channels:history,
 * groups:history, chat:write); subscribe to message.channels / message.groups.
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

/** A message event from either transport: reply in a thread, ignore bots, edits and broadcasts. */
export function onSlackEvent(dn: Driftnet, ev: any, botToken: string): void {
  if (ev?.type !== "message" || ev.subtype || ev.bot_id || !ev.text) return;
  // Slack wraps links as <https://x|label>; unwrap before extracting.
  const text = String(ev.text).replace(/<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/g, "$1");
  handleChatText(dn, text, { platform: "slack", chatId: ev.channel, userId: ev.user })
    .then(async (reply) => {
      if (!reply) return;
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: ev.channel, thread_ts: ev.ts, text: reply, unfurl_links: false }),
      });
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
        await fetch("https://slack.com/api/apps.connections.open", {
          method: "POST",
          headers: { authorization: `Bearer ${appToken}` },
        })
      ).json()) as { ok: boolean; url?: string; error?: string };
      if (!res.ok || !res.url) throw new Error(res.error ?? "no socket URL");
      ws = new WebSocket(res.url);
      ws.onmessage = (msg) => {
        const envelope = JSON.parse(String(msg.data)) as { type: string; envelope_id?: string; payload?: any };
        // Acknowledge first: Slack redelivers anything not acked within 3 s.
        if (envelope.envelope_id) ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
        if (envelope.type === "events_api") onSlackEvent(dn, envelope.payload?.event, botToken);
        if (envelope.type === "disconnect") ws?.close();
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
