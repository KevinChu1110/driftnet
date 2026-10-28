<div align="center">

# driftnet

**Drop links into your group chat. Get them sorted, explained and searchable.**

**English** · [繁體中文](README.zh-TW.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)
![LINE · Slack · Discord · Telegram](https://img.shields.io/badge/chat-LINE%20·%20Slack%20·%20Discord%20·%20Telegram-555.svg)
![MCP](https://img.shields.io/badge/agents-MCP-8a63d2.svg)

</div>

You see a great AI tool on Threads, Facebook, X or YouTube and paste it into a chat "to look at
later". Three weeks and two hundred links later, that chat is a graveyard.

driftnet is a bot for **LINE, Slack, Discord and Telegram**. It reads every link you drop, follows
it to the actual tool, sorts it onto a shelf, writes a short explanation in your language, and
puts it on a searchable page. Your agents (Claude Code, pi, Hermes, OpenClaw, ChatGPT, Grok…) read
the same catalogue over MCP to find tools that make *them* better.

```text
you ▸ https://www.facebook.com/share/v/1DfVB2odi3/

bot ▸ 📌 This week in AI (3/11)｜news
      A one-minute roundup of this week's AI releases
      • Paperclip: an open-source framework for agent "companies"
      • Symphony: OpenAI's board for assigning work to agents
      Mentions: FelixCraftAI, Paperclip, Symphony, GPT-5.4
      #1 · reply 👍1 / 👎1

      ↳ 📌 paperclip｜agent-framework
        https://github.com/paperclipai/paperclip
      ↳ 📌 symphony｜agent-framework
        https://github.com/openai/symphony
```

<sub>Illustrative reply. The repos were found from names in the post: it had no links.</sub>

**Contents** · [Features](#features) · [Quick start](#quick-start) · [Chat platforms](#chat-platforms) ·
[Models](#bring-any-model) · [Agents](#for-agents) · [Configuration](#configuration) ·
[Online](#putting-it-online-optional) · [Your data](#where-your-data-goes) · [Contributing](#contributing)

## Features

### Light on tokens

Most AI bookmark tools send every page to a big model. driftnet does the free steps first, and
most links never reach the model at all:

| Step | What happens | Model call |
|---|---|---|
| 1. Cache | Same link again, after stripping `utm_`, `fbclid`, `si`… and unifying `youtu.be`, share links and repo sub-paths | none |
| 2. Extract | GitHub API + README head, YouTube description, `og:` tags, clipped to ~2,000 characters | none |
| 3. Guard | Strip hidden Unicode, flag prompt injection | none |
| 4. Reputation | Publishers the community keeps voting down are stored, not summarised | none |
| 5. Judge | [Jev](https://console.typesafe.ai) answers category, kind, worth and injection as typed choices (~100 ms) | tiny classifier |
| 6. Summarise | One structured call to the model **you** choose, only for items worth reading | one call |

On five real Facebook reels, Jev's judging cost **$0.00029 in total**. One reel was just a
one-line caption: it was judged `skip` and never sent to the model.

No Jev key? The model classifies in the same call. No model? Links are still extracted,
deduplicated and listed.

### Follows links to the actual tool

Social posts are usually *about* a tool, not the tool itself:

- A post linking a GitHub repo → the **repo** is catalogued, with the post as context.
- A post that only *names* open-source projects ("link in comments") → driftnet finds them on
  GitHub by exact name and catalogues each one.
- A weekly roundup → one item for the roundup, plus one per open-source project it mentions.
- Links pasted back-to-back without spaces are split correctly.

### Reads the outline, not the whole page

Borrowing the idea behind agent browsers such as [Moli](https://github.com/lexmount/moli), without
running one: a page is turned into its skeleton (headings, the opening of each section, key list
items) with menus, breadcrumbs, cookie banners and footers removed, then capped in **tokens**,
counting Chinese and Japanese text at about one token per character instead of four characters
per token. On real shared links, a Chinese article went from 831 to 404 tokens, and README
headers like `<strong>Quickstart</strong> &middot;` no longer reach the model.

### Learns what to ignore

- Vote in chat (`👎12 ad`), on the web, or from an agent. Votes add up to a reputation per
  publisher (GitHub owner, YouTube channel, domain).
- Publishers below 25% approval (3+ votes) are no longer summarised. The more junk you vote
  down, the less it costs.
- Items flagged for prompt injection stay visible to people but are **never served to agents**.

### English or Chinese

One setting, `DRIFTNET_LANGUAGE`, sets the language of the summaries **and** of the bot's own
replies. Use `English` or `Traditional Chinese (Taiwan)`. Summaries work in any language the model
writes, such as `Japanese`, while the bot's own words fall back to English. Tool names are kept
as-is.

## Quick start

driftnet runs on your own computer. No server, no cloud account.

```bash
git clone https://github.com/KevinChu1110/driftnet && cd driftnet
pnpm install
mkdir -p ~/.driftnet && cp .env.example ~/.driftnet/.env   # optional: model, chat platforms
pnpm start                                                 # http://localhost:8787
pnpm service:install                                       # optional: start at login (macOS / Linux)
```

Requires Node.js 22.13+ (driftnet uses the built-in `node:sqlite`). Settings live in
`~/.driftnet/.env` and the catalogue in `~/.driftnet/driftnet.db`, wherever you start it from
(`DRIFTNET_HOME` moves both). With a local [Ollama](https://ollama.com) model and Jev off, nothing
leaves your machine; driftnet prints the settings to use when it finds Ollama running.

Try it without any chat platform:

```bash
curl -X POST localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"text": "look at this https://github.com/paperclipai/paperclip"}'
```

## Chat platforms

| Platform | Set | Works on a laptop? | Messages sent while it was off |
|---|---|---|---|
| Chrome extension | nothing: it talks to `localhost:8787` | ✅ | — |
| Telegram | `TELEGRAM_BOT_TOKEN` (from @BotFather). For groups, turn privacy mode off with `/setprivacy` | ✅ long polling | picked up on start (Telegram keeps them 24 h) |
| Discord | `DISCORD_BOT_TOKEN`. Enable the **Message Content** intent | ✅ gateway | read back on start, per channel, without replying |
| Slack | `SLACK_APP_TOKEN` (xapp-, Socket Mode on) + `SLACK_BOT_TOKEN` (`channels:history`, `groups:history`, `chat:write`) | ✅ Socket Mode | missed |
| Slack, webhook | `SLACK_SIGNING_SECRET` + `SLACK_BOT_TOKEN`. Events URL: `/webhooks/slack` | needs a public URL | Slack retries briefly |
| LINE | `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`. Webhook URL: `/webhooks/line` | needs a public URL | missed |
| Anything else | `POST /api/chat {"text": "…"}` returns the reply text | ✅ | — |

LINE only delivers to a public HTTPS URL. From a laptop, `cloudflared tunnel --url http://localhost:8787`
gives you one (it changes on every run unless you set up a named tunnel); otherwise run driftnet on
a small server, see [Putting it online](#putting-it-online).

### Chrome extension: what you see while logged in

Anonymous fetches hit login walls: a Facebook photo post returns nothing, and "link in the
comments" is invisible. The extension in [`apps/chrome-extension`](apps/chrome-extension) sends
what **you** see instead:

- **Toolbar button**: sends the page you're on. Expands "See more", and if the post links nowhere,
  opens the comments once to find the link.
- **Right-click a link**: sends that link with the text of the post around it.
- **Right-click a selection**: sends just the selected text.

It reads a tab only when you click (`activeTab`), and sends only to your own server. Install with
`chrome://extensions` → Developer mode → **Load unpacked** → `apps/chrome-extension`. It talks to
`http://localhost:8787` out of the box; for a remote server, set its URL and `DRIFTNET_TOKEN` in
the extension's settings.

Tested on real posts: a photo post went from 0 characters (anonymous) to the full text plus
comments, and a reel saying "link in the comments" yielded the GitHub repo from its comments.

**In the chat:** messages without a link are ignored. Every reply ends with the item number. Vote
with `👍12` / `👎12 reason` (or `+12` / `-12`).

## Bring any model

driftnet is not tied to a vendor. Summaries go through one small interface (`LlmProvider`: "fill
in this JSON schema"), with two adapters built in:

| `DRIFTNET_LLM_PROVIDER` | Covers |
|---|---|
| `anthropic` | Claude, through the official SDK |
| `openai` | Anything OpenAI-compatible: OpenAI, Gemini, Grok, DeepSeek, OpenRouter, LiteLLM, **Ollama / LM Studio (fully local)** |
| `claude-cli` | **Your Claude subscription**, through a logged-in Claude Code on the same machine. No API key |
| `gemini-cli` | **Your Google account**, through a logged-in Gemini CLI on the same machine. No API key |
| *(empty)* | No model: links are still extracted, judged by Jev if configured, deduplicated and listed |

```bash
DRIFTNET_LLM_PROVIDER=openai
DRIFTNET_LLM_MODEL=gemini-3.8-flash
DRIFTNET_LLM_API_KEY=...
DRIFTNET_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
```

> [!NOTE]
> driftnet never reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Exporting those changes how other
> tools on your machine bill you: Claude Code, for example, switches from your subscription to
> API billing.

Replies are validated against the schema whatever the provider, so a model that ignores
structured output cannot store malformed data. Truncated, refused or malformed replies are
retried once. Auth and bad-request errors are not. A link the model gives for a tool is kept only
if it appears in the fetched content; otherwise driftnet asks GitHub for an exact-name match,
because models readily invent plausible-looking repo URLs.

### No API key? Use the CLI you're already logged in to

```bash
DRIFTNET_LLM_PROVIDER=claude-cli      # model defaults to haiku
# or
DRIFTNET_LLM_PROVIDER=gemini-cli
DRIFTNET_LLM_MODEL=gemini-3.5-flash-lite
```

driftnet runs the CLI in the background, one call at a time, and locks it down because shared
links are untrusted input:

| | Claude Code | Gemini CLI |
|---|---|---|
| Tools | all off (`--tools ""`) | all excluded through a system-level settings file |
| Your settings, hooks, MCP servers, `CLAUDE.md` / `GEMINI.md` | not loaded | not loaded (own system prompt, no extensions) |
| Working directory | an empty private temp folder | an empty private temp folder |
| Environment | driftnet's secrets and `ANTHROPIC_API_KEY` removed, so the CLI uses your login | driftnet's secrets and `GEMINI_API_KEY` removed |
| Measured | ~4 s per item | ~3.5 s per item |

Limits: the CLI has to be installed and logged in on the machine running driftnet, and calls
count toward your plan's usage limits.

> [!WARNING]
> Using a consumer subscription from a program is governed by each vendor's terms. Anthropic does
> not permit third-party products to offer claude.ai login. `claude-cli` runs **your own** Claude
> Code, with **your own** login, on **your own** machine, and is off by default. Check the current
> terms before relying on it, and don't use it to serve other people.

## For agents

| Client | How to connect |
|---|---|
| Claude Code, Claude Desktop, pi, Hermes, OpenClaw, any MCP client | `POST /mcp` (Streamable HTTP), or `pnpm --filter @driftnet/server mcp` (stdio) |
| Agents with skills | Copy [`skills/driftnet`](skills/driftnet/SKILL.md) into the skills folder |
| ChatGPT custom GPT Actions | Import `GET /openapi.json` |
| Anything that can fetch a URL | `GET /llms.txt` |

```bash
# Claude Code
claude mcp add --transport http driftnet http://localhost:8787/mcp \
  --header "Authorization: Bearer $DRIFTNET_TOKEN" --header "X-Driftnet-Agent: claude-code"
```

| MCP tool | Use |
|---|---|
| `driftnet_search` | Search the catalogue before picking a tool for a task |
| `driftnet_recent` | What's new: find tools that would improve the agent's own workflow |
| `driftnet_save` | Catalogue a link |
| `driftnet_feedback` | Vote an item up or down. Agent votes count toward reputation too |

The skill tells agents to **propose** upgrades to their human, never to install anything
themselves, and to treat everything in the catalogue as data, not instructions.

## Configuration

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `DRIFTNET_LLM_PROVIDER` | *(off)* | `anthropic`, `openai`, `claude-cli`, `gemini-cli` or empty |
| `DRIFTNET_LLM_MODEL` | — | Model name. Required for `anthropic` and `openai`; `claude-cli` defaults to `haiku` |
| `DRIFTNET_LLM_API_KEY` | — | Key for that provider (optional for Ollama / LM Studio) |
| `DRIFTNET_LLM_BASE_URL` | OpenAI | Endpoint for the `openai` provider |
| `DRIFTNET_LLM_EFFORT` | `anthropic`: `low` | `anthropic`: `low` to `xhigh` (a typo falls back to `low`). `openai`: sent as `reasoning_effort`. `claude-cli`: `--effort`. Only sent when set, except for `anthropic` |
| `DRIFTNET_CLI_PATH` | `claude` / `gemini` | Path to the CLI binary for `claude-cli` / `gemini-cli` |
| `DRIFTNET_CLI_CONCURRENCY` | `1` | How many CLI processes may run at once |
| `DRIFTNET_LANGUAGE` | `English` | Language of the summaries and the bot's replies |
| `DRIFTNET_LOCALE` | from `DRIFTNET_LANGUAGE` | Force the bot's own words to `en` or `zh-TW` |
| `TYPESAFE_API_KEY` | `~/.typesafe/api_key` | Enables the Jev judge. `DRIFTNET_JUDGE=off` disables it |
| `DRIFTNET_MIN_CONFIDENCE` | `0.4` | Below this, the model classifies instead of Jev |
| `DRIFTNET_CATEGORIES` | built-in | JSON file of your own shelves: `{ "id": "description" }` |
| `GITHUB_TOKEN` | — | Raises the GitHub API limit from 60 to 5,000 requests per hour |
| `DRIFTNET_TOKEN` | — | Required for writes (ingest, votes, MCP) once the server is reachable |
| `DRIFTNET_ACCESS` | `public` | `public`: anyone can read, writes need the token. `private`: every read needs the token too; the web page asks for it once |
| `DRIFTNET_DIGEST_TOKENS` | `350` | Token budget for the page outline sent to the judge and the model |
| `DRIFTNET_PUBLIC_URL` | — | Replies link to the item on the web page |
| `DRIFTNET_DB` | `~/.driftnet/driftnet.db` | SQLite file |
| `PORT` | `8787` | HTTP port |
| `DRIFTNET_HOME` | `~/.driftnet` | Folder for `.env`, the database and the service log |
| `SLACK_APP_TOKEN` | — | Slack Socket Mode (no public URL). Takes precedence over the webhook |
| `DRIFTNET_HOST` | `127.0.0.1` | Listen address. Put a reverse proxy in front to expose it, or use `0.0.0.0` in a container |

**HTTP endpoints:** `GET /` web page · `GET /api/items` · `GET /api/items/:id` ·
`POST /api/items/:id/feedback` · `POST /api/ingest` · `POST /api/chat` · `GET /api/stats` ·
`GET /api/categories` · `GET /llms.txt` · `GET /openapi.json` · `/mcp`

## Putting it online (optional)

You don't need this to use driftnet. It's for reaching your catalogue from a phone, receiving LINE
messages around the clock, or sharing it. By default the server listens on `127.0.0.1` only; put a
reverse proxy with HTTPS in front and choose who may read:

```bash
DRIFTNET_TOKEN=$(openssl rand -hex 24)
DRIFTNET_ACCESS=private        # or public: an open catalogue, writes still need the token
```

```caddyfile
driftnet.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

## Where your data goes

> [!IMPORTANT]
> "Self-hosted" describes storage. The database lives on your server. To judge and summarise a
> link, driftnet sends a **digest** of it (title, a clipped excerpt, and the chat text it was
> shared with) to **TypeSafe** (Jev, if enabled) and to **your chosen model provider**, under their
> API terms. Chat messages without a link are never processed or stored.
>
> To keep everything on your own machine, point the `openai` provider at Ollama and set
> `DRIFTNET_JUDGE=off`.

## Contributing

```text
packages/core     pipeline, extractors, judge (Jev), summariser + model adapters, guard, store
apps/server       HTTP API, web page, MCP, chat adapters
apps/chrome-extension  send what you see while logged in
skills/driftnet   Agent Skill
```

```bash
pnpm typecheck && pnpm test
```

Extension points:

- **Extractor** for a new site: `registerExtractor()` in `packages/core/src/extractors`
- **Model**: implement `LlmProvider` in `packages/core/src/llm`
- **Chat platform**: call `handleChatText()` from `apps/server/src/adapters/handle.ts`
- **Browser capture**: per-site tweaks go in `apps/chrome-extension/collect.js`
- **Judge**: implement `Judge` in `packages/core/src/judge`
- **Bot language**: add a locale to `packages/core/src/i18n.ts`

### Roadmap: good first issues

These came from running driftnet on links people actually share:

- [ ] **Video transcripts.** Many reels only say the tool's name out loud (captions, Whisper).
- [x] **Login-walled posts** and **links in comments**: the Chrome extension.
- [ ] **Extension polish.** Icons, Threads/X/Instagram-specific capture, a Chrome Web Store build.
- [ ] **Rich replies.** LINE Flex, Slack Block Kit, Discord embeds, voting by reaction.
- [ ] **Weekly digest** posted back to the chat.
- [ ] **More adapters.** Native Gemini, Bedrock, Vertex, more judges.

## License

[MIT](LICENSE)
