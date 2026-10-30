[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/ways-in.md)

# Ways in

| | Set up | On a laptop? | Sent while it was off |
|---|---|---|---|
| **Chrome extension** | [Install from the Chrome Web Store](https://chromewebstore.google.com/detail/driftnet/inmlinbodfopmanbllkkjcgheelacddm) | ✅ | — |
| Telegram | `TELEGRAM_BOT_TOKEN`; privacy mode off for groups (`/setprivacy`) | ✅ | caught up on start (24 h) |
| Discord | `DISCORD_BOT_TOKEN`; Message Content intent on | ✅ | read back per channel, quietly |
| Slack | `SLACK_APP_TOKEN` (Socket Mode) + `SLACK_BOT_TOKEN` (+ `reactions:read` and the `reaction_added` event for voting) | ✅ | missed |
| LINE | `LINE_CHANNEL_SECRET` + `LINE_CHANNEL_ACCESS_TOKEN`, webhook `/webhooks/line` | needs a [public URL](online.md) | missed |
| Your agent | MCP, OpenAPI or `/llms.txt`, see [Agents](agents.md) | ✅ | — |
| Anything else | `POST /api/chat {"text": "…"}` returns the reply | ✅ | — |

**In a chat**, messages without a link are ignored. Each link gets a reply that says what it is and where to read it on the web page,
shaped for the platform (`DRIFTNET_REPLY_STYLE=rich`, the default): a Discord embed per item, Slack Block Kit, a LINE Flex card (one bubble, or a
carousel of up to 12) and a Telegram message with links. Pictures appear only when a public `DRIFTNET_PUBLIC_URL` is set (never a localhost or
private address, and never with the share key). Want the summary in the chat instead, or no reply at all? Set `DRIFTNET_REPLY=full` or `off`;
`DRIFTNET_REPLY_STYLE=text` brings back plain messages. If a platform refuses the rich message (a missing permission), driftnet sends the plain
text and logs it once.

**Vote** with `👍12` or `👎12 reason` (`+#12` / `-#12` work too; a message with a link is never a vote), or with one tap:

| | How | Needs |
|---|---|---|
| Discord | React 👍 / 👎 on the bot's reply (it adds both for you; 👍 or 👎 votes on every card in that reply) | Message Reactions intent (not privileged; discord.js asks for it); *Embed Links* and *Add Reactions* in the channel |
| Slack | React 👍 / 👎 (`+1`, `-1`) on the bot's reply | Scope `reactions:read`; event subscription `reaction_added` |
| Telegram | Tap 👍 / 👎 under a card (a toast confirms), or react to the bot's message | Nothing extra for buttons; for emoji reactions the bot must be an admin of the group |
| LINE | Tap 👍 / 👎 on the card (LINE has no reactions API) | Rich reply style |

One vote per person per card; voting again changes it. Removing a reaction does **not** take the vote back (react with the other emoji instead).
Driftnet remembers which cards a Discord, Slack or Telegram reply was about for 30 days.

**Weekly digest.** Set `DRIFTNET_DIGEST=weekly` (or `daily`) and `DRIFTNET_DIGEST_TO` (or use ⚙ Settings → General) and driftnet posts one short
message at the chosen time: how many cards are new, how many wait in the Inbox, the five best new cards (worth, then shares) and what was shared
2+ times. Nothing new, nothing sent. Times are the **server's local time** (set `TZ` to change it). If driftnet was off at the scheduled time it
sends one catch-up digest on the next start, never more. Links in it are your plain public URL (`DRIFTNET_PUBLIC_URL`), never the read-only share key,
since the text lands in a group. Try it with `POST /api/digest/send {"dryRun": true}`. A webhook also gets a `digest.sent` event.

Bot tokens are read when driftnet starts: put them in `~/.driftnet/.env`, then stop and start it again.

<p align="center"><img src="../assets/discord-zh-TW.jpg" alt="driftnet answering a Discord message with two links: one line per link, each pointing to its page" width="80%"></p>
<sub>A real run in Discord (<code>DRIFTNET_LANGUAGE=Traditional Chinese (Taiwan)</code>): two links in one message, one line back for each. Name and server address hidden.</sub>
