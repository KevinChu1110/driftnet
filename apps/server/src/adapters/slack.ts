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

  const ev = payload.event;
  // Ignore bots (including ourselves), edits and thread broadcasts.
  if (payload.type === "event_callback" && ev?.type === "message" && !ev.subtype && !ev.bot_id && ev.text) {
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
  // Ack within 3 s or Slack retries.
  return { status: 200 };
}
