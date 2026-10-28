<div align="center">

# driftnet

**把連結丟進群組聊天室，自動分類、說明、整理成可搜尋的清單。**

[English](README.md) · **繁體中文**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-339933.svg)
![LINE · Slack · Discord · Telegram](https://img.shields.io/badge/chat-LINE%20·%20Slack%20·%20Discord%20·%20Telegram-555.svg)
![MCP](https://img.shields.io/badge/agents-MCP-8a63d2.svg)

</div>

在 Threads、Facebook、X、YouTube 看到好用的 AI 工具，貼到聊天室說「之後再看」。三週後累積兩百個連結，
那個聊天室就再也沒打開過。

driftnet 是一個 **LINE、Slack、Discord、Telegram** 機器人。它會讀你丟進來的每個連結，追到真正的工具本身，
分類，用你的語言寫一段簡短說明，再放到可以搜尋的網頁上。你的 AI agent（Claude Code、pi、Hermes、OpenClaw、
ChatGPT、Grok…）也能透過 MCP 讀同一份清單，找出能讓**它們自己**變強的工具。

```text
你  ▸ https://www.facebook.com/share/v/1DfVB2odi3/

bot ▸ 📌 本週 AI 大事 (3/11)｜news
      一分鐘看完本週 AI 重要發布
      • Paperclip：開源的 agent「公司」框架
      • Symphony：OpenAI 的 agent 派工看板
      提到：FelixCraftAI、Paperclip、Symphony、GPT-5.4
      #1 · 回覆 👍1 / 👎1

      ↳ 📌 paperclip｜agent-framework
        https://github.com/paperclipai/paperclip
      ↳ 📌 symphony｜agent-framework
        https://github.com/openai/symphony
```

<sub>回覆示意。貼文本身沒有附連結，兩個 repo 是從貼文裡提到的名稱找到的。</sub>

**目錄** · [功能](#功能) · [開始使用](#開始使用) · [聊天平台](#聊天平台) · [模型](#模型隨你選) ·
[給 agent 用](#給-agent-用) · [設定](#設定) · [資料去哪裡](#資料去哪裡) · [參與開發](#參與開發)

## 功能

### 省 token

多數 AI 書籤工具把每個網頁都丟給大模型。driftnet 先做完所有免費的步驟，大部分連結根本不會送到模型：

| 步驟 | 做什麼 | 模型呼叫 |
|---|---|---|
| 1. 快取 | 同一個連結再出現時直接沿用。比對前會先去掉 `utm_`、`fbclid`、`si` 等追蹤參數，並統一 `youtu.be`、分享短網址、repo 子路徑 | 無 |
| 2. 擷取 | GitHub API＋README 前段、YouTube 說明、`og:` 標籤，截在約 2,000 字 | 無 |
| 3. 防污染 | 去除隱藏字元、標記提示詞注入 | 無 |
| 4. 信譽 | 常被倒讚的來源只存不摘要 | 無 |
| 5. 判斷 | [Jev](https://console.typesafe.ai) 用選擇題回答分類、類型、值不值得看、有沒有注入（約 100ms） | 極小的分類器 |
| 6. 摘要 | 用**你選**的模型做一次結構化呼叫，只有值得看的才跑 | 一次 |

實測 5 個真實的 FB reels，Jev 判斷**全部加起來 $0.00029**。其中一篇只有一句標語，被判為不值得看，
完全沒送到模型。

沒有 Jev 金鑰時，模型會在同一次呼叫裡順便分類；完全沒接模型時，照樣擷取、去重、列出。

### 會追到真正的工具

社群貼文通常是在「介紹」工具，不是工具本身：

- 貼文附了 GitHub 連結 → 收錄 **repo**，貼文當補充說明。
- 貼文只提到開源專案名稱（「連結在留言」）→ 用名稱到 GitHub 搜尋，名稱完全相符才收錄。
- 「本週 AI 大事」這類整理文 → 整理文一筆，它提到的每個開源專案再各一筆。
- 好幾個連結黏在一起沒空格，也能正確拆開。

### 學會排除垃圾

- 在聊天室（`👎12 廣告`）、網頁上或由 agent 投票，票數會累積成發布者的信譽。發布者指 GitHub 帳號、YouTube 頻道或網域。
- 有 3 票以上、好評低於 25% 的來源不再做摘要。垃圾倒讚得越多，花費就越少。
- 被標記為提示詞注入的項目人看得到，但**永遠不會送給 agent**。

### 中文或英文

只要一個設定 `DRIFTNET_LANGUAGE`，摘要**和** bot 自己的回覆都會切換語言：`Traditional Chinese (Taiwan)` 或 `English`。
摘要可以用模型會寫的任何語言（例如 `Japanese`），這時 bot 自己的用語會改用英文。工具名稱一律保留原文。

## 開始使用

```bash
git clone https://github.com/KevinChu1110/driftnet && cd driftnet
pnpm install
cp .env.example .env   # 選模型供應商（可不選）和要用的聊天平台
pnpm dev               # http://localhost:8787
```

需要 Node.js 22.13 以上（使用內建的 `node:sqlite`）。不接任何聊天平台也能先試：

```bash
curl -X POST localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"text": "看這個 https://github.com/paperclipai/paperclip"}'
```

## 聊天平台

| 平台 | 要設定 | 需要公開網址？ |
|---|---|---|
| Telegram | `TELEGRAM_BOT_TOKEN`（向 @BotFather 申請）。要在群組裡用，得先用 `/setprivacy` 關閉隱私模式 | 不用（long polling） |
| Discord | `DISCORD_BOT_TOKEN`，並開啟 **Message Content** intent | 不用（gateway） |
| LINE | `LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`，Webhook 網址 `/webhooks/line` | 要 |
| Slack | `SLACK_SIGNING_SECRET`、`SLACK_BOT_TOKEN`（權限 `channels:history`、`groups:history`、`chat:write`），Events 網址 `/webhooks/slack` | 要 |
| 其他 | `POST /api/chat {"text": "…"}` 會回傳回覆文字 | — |

本機開發時可用 `cloudflared tunnel` 或 `ngrok` 把 webhook 開出去。

**在聊天室裡：** 沒有連結的訊息一律忽略。每則回覆最後都有項目編號，用 `👍12`／`👎12 原因`
（或 `+12`／`-12`）投票。

## 模型隨你選

driftnet 不綁任何一家。摘要只透過一個很小的介面（`LlmProvider`：「把這個 JSON schema 填好」），內建兩種：

| `DRIFTNET_LLM_PROVIDER` | 涵蓋 |
|---|---|
| `anthropic` | Claude（官方 SDK） |
| `openai` | 所有相容 OpenAI 格式的服務：OpenAI、Gemini、Grok、DeepSeek、OpenRouter、LiteLLM、**Ollama／LM Studio（完全本機）** |
| `claude-cli` | **你的 Claude 訂閱**，透過同一台機器上已登入的 Claude Code，不需要 API key |
| `gemini-cli` | **你的 Google 帳號**，透過同一台機器上已登入的 Gemini CLI，不需要 API key |
| *（不填）* | 不用模型：照樣擷取、用 Jev 判斷（有設的話）、去重、列出 |

```bash
DRIFTNET_LLM_PROVIDER=openai
DRIFTNET_LLM_MODEL=gemini-3.8-flash
DRIFTNET_LLM_API_KEY=...
DRIFTNET_LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
```

> [!NOTE]
> driftnet **刻意不讀** `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`。這些變數一旦 export，會改變機器上其他工具的計費方式，
> 例如 Claude Code 會從訂閱額度改走 API 計費。

不論哪家模型，回覆都會照 schema 驗證，不守格式的模型也存不進壞資料。回覆被截斷、拒答或格式錯誤時重試一次；
金鑰錯誤或請求有誤則不重試。模型給的工具連結，只有真的出現在抓到的內容裡才會保留；否則改用名稱到 GitHub
做完全比對，因為模型很容易編出看起來很像真的 repo 網址。

### 沒有 API key？用你已經登入的 CLI

```bash
DRIFTNET_LLM_PROVIDER=claude-cli      # 模型預設 haiku
# 或
DRIFTNET_LLM_PROVIDER=gemini-cli
DRIFTNET_LLM_MODEL=gemini-3.5-flash-lite
```

driftnet 會在背景一次一個地呼叫 CLI。分享進來的連結是不可信的內容，所以 CLI 會被鎖住：

| | Claude Code | Gemini CLI |
|---|---|---|
| 工具 | 全部關閉（`--tools ""`） | 用系統層級設定檔全部排除 |
| 你的設定、hooks、MCP、`CLAUDE.md`／`GEMINI.md` | 不載入 | 不載入（用自己的系統提示、不載入擴充） |
| 工作資料夾 | 空的私人暫存資料夾 | 空的私人暫存資料夾 |
| 環境變數 | 拿掉 driftnet 的機密和 `ANTHROPIC_API_KEY`，確保走你的登入 | 拿掉 driftnet 的機密和 `GEMINI_API_KEY` |
| 實測 | 每則約 4 秒 | 每則約 3.5 秒 |

限制：跑 driftnet 的那台機器要裝好 CLI 並登入；每次呼叫都會計入你方案的用量上限。

> [!WARNING]
> 用程式呼叫個人訂閱，受各家條款規範。Anthropic 不允許第三方產品提供 claude.ai 登入。`claude-cli` 是在
> **你自己的**機器上、用**你自己的**登入、跑**你自己的** Claude Code，預設關閉。使用前請先確認最新條款，
> 也不要拿來替別人提供服務。

## 給 agent 用

| 用戶端 | 連接方式 |
|---|---|
| Claude Code、Claude Desktop、pi、Hermes、OpenClaw、任何 MCP 用戶端 | `POST /mcp`（Streamable HTTP），或 `pnpm --filter @driftnet/server mcp`（stdio） |
| 支援 skills 的 agent | 把 [`skills/driftnet`](skills/driftnet/SKILL.md) 複製進 skills 資料夾 |
| ChatGPT 自訂 GPT Actions | 匯入 `GET /openapi.json` |
| 任何能抓網址的程式 | `GET /llms.txt` |

```bash
# Claude Code
claude mcp add --transport http driftnet http://localhost:8787/mcp \
  --header "Authorization: Bearer $DRIFTNET_TOKEN" --header "X-Driftnet-Agent: claude-code"
```

| MCP 工具 | 用途 |
|---|---|
| `driftnet_search` | 挑工具前先搜尋清單 |
| `driftnet_recent` | 看最近新增的，找出能改善 agent 自己工作流程的工具 |
| `driftnet_save` | 收錄一個連結 |
| `driftnet_feedback` | 給項目按讚或倒讚，agent 的票也會計入信譽 |

skill 規定 agent 只能**向人提議**升級，不能自己安裝任何東西，而且清單裡的內容一律當資料看，不當指令。

## 設定

所有設定都是環境變數，範例見 [`.env.example`](.env.example)。

| 變數 | 預設 | 用途 |
|---|---|---|
| `DRIFTNET_LLM_PROVIDER` | *（關閉）* | `anthropic`、`openai`、`claude-cli`、`gemini-cli` 或留空 |
| `DRIFTNET_LLM_MODEL` | — | 模型名稱。`anthropic`、`openai` 必填；`claude-cli` 預設 `haiku` |
| `DRIFTNET_LLM_API_KEY` | — | 該供應商的金鑰（Ollama／LM Studio 可不填） |
| `DRIFTNET_LLM_BASE_URL` | OpenAI | `openai` 供應商的端點 |
| `DRIFTNET_LLM_EFFORT` | `anthropic`：`low` | `anthropic`：`low`～`xhigh`，打錯字會退回 `low`；`openai`：當作 `reasoning_effort`；`claude-cli`：`--effort`。除了 `anthropic`，都是有設才送 |
| `DRIFTNET_CLI_PATH` | `claude`／`gemini` | `claude-cli`／`gemini-cli` 使用的執行檔路徑 |
| `DRIFTNET_CLI_CONCURRENCY` | `1` | 同時最多跑幾個 CLI |
| `DRIFTNET_LANGUAGE` | `English` | 摘要和 bot 回覆的語言 |
| `DRIFTNET_LOCALE` | 跟 `DRIFTNET_LANGUAGE` | 強制 bot 自己的用語用 `en` 或 `zh-TW` |
| `TYPESAFE_API_KEY` | `~/.typesafe/api_key` | 啟用 Jev 判斷；`DRIFTNET_JUDGE=off` 可關閉 |
| `DRIFTNET_MIN_CONFIDENCE` | `0.4` | Jev 信心低於此值時改由模型分類 |
| `DRIFTNET_CATEGORIES` | 內建 | 自訂分類的 JSON 檔：`{ "id": "說明" }` |
| `GITHUB_TOKEN` | — | GitHub API 上限從每小時 60 次提高到 5,000 次 |
| `DRIFTNET_TOKEN` | — | 伺服器公開後，寫入（收錄、投票、MCP）都需要這個 token |
| `DRIFTNET_PUBLIC_URL` | — | 回覆裡附上網頁連結 |
| `DRIFTNET_DB` | `./data/driftnet.db` | SQLite 檔案位置 |
| `PORT` | `8787` | HTTP 埠號 |
| `DRIFTNET_HOST` | `127.0.0.1` | 監聽位址。要對外請在前面加反向代理；在容器裡用 `0.0.0.0` |

**HTTP 端點：** `GET /` 網頁 · `GET /api/items` · `GET /api/items/:id` ·
`POST /api/items/:id/feedback` · `POST /api/ingest` · `POST /api/chat` · `GET /api/stats` ·
`GET /api/categories` · `GET /llms.txt` · `GET /openapi.json` · `/mcp`

## 資料去哪裡

> [!IMPORTANT]
> 「自架」指的是儲存。資料庫在你自己的伺服器上；但判斷和摘要時，driftnet 會把連結的**摘錄**
> （標題、截短的內文、分享時附的聊天文字）送到 **TypeSafe**（有開 Jev 時）和**你選的模型供應商**，
> 適用各家的 API 條款。沒有連結的聊天訊息不會被處理或儲存。
>
> 想全部留在自己的機器上：`openai` 供應商指向 Ollama，並設 `DRIFTNET_JUDGE=off`。

## 參與開發

```text
packages/core     流程、擷取器、判斷（Jev）、摘要＋模型轉接、防污染、儲存
apps/server       HTTP API、網頁、MCP、聊天平台轉接
skills/driftnet   Agent Skill
```

```bash
pnpm typecheck && pnpm test
```

可以擴充的地方：

- **新網站的擷取器**：`packages/core/src/extractors` 的 `registerExtractor()`
- **新模型**：在 `packages/core/src/llm` 實作 `LlmProvider`
- **新聊天平台**：從 `apps/server/src/adapters/handle.ts` 呼叫 `handleChatText()`
- **新判斷器**：在 `packages/core/src/judge` 實作 `Judge`
- **bot 介面語言**：在 `packages/core/src/i18n.ts` 加一組語系

### 待辦：適合第一次貢獻

這些都是拿大家真正會分享的連結實測後發現的：

- [ ] **影片轉文字。** 很多 reels 只用講的報工具名稱（字幕、Whisper）。
- [ ] **需要登入的貼文。** FB 圖片貼文不登入什麼都拿不到，需要可插拔的登入瀏覽器，或對貼文圖片做 OCR。
- [ ] **抓留言裡的連結。** 「連結在第一則留言」到處都是。
- [ ] **豐富回覆。** LINE Flex、Slack Block Kit、Discord embed、用表情符號投票。
- [ ] **每週摘要**推回聊天室。
- [ ] **更多轉接。** 原生 Gemini、Bedrock、Vertex，以及更多判斷器。

## 授權

[MIT](LICENSE)
