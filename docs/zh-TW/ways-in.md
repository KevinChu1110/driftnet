[← driftnet](../../README.zh-TW.md) · [English](../ways-in.md) · **繁體中文**

# 接法

| | 設定 | 筆電上能用？ | 關機期間的訊息 |
|---|---|---|---|
| **Chrome 擴充** | [從 Chrome 線上應用程式商店安裝](https://chromewebstore.google.com/detail/driftnet/inmlinbodfopmanbllkkjcgheelacddm) | ✅ | — |
| Telegram | `TELEGRAM_BOT_TOKEN`；群組要先用 `/setprivacy` 關閉隱私模式 | ✅ | 啟動時補上（24 小時內） |
| Discord | `DISCORD_BOT_TOKEN`；開啟 Message Content intent | ✅ | 逐頻道補讀，不回覆 |
| Slack | `SLACK_APP_TOKEN`（Socket Mode）＋ `SLACK_BOT_TOKEN`（要投票另需 `reactions:read` 與 `reaction_added` 事件） | ✅ | 漏掉 |
| LINE | `LINE_CHANNEL_SECRET`＋`LINE_CHANNEL_ACCESS_TOKEN`，webhook `/webhooks/line` | 要[公開網址](online.md) | 漏掉 |
| 你的 agent | MCP、OpenAPI 或 `/llms.txt`，見 [Agent](agents.md) | ✅ | — |
| 其他 | `POST /api/chat {"text": "…"}` 會回傳回覆 | ✅ | — |

**在聊天室裡**，沒有連結的訊息一律忽略。每個連結會回覆它是什麼，以及在網頁上的哪裡看，並依平台呈現
（`DRIFTNET_REPLY_STYLE=rich`，預設）：Discord 每個項目一張 embed、Slack Block Kit、LINE Flex 卡片（單張或最多 12 張的輪播）、Telegram 帶連結的訊息。
只有設了公開的 `DRIFTNET_PUBLIC_URL` 才會附圖片（絕不用 localhost 或內網位址，也不帶分享金鑰）。想在聊天室直接看摘要，或完全不回？
設 `DRIFTNET_REPLY=full` 或 `off`；`DRIFTNET_REPLY_STYLE=text` 則改回純文字。若平台拒絕豐富訊息（例如缺少權限），driftnet 會改送純文字並只記錄一次。

**投票**：打 `👍12` 或 `👎12 原因`（也可用 `+#12`／`-#12`；含連結的訊息一定不會被當成投票），或一鍵完成：

| | 做法 | 需要 |
|---|---|---|
| Discord | 在機器人的回覆上按 👍／👎（它會先幫你放好；會對該則回覆裡的每張卡片投票） | Message Reactions intent（非特權，discord.js 自動要求）；頻道內的「嵌入連結」與「新增反應」權限 |
| Slack | 在機器人的回覆上按 👍／👎（`+1`、`-1`） | scope `reactions:read`；事件訂閱 `reaction_added` |
| Telegram | 點卡片下方的 👍／👎（會跳出提示），或直接對機器人的訊息按表情 | 按鈕不需額外設定；要收到表情反應，機器人必須是群組管理員 |
| LINE | 點卡片上的 👍／👎（LINE 沒有表情反應 API） | 豐富回覆樣式 |

每人每張卡片一票，再投一次會改票。取消表情**不會**收回投票（改按另一個表情即可）。driftnet 會記住 Discord、Slack、Telegram 的回覆對應哪些卡片，保留 30 天。

**每週摘要。** 設 `DRIFTNET_DIGEST=weekly`（或 `daily`）和 `DRIFTNET_DIGEST_TO`（也可在 ⚙ 設定 → 一般 設定），driftnet 會在指定時間貼一則簡短訊息：
新增幾張卡片、收件匣還有幾張待整理、最好的五張新卡片（依價值、再依分享次數）、以及被分享 2 次以上的項目。沒有新內容就不發。時間用**伺服器的本地時間**
（要改就設 `TZ`）。排定時間 driftnet 剛好沒開的話，下次啟動會補發一則，不會多發。內文連結一律是公開網址（`DRIFTNET_PUBLIC_URL`），
不會帶唯讀分享金鑰，因為訊息會貼進群組。用 `POST /api/digest/send {"dryRun": true}` 試看看。Webhook 也會收到 `digest.sent` 事件。

聊天機器人的 token 在 driftnet 啟動時讀取：寫進 `~/.driftnet/.env` 後，把 driftnet 關掉再重新啟動。

<p align="center"><img src="../../assets/discord-zh-TW.jpg" alt="driftnet 回覆一則含兩個連結的 Discord 訊息：每個連結一行，各自指向網頁" width="80%"></p>
<sub>Discord 實測畫面：一則訊息兩個連結，各回一行。使用者名稱和伺服器網址已隱藏。</sub>
