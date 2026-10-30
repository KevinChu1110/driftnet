[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/settings.md)

# Settings

All settings are environment variables, usually in `~/.driftnet/.env`. See
[`.env.example`](../.env.example). The common ones are also on the page under **⚙ Settings**; a variable
set by the environment itself (systemd, Docker, your shell) wins and shows there read-only.

<details>
<summary><b>All settings</b></summary>

| Variable | Default | Purpose |
|---|---|---|
| `DRIFTNET_LLM_PROVIDER` | *(off)* | `anthropic`, `openai`, `gemini`, `bedrock`, `vertex`, `claude-cli`, `gemini-cli`, a plugin's name, or empty |
| `DRIFTNET_LLM_MODEL` | — | Model name. Required for `anthropic`, `openai`, `bedrock` and `vertex`; `gemini` defaults to `gemini-flash-latest`; `claude-cli` to `haiku` |
| `DRIFTNET_LLM_API_KEY` | — | Key for that provider (none for Ollama / LM Studio; for `vertex`, an access token instead of a key file) |
| `DRIFTNET_LLM_REGION` | `us-central1` (vertex) | Region for `bedrock` (falls back to `AWS_REGION`) and `vertex` |
| `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` · `AWS_SESSION_TOKEN` | — | `bedrock` credentials |
| `AWS_BEARER_TOKEN_BEDROCK` | — | `bedrock` with a Bedrock API key instead of the three above |
| `GOOGLE_APPLICATION_CREDENTIALS` · `DRIFTNET_VERTEX_CREDENTIALS` | — | `vertex`: service-account key file (or its JSON text in the second) |
| `GOOGLE_CLOUD_PROJECT` | from the key file | `vertex` project |
| `GEMINI_API_KEY` | — | `gemini` key when `DRIFTNET_LLM_API_KEY` is empty |
| `DRIFTNET_LLM_BASE_URL` | OpenAI | Endpoint for the `openai` provider |
| `DRIFTNET_LLM_EFFORT` | `anthropic`: `low` | `anthropic`: `low`–`xhigh`; `openai`: `reasoning_effort`; `claude-cli`: `--effort` |
| `DRIFTNET_CLI_PATH` | `claude` / `gemini` | CLI binary for `claude-cli` / `gemini-cli` |
| `DRIFTNET_CLI_CONCURRENCY` | `1` | CLI processes at once |
| `DRIFTNET_LANGUAGE` | `English` | Language of summaries and bot replies |
| `DRIFTNET_SUMMARY_DEPTH` | `standard` | How much each card says: `brief`, `standard` or `detailed` |
| `DRIFTNET_LOCALE` | from `DRIFTNET_LANGUAGE` | Force the bot's own words to `en` or `zh-TW` |
| `DRIFTNET_REPLY` | `link` | Chat replies: `link` (one line + web link), `full` (the summary in chat) or `off` |
| `DRIFTNET_REPLY_STYLE` | `rich` | `rich` (embeds, Block Kit, Flex cards, vote buttons) or `text` (plain messages) |
| `TYPESAFE_API_KEY` | `~/.typesafe/api_key` | Enables the Jev judge; `DRIFTNET_JUDGE=off` disables it |
| `DRIFTNET_JUDGE` | Jev if keyed | `jev`, `rules`, `llm`, `heuristic`, `off` or a plugin's judge ([Judges](models.md#judges)) |
| `DRIFTNET_JUDGE_RULES` | — | Rules file for the `rules` judge |
| `DRIFTNET_MIN_CONFIDENCE` | `0.4` | Below this, the model classifies instead of Jev |
| `DRIFTNET_DIGEST_TOKENS` | `350` | Token budget of the page outline |
| `DRIFTNET_FOLDERS` | `ai` | Starting folder template on a new database: `ai` (AI & coding), `research` (papers, articles, datasets…) or `everyday` (cooking, travel, money…). An empty catalogue also offers the choice on the page |
| `DRIFTNET_DIGEST` | `off` | Scheduled digest into your chats: `off`, `daily` or `weekly` ([Weekly digest](ways-in.md)) |
| `DRIFTNET_DIGEST_AT` | `09:00` | Time of day, `HH:MM`, in the server's local time (the `TZ` variable is respected) |
| `DRIFTNET_DIGEST_DAY` | `mon` | Day of the week for `weekly`: `mon`…`sun` |
| `DRIFTNET_DIGEST_TO` | — | Where it goes, comma separated: `telegram:<chat id>`, `discord:<channel id>`, `slack:<channel id>`, `line:<user, group or room id>`; uses the bot tokens already set |
| `DRIFTNET_WEBHOOK_URL` | — | POST each card change here as JSON (`item.added` / `item.updated` / `item.trashed` / `item.restored`, plus `digest.sent`), 5 s timeout, one retry after 1 s, redirects not followed |
| `DRIFTNET_WEBHOOK_SECRET` | — | Signs each delivery: `X-Driftnet-Signature: sha256=<hmac of "<X-Driftnet-Timestamp>.<body>">`. Reject old timestamps to stop replays; `X-Driftnet-Delivery` stays the same on the retry |
| `DRIFTNET_WEBHOOK_ALLOW_LOCAL` | — | `1` allows a webhook on a private address (n8n on your LAN), for that exact host only |
| `DRIFTNET_CATEGORIES` | built-in | JSON file of starting folders, `{ "id": "description" }`, used once on a new database; after that, edit folders on the page |
| `GITHUB_TOKEN` | — | GitHub API limit from 60 to 5,000 requests per hour |
| `DRIFTNET_SUMMARY_RULES` | — | Your own instructions for every summary, e.g. “Say whether it is free.” Agents get them too |
| `DRIFTNET_PROFILE` | — | Who you are and what you care about, 600 characters at most (⚙ Settings › AI › About you). The model uses it to judge what is worth your time and to write each card's “why” line; agents get it too. It sits once in the model's system prompt (about 150 tokens, so prompt caching still hits) and is never copied into cards |
| `DRIFTNET_UPDATE_CHECK` | off | If `1`, once a day driftnet asks `registry.npmjs.org` for the latest version number and shows a small “driftnet x.y.z is out” notice in the page header (and in `driftnet status`). Nothing about you is sent. Off unless you set `1` |
| `DRIFTNET_BLOCK_DOMAINS` | — | Domains never catalogued (subdomains included), comma separated |
| `DRIFTNET_HEALTH` | `off` | `weekly` re-checks links about once a week and marks dead, archived and stale cards (see Link health). Off by default: it makes network requests |
| `DRIFTNET_VIDEO` | `auto` | `auto` uses whichever of `yt-dlp`, `ffmpeg`, `tesseract` and `whisper` are installed; `captions` only reads captions and descriptions (light on battery); `watch` is `auto`, then, if the item is still thin, lets Gemini or Vertex watch the video (sends the video or its YouTube link to that model); `off` never reads videos (see Reels and shorts) |
| `DRIFTNET_VIDEO_FRAMES` | `off` | `vision` attaches up to 8 distinct frames to the same summary request when the item is still thin (only to your configured model, which must accept pictures, e.g. an Ollama vision model) |
| `DRIFTNET_YTDLP`, `DRIFTNET_FFMPEG`, `DRIFTNET_TESSERACT`, `DRIFTNET_WHISPER` | found on `PATH` | Full path of a tool that is not on `PATH` (`whisper` may also be `whisper-cli`; whisper.cpp needs `DRIFTNET_WHISPER_MODEL`, a model file) |
| `DRIFTNET_PLUGINS` | `~/.driftnet/plugins` | Folder of plugins: extractors, providers, judges (`.js` / `.mjs`), see [`examples/plugins`](../examples/plugins) |
| `DRIFTNET_TOKEN` | — | Admin password: writes, settings, agent tokens, MCP with every tool, the agent queue. Settable on the page |
| `DRIFTNET_READ_KEY` | — | Read-only share key (header or `?key=`): reading and the read-only MCP tools |
| `DRIFTNET_ACCESS` | `public` | `public`: anyone can read. `private`: reads need the password, the share key or an agent token |
| `DRIFTNET_CLOUDFLARED` | `cloudflared` | Path to `cloudflared`, for the page's public-URL button |
| `DRIFTNET_PUBLIC_URL` | — | Replies link to the item on the web page |
| `DRIFTNET_HOME` | `~/.driftnet` | Folder for `.env`, the database and the service log |
| `DRIFTNET_DB` | `~/.driftnet/driftnet.db` | SQLite file |
| `DRIFTNET_HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address. A non-local address without `DRIFTNET_TOKEN` prints a warning: anyone who reaches the port could change the catalogue |
| `DRIFTNET_ALLOWED_HOSTS` | — | Without a password, driftnet only answers requests addressed to this machine (or `DRIFTNET_PUBLIC_URL`), which stops web pages from reaching it through DNS tricks. Add other host names here, comma-separated |
| `DRIFTNET_OPEN` | `1` | `0` stops `npx driftnet` from opening the page in your browser |
| `DRIFTNET_MEDIA_CACHE_MB` | `300` | Disk space for cached card pictures |
| `DRIFTNET_ALLOW_PRIVATE_URLS` | — | `1` lets links to private or local addresses be fetched (intranet pages). Off by default: a shared link could otherwise read services on your machine or network |
| `DRIFTNET_AGENT` | `local` | Agent name recorded by the stdio MCP server |
| `TYPESAFE_ENDPOINT` | TypeSafe API | Jev endpoint override |
| `TELEGRAM_BOT_TOKEN` · `DISCORD_BOT_TOKEN` | — | Chat platforms |
| `DRIFTNET_TELEGRAM_CHATS` | — | Comma-separated chat ids the Telegram bot answers. Unset: any chat (each new one is logged with its id) |
| `DISCORD_CHANNELS` | — | Comma-separated channel ids driftnet listens to. Use it when the bot token is shared with another bot |
| `SLACK_APP_TOKEN` · `SLACK_BOT_TOKEN` · `SLACK_SIGNING_SECRET` | — | Slack (Socket Mode, or webhook) |
| `LINE_CHANNEL_SECRET` · `LINE_CHANNEL_ACCESS_TOKEN` | — | LINE |

**HTTP:** `GET /` · `GET /api/items[/:id]` (`?view=favorites|trash`; a search corrected for a typo answers with `X-Search-Corrected`, URI-encoded; `?fuzzy=0` turns that off) · `POST /api/items/:id/feedback` ·
`POST /api/items/:id/{trash,restore,favorite,unfavorite,move}` · `GET|POST /api/folders` · `PATCH|DELETE /api/folders/:id` · `GET /api/folders/:id/pack` (`?s=` signed link) · `GET /api/folders/:id/pack-link` · `POST /api/ingest` ·
`POST /api/chat` · `POST /api/digest/send` (`{"dryRun": true}` shows the text) · `POST /api/pending` · `POST /api/items/:id/enrich` · `GET /api/stats` ·
`PUT /api/items/:id/note` · `PUT /api/items/:id/tags` · `DELETE /api/items/:id` (trashed only) · `DELETE /api/trash` · `GET|DELETE /api/items/:id/history` · `POST /api/items/:id/history/:v/restore` · `GET|POST /api/notes` · `PUT|DELETE /api/notes/:id` · `GET /api/export` (`?format=vault`) · `POST /api/import` (`{content}` or `{url}` of a pack) · `GET /api/import/:job` ·
`GET|PUT /api/settings` (this machine, or with the token) · `GET /api/backup` (`?secrets=1` plus the password again in `X-Driftnet-Confirm`) · `POST /api/backup/restore` (a zip body; both admin password only) · `GET|POST /api/agent-tokens` · `DELETE /api/agent-tokens/:id[?purge=1]` (revoke, or remove a revoked one; admin password only) · `GET /api/categories` · `POST /api/items/:id/refresh` · `POST /api/items/:id/health` · `POST /api/folders/template` · `GET /llms.txt` · `GET /feed.xml` · `GET /openapi.json` · `/mcp`

</details>

## Backup and restore

**⚙ Settings › General › Backup** downloads one zip: `driftnet.db` (a consistent snapshot, made while driftnet runs), `settings.env` and `manifest.json` (driftnet version, schema version, date, number of cards). **Passwords, keys and tokens are left out of `settings.env`**; tick “Include passwords and keys” and type the admin password again to keep them. Restoring from a file checks it first (it must be a driftnet backup with an intact database, not from a newer driftnet), keeps your current data as `driftnet.db.before-restore-<time>`, and swaps the backup in the next time driftnet starts, so the page asks you to restart. Settings inside a backup are shown but never applied; copy what you want. Only the admin password can back up or restore, never a share key or agent token. From a terminal: `npx driftnet backup -o driftnet.zip` (works while stopped too) and `npx driftnet restore driftnet.zip` (driftnet must be stopped).
