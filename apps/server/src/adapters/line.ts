import { createHmac, timingSafeEqual } from "node:crypto";
import type { Driftnet } from "@driftnet/core";
import { handleChatText } from "./handle.ts";

/**
 * LINE Messaging API webhook: POST /webhooks/line.
 * Needs LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN, and a public HTTPS URL
 * (cloudflared / ngrok for local dev).
 */
export async function handleLine(
  dn: Driftnet,
  rawBody: string,
  signature: string | undefined,
  secret: string,
  accessToken: string,
): Promise<number> {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature ?? "", "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 401;

  const { events } = JSON.parse(rawBody) as { events: any[] };
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text") continue;
    const src = ev.source ?? {};
    // Reply tokens expire in ~1 minute; summarising takes a few seconds, which is fine.
    handleChatText(dn, ev.message.text, {
      platform: "line",
      chatId: src.groupId ?? src.roomId ?? src.userId ?? "",
      userId: src.userId,
    })
      .then(async (reply) => {
        if (!reply) return;
        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
          body: JSON.stringify({ replyToken: ev.replyToken, messages: [{ type: "text", text: reply.slice(0, 5000) }] }),
        });
      })
      .catch((err) => console.warn("[line]", (err as Error).message));
  }
  return 200;
}
