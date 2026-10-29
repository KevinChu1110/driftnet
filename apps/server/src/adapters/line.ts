import { createHmac, timingSafeEqual } from "node:crypto";
import { messages, type Driftnet } from "@driftnet/core";
import { handleChat, type ChatReply } from "./handle.ts";
import { voteOnItem } from "./reactions.ts";
import { lineFlex, warnOnce } from "./rich.ts";

const replyApi = async (accessToken: string, replyToken: string, messages: unknown[]): Promise<Response> =>
  fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ replyToken, messages }),
  });

/** Reply with a Flex bubble / carousel when the reply has one; if LINE rejects it (the token is not used up), send the plain text. */
export async function sendLineReply(accessToken: string, replyToken: string, reply: ChatReply): Promise<void> {
  const text = { type: "text", text: reply.text.slice(0, 5000) };
  if (reply.rich?.items.length) {
    const res = await replyApi(accessToken, replyToken, [lineFlex(reply.rich, reply.text)]).catch(() => undefined);
    if (res?.ok) return void (await res.body?.cancel());
    warnOnce("line", `answered ${res?.status ?? "no response"}`);
    await res?.body?.cancel();
  }
  await replyApi(accessToken, replyToken, [text]);
}

/** A 👍 / 👎 postback button (`v=<id>&d=up|down`). Returns the text to answer with, or null when it isn't ours. */
export function onLinePostback(dn: Driftnet, ev: any): string | null {
  const p = new URLSearchParams(String(ev?.postback?.data ?? ""));
  const id = Number(p.get("v"));
  const dir = p.get("d");
  const user = ev?.source?.userId;
  if (!Number.isInteger(id) || id < 1 || (dir !== "up" && dir !== "down") || !user) return null;
  const t = messages();
  if (!voteOnItem(dn, id, `line:${user}`, dir === "up" ? 1 : -1)) return t.noItem(id);
  return dir === "up" ? t.votedUp(id) : t.votedDown(id);
}

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
    if (ev.type === "postback" && ev.replyToken) {
      Promise.resolve()
        .then(async () => {
          const answer = onLinePostback(dn, ev);
          if (answer) await replyApi(accessToken, ev.replyToken, [{ type: "text", text: answer }]);
        })
        .catch((err) => console.warn("[line]", (err as Error).message));
      continue;
    }
    if (ev.type !== "message" || ev.message?.type !== "text") continue;
    const src = ev.source ?? {};
    // Reply tokens expire in ~1 minute; summarising takes a few seconds, which is fine.
    Promise.resolve()
      .then(() =>
        handleChat(dn, ev.message.text, {
          platform: "line",
          chatId: src.groupId ?? src.roomId ?? src.userId ?? "",
          userId: src.userId,
        }),
      )
      .then(async (reply) => {
        if (!reply) return;
        await sendLineReply(accessToken, ev.replyToken, reply);
      })
      .catch((err) => console.warn("[line]", (err as Error).message));
  }
  return 200;
}

/** Push a message to a user, group or room id (a scheduled digest; there is no reply token). Throws on refusal. */
export async function pushLineMessage(accessToken: string, to: string, text: string): Promise<void> {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`LINE answered ${res.status}`);
  await res.body?.cancel();
}
