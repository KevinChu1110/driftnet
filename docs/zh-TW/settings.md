[← driftnet](../../README.zh-TW.md) · [English](../settings.md) · **繁體中文**

# 設定

所有設定都是環境變數，通常寫在 `~/.driftnet/.env`，範例見 [`.env.example`](../../.env.example)。
常用的也可以在網頁的 **⚙ 設定** 改；由執行環境本身（systemd、Docker、shell）設定的變數優先，在網頁上只能看不能改。

<details>
<summary><b>全部設定</b></summary>

| 變數 | 預設 | 用途 |
|---|---|---|
| `DRIFTNET_LLM_PROVIDER` | *（關閉）* | `anthropic`、`openai`、`gemini`、`bedrock`、`vertex`、`claude-cli`、`gemini-cli`、外掛名稱，或留空 |
| `DRIFTNET_LLM_MODEL` | — | 模型名稱。`anthropic`、`openai`、`bedrock`、`vertex` 必填；`gemini` 預設 `gemini-flash-latest`；`claude-cli` 預設 `haiku` |
| `DRIFTNET_LLM_API_KEY` | — | 該供應商的金鑰（Ollama／LM Studio 不用；`vertex` 可填存取權杖代替金鑰檔） |
| `DRIFTNET_LLM_REGION` | `vertex`：`us-central1` | `bedrock`（沒填時用 `AWS_REGION`）和 `vertex` 的區域 |
| `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` · `AWS_SESSION_TOKEN` | — | `bedrock` 的憑證 |
| `AWS_BEARER_TOKEN_BEDROCK` | — | `bedrock` 改用 Bedrock API 金鑰，不用上面三個 |
| `GOOGLE_APPLICATION_CREDENTIALS` · `DRIFTNET_VERTEX_CREDENTIALS` | — | `vertex`：服務帳戶金鑰檔（第二個也可以直接放 JSON 內容） |
| `GOOGLE_CLOUD_PROJECT` | 取自金鑰檔 | `vertex` 的專案 |
| `GEMINI_API_KEY` | — | `DRIFTNET_LLM_API_KEY` 沒填時，`gemini` 用這個 |
| `DRIFTNET_LLM_BASE_URL` | OpenAI | `openai` 供應商的端點 |
| `DRIFTNET_LLM_EFFORT` | `anthropic`：`low` | `anthropic`：`low`～`xhigh`；`openai`：`reasoning_effort`；`claude-cli`：`--effort` |
| `DRIFTNET_CLI_PATH` | `claude`／`gemini` | `claude-cli`／`gemini-cli` 使用的執行檔 |
| `DRIFTNET_CLI_CONCURRENCY` | `1` | 同時最多跑幾個 CLI |
| `DRIFTNET_LANGUAGE` | `English` | 摘要和 bot 回覆的語言 |
| `DRIFTNET_SUMMARY_DEPTH` | `standard` | 每張卡片寫多少：`brief`、`standard` 或 `detailed` |
| `DRIFTNET_LOCALE` | 跟 `DRIFTNET_LANGUAGE` | 強制 bot 自己的用語用 `en` 或 `zh-TW` |
| `DRIFTNET_REPLY` | `link` | 聊天回覆：`link`（一行＋網頁連結）、`full`（摘要直接貼在聊天室）或 `off` |
| `DRIFTNET_REPLY_STYLE` | `rich` | `rich`（embed、Block Kit、Flex 卡片、投票按鈕）或 `text`（純文字） |
| `TYPESAFE_API_KEY` | `~/.typesafe/api_key` | 啟用 Jev 判斷；`DRIFTNET_JUDGE=off` 可關閉 |
| `DRIFTNET_JUDGE` | 有金鑰就 Jev | `jev`、`rules`、`llm`、`heuristic`、`off` 或外掛的判斷器（見[判斷器](models.md#判斷器)） |
| `DRIFTNET_JUDGE_RULES` | — | `rules` 判斷器的規則檔 |
| `DRIFTNET_MIN_CONFIDENCE` | `0.4` | Jev 信心低於此值時改由模型分類 |
| `DRIFTNET_DIGEST_TOKENS` | `350` | 頁面大綱的 token 預算 |
| `DRIFTNET_FOLDERS` | `ai` | 新資料庫的起始資料夾樣板：`ai`（AI 與程式）、`research`（論文、文章、資料集……）或 `everyday`（料理、旅行、理財……）。清單還是空的時候，網頁上也能選 |
| `DRIFTNET_DIGEST` | `off` | 定時把摘要貼進你的聊天室：`off`、`daily` 或 `weekly`（見[每週摘要](ways-in.md)） |
| `DRIFTNET_DIGEST_AT` | `09:00` | 每天的時間，`HH:MM`，用伺服器的本地時間（會遵守 `TZ` 變數） |
| `DRIFTNET_DIGEST_DAY` | `mon` | `weekly` 的星期幾：`mon`…`sun` |
| `DRIFTNET_DIGEST_TO` | — | 送到哪裡，以逗號分隔：`telegram:<聊天室 id>`、`discord:<頻道 id>`、`slack:<頻道 id>`、`line:<使用者、群組或聊天室 id>`；使用已設定的機器人 token |
| `DRIFTNET_WEBHOOK_URL` | — | 卡片有變動就以 JSON POST 到這裡（`item.added`／`item.updated`／`item.trashed`／`item.restored`，另有 `digest.sent`），逾時 5 秒、1 秒後重試一次、不跟隨轉址 |
| `DRIFTNET_WEBHOOK_SECRET` | — | 為每次推送簽章：`X-Driftnet-Signature: sha256=<"<X-Driftnet-Timestamp>.<內容>" 的 hmac>`。拒收太舊的時間戳記即可防重送；重試時 `X-Driftnet-Delivery` 不變 |
| `DRIFTNET_WEBHOOK_ALLOW_LOCAL` | — | 設 `1` 允許 Webhook 打到內網位址（例如區網裡的 n8n），只限你填的那台主機 |
| `DRIFTNET_CATEGORIES` | 內建 | 起始資料夾的 JSON 檔：`{ "id": "說明" }`，只在新資料庫用一次，之後直接在網頁上改 |
| `GITHUB_TOKEN` | — | GitHub API 上限從每小時 60 次提高到 5,000 次 |
| `DRIFTNET_SUMMARY_RULES` | — | 每次摘要都要遵守的自訂規則，例如「說明是否免費」；agent 也會收到 |
| `DRIFTNET_PROFILE` | — | 你是誰、關心什麼，最多 600 字（⚙ 設定 › AI › 關於你）。模型用它判斷什麼值得你花時間，並寫每張卡片的「為什麼值得看」；agent 也會收到。它只在模型的 system prompt 放一次（約 150 token，所以 prompt caching 照常命中），也不會被抄進卡片 |
| `DRIFTNET_UPDATE_CHECK` | 關閉 | 設 `1` 才會每天向 `registry.npmjs.org` 查一次最新版本號，有新版就在網頁標題列顯示小提示「driftnet x.y.z 已發布」（`driftnet status` 也會顯示）。不會傳送任何與你有關的資料。預設關閉，設 `1` 才開啟 |
| `DRIFTNET_BLOCK_DOMAINS` | — | 永遠不收錄的網域（含子網域），用逗號分隔 |
| `DRIFTNET_HEALTH` | `off` | `weekly` 約每週重新檢查連結，並標記失效、封存、久未更新的卡片（見「連結健康檢查」）。預設關閉：會對外發送請求 |
| `DRIFTNET_VIDEO` | `auto` | `auto` 使用已安裝的 `yt-dlp`、`ffmpeg`、`tesseract`、`whisper`；`captions` 只讀字幕和說明（省電）；`watch` 在 `auto` 之後，仍太少時讓 Gemini／Vertex 直接看影片（會把影片或 YouTube 連結送給該模型）；`off` 完全不讀影片（見「Reels 與 Shorts」） |
| `DRIFTNET_VIDEO_FRAMES` | `off` | `vision` 在內容仍太少時，把最多 8 張不重複的畫面附在同一次摘要請求裡（只送給你設定的模型，模型必須看得懂圖片，例如 Ollama 的視覺模型） |
| `DRIFTNET_YTDLP`、`DRIFTNET_FFMPEG`、`DRIFTNET_TESSERACT`、`DRIFTNET_WHISPER` | 從 `PATH` 找 | 不在 `PATH` 的工具的完整路徑（`whisper` 也可指向 `whisper-cli`；whisper.cpp 還需要 `DRIFTNET_WHISPER_MODEL`，指向模型檔） |
| `DRIFTNET_PLUGINS` | `~/.driftnet/plugins` | 外掛（擷取器、供應商、判斷器；`.js`／`.mjs`）的資料夾，範例見 [`examples/plugins`](../../examples/plugins) |
| `DRIFTNET_TOKEN` | — | 管理密碼：寫入、改設定、管理 agent 金鑰、完整的 MCP 工具、agent 佇列。可以在網頁上設定 |
| `DRIFTNET_READ_KEY` | — | 唯讀分享碼（放 header 或 `?key=`）：只能讀，MCP 也只有讀取類工具 |
| `DRIFTNET_ACCESS` | `public` | `public`：任何人都能讀。`private`：讀取要密碼、分享碼或 agent 金鑰 |
| `DRIFTNET_CLOUDFLARED` | `cloudflared` | `cloudflared` 的路徑，給網頁上的「公開網址」按鈕用 |
| `DRIFTNET_PUBLIC_URL` | — | 回覆裡附上網頁連結 |
| `DRIFTNET_HOME` | `~/.driftnet` | 放 `.env`、資料庫和服務日誌的資料夾 |
| `DRIFTNET_DB` | `~/.driftnet/driftnet.db` | SQLite 檔案位置 |
| `DRIFTNET_HOST`／`PORT` | `127.0.0.1`／`8787` | 監聽位址。設成非本機位址卻沒有 `DRIFTNET_TOKEN` 時會顯示警告：連得到這個埠的人都能改動清單 |
| `DRIFTNET_ALLOWED_HOSTS` | — | 沒設密碼時，driftnet 只回應發給本機（或 `DRIFTNET_PUBLIC_URL`）的請求，避免網頁透過 DNS 手法連進來。其他主機名稱加在這裡，以逗號分隔 |
| `DRIFTNET_OPEN` | `1` | 設 `0`：`npx driftnet` 啟動時不自動開瀏覽器 |
| `DRIFTNET_MEDIA_CACHE_MB` | `300` | 卡片圖片快取可用的磁碟空間 |
| `DRIFTNET_ALLOW_PRIVATE_URLS` | — | 設 `1` 允許抓取私有或本機位址的連結（內網頁面）。預設關閉，否則分享進來的連結可能讀到你電腦或內網上的服務 |
| `DRIFTNET_AGENT` | `local` | stdio MCP 伺服器記錄的 agent 名稱 |
| `TYPESAFE_ENDPOINT` | TypeSafe API | 覆寫 Jev 的端點 |
| `TELEGRAM_BOT_TOKEN` · `DISCORD_BOT_TOKEN` | — | 聊天平台 |
| `DRIFTNET_TELEGRAM_CHATS` | — | Telegram 機器人只回應這些聊天室（以逗號分隔的 chat id）。不設：任何聊天室都可以（每個新聊天室會在紀錄裡印出 id） |
| `DISCORD_CHANNELS` | — | driftnet 只聽這些頻道（以逗號分隔的頻道 id）。和其他 bot 共用 token 時使用 |
| `SLACK_APP_TOKEN` · `SLACK_BOT_TOKEN` · `SLACK_SIGNING_SECRET` | — | Slack（Socket Mode 或 webhook） |
| `LINE_CHANNEL_SECRET` · `LINE_CHANNEL_ACCESS_TOKEN` | — | LINE |

**HTTP：** `GET /` · `GET /api/items[/:id]`（`?view=favorites|trash`；更正過拼字的搜尋會帶 `X-Search-Corrected` 標頭（URI 編碼），`?fuzzy=0` 可關閉）· `POST /api/items/:id/feedback` ·
`POST /api/items/:id/{trash,restore,favorite,unfavorite,move}` · `GET|POST /api/folders` · `PATCH|DELETE /api/folders/:id` · `GET /api/folders/:id/pack`（`?s=` 簽名連結）· `GET /api/folders/:id/pack-link` · `POST /api/ingest` ·
`POST /api/chat` · `POST /api/digest/send`（`{"dryRun": true}` 只顯示內容）· `POST /api/pending` · `POST /api/items/:id/enrich` · `GET /api/stats` ·
`PUT /api/items/:id/note` · `PUT /api/items/:id/tags` · `DELETE /api/items/:id`（限垃圾桶內）· `DELETE /api/trash` · `GET|DELETE /api/items/:id/history` · `POST /api/items/:id/history/:v/restore` · `GET|POST /api/notes` · `PUT|DELETE /api/notes/:id` · `GET /api/export`（`?format=vault`）· `POST /api/import`（`{content}` 或資料夾包的 `{url}`）· `GET /api/import/:job` ·
`GET|PUT /api/settings`（限本機，或帶 token）· `GET /api/backup`（`?secrets=1` 並在 `X-Driftnet-Confirm` 標頭再送一次密碼）· `POST /api/backup/restore`（body 是 zip；兩者都限管理密碼）· `GET|POST /api/agent-tokens` · `DELETE /api/agent-tokens/:id[?purge=1]`（撤銷，或移除已撤銷的；限管理密碼）· `GET /api/categories` · `POST /api/items/:id/refresh` · `POST /api/items/:id/health` · `POST /api/folders/template` · `GET /llms.txt` · `GET /feed.xml` · `GET /openapi.json` · `/mcp`

</details>

## 備份與還原

**⚙ 設定 › 一般 › 備份** 會下載一個 zip：`driftnet.db`（一致的快照，driftnet 執行中也能做）、`settings.env` 和 `manifest.json`（driftnet 版本、資料庫結構版本、日期、卡片數）。**`settings.env` 不含密碼、金鑰和 token**；勾選「包含密碼和金鑰」並再輸入一次管理員密碼才會保留。從檔案還原時會先檢查（必須是 driftnet 的備份、資料庫完整、不是來自較新版的 driftnet），把目前的資料留成 `driftnet.db.before-restore-<時間>`，並在 driftnet 下次啟動時換上備份，所以頁面會請你重新啟動。備份裡的設定只會顯示、不會自動套用，需要的自己複製。只有管理員密碼能備份或還原，分享金鑰和 agent token 都不行。終端機：`npx driftnet backup -o driftnet.zip`（沒開時也能用）和 `npx driftnet restore driftnet.zip`（driftnet 必須先停掉）。
