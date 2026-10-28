# driftnet

**Drop links into your group chat. Get them sorted, explained and searchable — for a fraction of a cent each.**

You see a great AI tool on Threads, Facebook, X or YouTube. You paste it into a chat "to look at
later". Three weeks and two hundred links later, it's a graveyard.

driftnet is a bot for LINE, Slack, Discord and Telegram that reads every link you drop, follows it
to the actual tool, sorts it onto a shelf, writes a two-line explanation, and puts it on a
searchable page. Your agents (Claude Code, pi, Hermes, OpenClaw, ChatGPT, Grok…) can read the same
catalogue over MCP to find tools that make *them* better.

[繁體中文說明](README.zh-TW.md)

Illustrative reply:

```
you  ▸ https://www.facebook.com/share/v/1Erc2aumUF/
bot  ▸ 📌 ascii-sharks｜design-frontend
       An ASCII-art ocean that runs at 60 FPS in plain Canvas, zero dependencies
       • Pure TypeScript, no 3D engine
       https://github.com/stackedlol/ascii-sharks
       #5 · reply 👍5 / 👎5
```

## Why it's cheap

Most "AI bookmark" tools send every page to a big model. driftnet spends as little as possible at
each step, and most links never reach the expensive one:

| Step | What happens | Cost |
|---|---|---|
| 1. Cache | Same link (after stripping `utm_`, `fbclid`, `si`… and unifying `youtu.be`, share links, repo sub-paths) | **$0** |
| 2. Extract | GitHub API + README head, YouTube description, `og:` tags. Clipped to a fixed budget (~2k chars) | $0 |
| 3. Guard | Strip hidden Unicode, flag prompt injection | $0 |
| 4. Reputation | Publishers the community keeps voting down are stored but not summarised | $0 |
| 5. Judge | [Jev](https://console.typesafe.ai) answers category / kind / worth / injection as typed choices, ~100 ms | **~$0.00006** |
| 6. Summarise | One structured call to the model **you** choose, only for items worth reading | a small model is plenty |

Measured on five real Facebook reels: judging all five cost **$0.00029**. One that was nothing but
a one-line caption was judged `skip` and would never have been summarised.

No Jev key? The summariser classifies in the same call. No model at all? Items are still
extracted, deduplicated and listed.

## Follows links to the actual tool

Social posts are usually *about* a tool, not the tool:

- A post that links a GitHub repo → driftnet catalogues the **repo** and keeps the post as context.
- A post that only *names* open-source projects ("link in comments") → driftnet looks them up on
  GitHub by name (exact-name match only) and catalogues each one.
- A weekly-roundup post → one item for the roundup, plus one per open-source project it mentions.

## Learns what to ignore

- 👎 a result in chat (`👎12 ad`), on the web, or from an agent. Votes roll up into a reputation
  per publisher (GitHub owner, YouTube channel, domain).
- Publishers below 25% approval (≥ 3 votes) are no longer summarised — junk gets cheaper over time.
- Items flagged for prompt injection are kept for humans but **never served to agents**.

## For agents

| Client | How |
|---|---|
| Claude Code / Claude Desktop / pi / Hermes / OpenClaw / any MCP client | `POST /mcp` (Streamable HTTP) or `pnpm --filter @driftnet/server mcp` (stdio) |
| Agents with skills | Copy [`skills/driftnet`](skills/driftnet/SKILL.md) into your skills folder |
| ChatGPT custom GPT Actions | Import `GET /openapi.json` |
| Anything that can fetch a URL | `GET /llms.txt` |

MCP tools: `driftnet_search`, `driftnet_recent`, `driftnet_save`, `driftnet_feedback`. The skill
tells agents to *propose* upgrades to their human, never to install anything by themselves.

```bash
# Claude Code
claude mcp add --transport http driftnet http://localhost:8787/mcp \
  --header "Authorization: Bearer $DRIFTNET_TOKEN" --header "X-Driftnet-Agent: claude-code"
```

## Quick start

```bash
git clone https://github.com/KevinChu1110/driftnet && cd driftnet
pnpm install
cp .env.example .env   # pick a model provider (optional) and the chat platforms you use
pnpm dev               # http://localhost:8787
```

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).

### Bring any model

driftnet is not tied to a vendor. Summaries go through one small interface (`LlmProvider`: fill
in a JSON schema), with two adapters built in:

| `DRIFTNET_LLM_PROVIDER` | Covers |
|---|---|
| `anthropic` | Claude, via the official SDK |
| `openai` | Anything OpenAI-compatible: OpenAI, Gemini, Grok, DeepSeek, OpenRouter, LiteLLM, **Ollama / LM Studio (fully local)** |
| *(empty)* | No model: links are still extracted, judged by Jev if configured, deduplicated and listed |

Every provider uses the same three variables: `DRIFTNET_LLM_MODEL`, `DRIFTNET_LLM_API_KEY`,
`DRIFTNET_LLM_BASE_URL`. driftnet never reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`: exporting
those changes how other tools on your machine bill you (Claude Code, for example, switches from
your subscription to API billing). Replies are validated against the schema whatever the
provider, so a model that ignores structured output cannot store malformed data.

## Where your data goes

> [!IMPORTANT]
> "Self-hosted" describes storage. The database lives on your server, but to judge and summarise
> a link driftnet sends a **digest** of it (title, a clipped excerpt, the chat note it was shared
> with) to **TypeSafe** (Jev, if `TYPESAFE_API_KEY` is set) and to **your chosen model provider**,
> under their API terms. Chat messages without a link are never processed or stored. Point the
> `openai` provider at Ollama and turn Jev off (`DRIFTNET_JUDGE=off`) to keep everything on your
> own machine.

## Layout

```
packages/core     pipeline, extractors, judge (Jev), summariser + model adapters, guard, store (SQLite)
apps/server       HTTP API, web page, MCP, chat adapters
skills/driftnet   Agent Skill for any skills-capable agent
```

Add an extractor (say, a logged-in browser for Facebook photo posts) with `registerExtractor()`.
Add a chat platform by calling `handleChatText()` from `apps/server/src/adapters/handle.ts`.

## Roadmap — good first contributions

Found by running driftnet on real shared links:

- [ ] **Video transcripts.** Many reels say the tool's name only out loud (captions, Whisper).
- [ ] **Login-walled posts.** Facebook photo posts and some Threads posts return nothing
      anonymously: a pluggable logged-in fetcher, or OCR on the post image.
- [ ] **Links in comments.** "Link in the first comment" is everywhere.
- [ ] **Rich replies.** LINE Flex, Slack Block Kit, Discord embeds, reaction-based voting.
- [ ] **Weekly digest** posted back to the chat.
- [ ] **More judges and model adapters.** `Judge` takes any typed classifier; `LlmProvider`
      takes any model that can fill a JSON schema (Gemini native, Bedrock, Vertex…).

## License

MIT
