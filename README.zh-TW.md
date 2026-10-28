# driftnet

**把連結丟進群組聊天室，自動分類、說明、整理成可搜尋的網頁，每則成本不到一美分的零頭。**

在 Threads、Facebook、X、YouTube 看到好用的 AI 工具，貼到聊天室說「之後再看」，三週後累積兩百個連結，再也沒打開過。

driftnet 是一個 LINE／Slack／Discord／Telegram 機器人：讀你丟進來的每個連結、追到真正的工具本身、分類、寫兩行說明，放到可以搜尋的網頁上。你的 AI agent（Claude Code、pi、Hermes、OpenClaw、ChatGPT、Grok…）也能透過 MCP 讀同一份清單，找出能讓**它們自己**變強的工具。

## 為什麼便宜

| 步驟 | 做什麼 | 成本 |
|---|---|---|
| 1. 快取 | 同一個連結（去掉 `utm_`、`fbclid`、`si` 等追蹤參數，統一 `youtu.be`、分享短網址、repo 子路徑） | **$0** |
| 2. 擷取 | GitHub API＋README 前段、YouTube 說明、`og:` 標籤，固定截在約 2000 字 | $0 |
| 3. 防污染 | 去除隱藏字元、標記提示詞注入 | $0 |
| 4. 信譽 | 常被倒讚的來源只存不摘要 | $0 |
| 5. 判斷 | [Jev](https://console.typesafe.ai) 用選擇題回答分類／類型／價值／是否注入，約 100ms | **約 $0.00006** |
| 6. 摘要 | 唯一一次 LLM 呼叫（Claude Haiku），只有值得看的才跑 | 約 $0.0003（估） |

實測 5 個真實 FB reels：判斷全部只花 **$0.00029**；其中只有一句標語、沒內容的那篇被判為不值得看，不會進入摘要。

沒有 Jev 金鑰時，摘要那次呼叫會順便分類；完全沒接模型時，照樣擷取、去重、列出。

## 會追到真正的工具

- 貼文附了 GitHub 連結 → 收錄 **repo** 本身，貼文當補充說明
- 貼文只提到開源專案名稱（「連結在留言」）→ 用名稱到 GitHub 搜尋（名稱完全相符才採用）
- 「本週 AI 大事」這種整理文 → 整理文一筆，加上它提到的每個開源專案各一筆

## 學會排除垃圾

- 在聊天室回 `👎12 廣告`、在網頁上、或由 agent 投票，都會累積到發布者（GitHub 帳號、YouTube 頻道、網域）的信譽
- 有 3 票以上、好評低於 25% 的來源不再摘要，垃圾越來越便宜
- 被標記為提示詞注入的項目人看得到，但**永遠不會送給 agent**

## 給 agent 用

| 用戶端 | 方式 |
|---|---|
| Claude Code／Claude Desktop／pi／Hermes／OpenClaw／任何 MCP 用戶端 | `POST /mcp`（Streamable HTTP）或 `pnpm --filter @driftnet/server mcp`（stdio） |
| 支援 skills 的 agent | 把 [`skills/driftnet`](skills/driftnet/SKILL.md) 複製進 skills 資料夾 |
| ChatGPT GPT Actions | 匯入 `GET /openapi.json` |
| 任何能抓網址的 | `GET /llms.txt` |

skill 規定 agent 只能**向人提議**升級，不能自己安裝任何東西。

## 開始使用

```bash
git clone https://github.com/KevinChu1110/driftnet && cd driftnet
pnpm install
cp .env.example .env   # 填 DRIFTNET_ANTHROPIC_API_KEY 和要用的聊天平台；DRIFTNET_LANGUAGE="Traditional Chinese (Taiwan)"
pnpm dev               # http://localhost:8787
```

需要 Node.js 22.13 以上（使用內建的 `node:sqlite`）。各平台設定見英文版 README。

> [!NOTE]
> 金鑰變數是 `DRIFTNET_ANTHROPIC_API_KEY`，**刻意不用** `ANTHROPIC_API_KEY`：後者一旦 export，
> Claude Code 也會讀到，從訂閱額度改走 API 計費。

啟動時會印出實際生效的模型（`judge=jev  summarizer=claude-haiku-5-5 / low`）。可用
`DRIFTNET_SUMMARY_MODEL`、`DRIFTNET_SUMMARY_EFFORT` 覆寫；effort 打錯字會退回 `low` 並提醒，
不會讓每次摘要都默默失敗。

## 花多少錢、資料去哪裡

每次付費呼叫（判斷或摘要，失敗的也算）都會記帳。網頁的 **Cost** 分頁按月、步驟、模型列出花費，
每則平均成本，以及快取幫你省下多少次重複分享。數字是依牌價估算，實際以供應商帳單為準。

> [!IMPORTANT]
> 「自架」指的是儲存，不是模型。資料庫在你自己的伺服器上；但判斷和摘要時，driftnet 會把連結的
> **摘錄**（標題、截短的內文、分享時附的聊天文字）送到 **TypeSafe**（有設 `TYPESAFE_API_KEY` 時，Jev）
> 和 **Anthropic**（有設 `DRIFTNET_ANTHROPIC_API_KEY` 時），適用各家 API 條款。沒有連結的聊天訊息
> 不會被處理或儲存。設 `DRIFTNET_JUDGE=off`／`DRIFTNET_SUMMARIZER=off` 就不會送任何內容給模型供應商，只做擷取和列表。

## 待辦（歡迎貢獻）

- [ ] 影片轉文字：很多 reels 只用講的報工具名稱
- [ ] 需要登入的貼文：FB 圖片貼文不登入拿不到內容（可插拔的登入瀏覽器，或對圖片做 OCR）
- [ ] 抓留言裡的連結
- [ ] 豐富回覆：LINE Flex、Slack Block Kit、Discord embed、用表情符號投票
- [ ] 每週摘要推回聊天室
