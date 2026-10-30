[← driftnet](../../README.zh-TW.md) · [English](../how-it-works.md) · **繁體中文**

# driftnet 怎麼處理一個連結

# 連結怎麼被處理

大部分連結根本不會送到模型；會送的，也只送一份精簡大綱。

1. **擷取，並先檢查。** 看過的連結直接沿用（先去掉追蹤參數）。沒看過的，就讀 GitHub API 和 README、YouTube 說明、`og:` 標籤，或你在瀏覽器看到的頁面（擴充）。拒絕指向私有或本機位址的連結，去除隱藏字元，標記提示詞注入。
2. **整理成大綱。** 標題加每段開頭，拿掉選單、Cookie 提示和頁尾，上限約 350 token。
3. **判斷。** 一直被倒讚的來源只存不摘要。有開 [Jev](https://console.typesafe.ai) 就由它用約 100ms 決定資料夾、類型和值不值得看；沒有就由你的模型來。連模型也沒接，連結就全部放在「other」，不分類。
4. **摘要。** 只有值得看的才呼叫一次：一句話摘要、你會看到什麼、為什麼會在這裡。`DRIFTNET_SUMMARY_DEPTH` 決定每張卡片寫多少（`brief`、`standard` 或 `detailed`）。
5. **追蹤。** 內容裡附上或提到名稱的 repo，也會查到並收錄。
6. **放進你的資料夾。** AI 照資料夾的路徑和說明分類；新連結會放在收件匣，附兩、三個建議資料夾，點一下就歸檔。
7. **顯示在網頁上，也提供給 agent。** 網頁上看得到，agent 可以走 MCP、`/llms.txt`、`/feed.xml` 或對外 Webhook 取得。匯出可以整包帶走。

**Reels 與 Shorts。** 全部都是選配：下面這些工具一個都沒裝，driftnet 也照樣讀貼文的標題和說明。很多分享的 reels 只用講的報工具名稱。當 Instagram、Facebook、Threads、TikTok、YouTube Shorts 或 X 的連結是影片，而頁面文字幾乎沒內容時，driftnet 會用你機器上已有的工具讀影片本身，由便宜到貴，文字夠了就停：（1）用 `yt-dlp` 取字幕、標題和說明，不下載影片；（2）以低畫質下載影片（最多 60 MB、前 3 分鐘），每 2 秒取一張畫面，用 `tesseract` 辨識（有裝的話支援英文與中文）；（3）還是太少才把音訊交給 `whisper`（也可用 whisper.cpp 的 `whisper-cli`，需設定 `DRIFTNET_WHISPER_MODEL`）。讀到的內容會加上 `[captions]`、`[on-screen text]`、`[speech]` 標籤附在文字後面（最多 6,000 字元），並和頁面文字一樣先過防護；卡片會標示「已從影片讀取」。沒裝的工具就跳過。用筆電電池時可設 `DRIFTNET_VIDEO=captions`，做完第 1 步就停（不下載影片、不跑文字辨識和語音模型）；`off` 則全部關閉。工具不經過 shell、在一定會刪除的私有暫存資料夾裡執行、環境變數中拿掉 driftnet 的機密、每個步驟都有時間上限、拒絕私有或本機位址的連結，而且一次只處理一支影片。

另外兩個步驟**預設關閉**，要自己打開，因為它們會把東西送給你的模型。兩者都只在前面的步驟做完、內容仍然太少時才執行，而且都附在*同一次*摘要請求裡（不會一張畫面一次請求，也不會另外呼叫）：（4）`DRIFTNET_VIDEO=watch` 讓支援影片的模型直接看影片。摘要供應商是 `gemini` 或 `vertex` 時，YouTube 連結直接以連結送出（不下載），其他網站的 reel 則只有在下載的片段不超過 14 MB 時才內嵌送出（Gemini 的請求上限是含編碼共 20 MB）；其他供應商不能看影片，driftnet 會改走畫面。`DRIFTNET_VIDEO_FRAMES=vision` 在你的摘要模型看得懂圖片時，附上最多 8 張不重複的畫面（大約每 2 秒一張，相近與全黑的畫面會剔除，寬度最多 768 px，JPEG）：OpenAI 相容端點（包含 Ollama 的視覺模型）、Claude、Gemini、Vertex 都可以。畫面和影片只會送給你設定的那個模型。如果模型其實只吃文字，該項目會去掉畫面重試一次。（5）如果什麼都讀不到（沒有字幕、沒有畫面文字、沒有語音、也沒有可看的內容），driftnet 不會只憑標題亂猜：卡片維持待處理，在 agent 佇列裡帶一行提示 `video: needs a transcript`，讓有自己影片工具的 agent 補寫。

| 目的 | 可以試的模型（影片／圖片與大小限制請看各模型的 model card） | 設定 |
|---|---|---|
| 看 YouTube 影片 | Gemini Flash（`gemini` 或 `vertex`） | `DRIFTNET_VIDEO=watch` |
| 只用字幕或逐字稿 | 任何小型、便宜的模型 | 預設 |
| 畫面，完全在本機 | Ollama 上的視覺模型，例如 Qwen-VL 或 Gemma 視覺版，透過 `DRIFTNET_LLM_PROVIDER=openai` 加 `DRIFTNET_LLM_BASE_URL=http://localhost:11434/v1` | `DRIFTNET_VIDEO_FRAMES=vision` |
| 畫面，雲端 | Claude 或 Gemini | `DRIFTNET_VIDEO_FRAMES=vision` |

<details>
<summary><b>八個步驟的完整說明</b></summary>

| 步驟 | 做什麼 | 用模型？ |
|---|---|---|
| 1. 快取 | 同一個連結再出現時直接沿用；比對前先去掉 `utm_`、`fbclid`、`si` 等追蹤參數，並統一分享短網址、`youtu.be` 和 repo 子路徑 | 否 |
| 2. 擷取 | GitHub API＋README、YouTube 說明、`og:` 標籤，或你在瀏覽器看到的頁面（擴充）；PDF 和影片不會被當成文字下載 | 否 |
| 3. 大綱 | 標題加每段開頭；拿掉選單、麵包屑、Cookie 提示和頁尾；上限約 350 **token**，中日文一字算一個 token | 否 |
| 4. 防污染 | 拒絕指向私有或本機位址的連結（每一次轉址都檢查）；去除隱藏字元；標記提示詞注入 | 否 |
| 5. 信譽 | 3 票以上、好評低於 25% 的來源只存不摘要 | 否 |
| 6. 判斷（選用） | 有 TypeSafe 金鑰時，[Jev](https://console.typesafe.ai) 用選擇題回答放哪個資料夾、類型、值不值得看、有沒有注入，約 100ms；沒有 Jev 時，改由你的模型在第 7 步分類 | 極小的分類器 |
| 7. 摘要 | 只有值得看的才做一次結構化呼叫，或排進 agent 佇列 | 一次 |
| 8. 追蹤 | 內容裡附上或提到名稱的 repo，也會查到並收錄 | 否 |

大綱的做法借用 [Moli](https://github.com/lexmount/moli) 這類 agent 瀏覽器的概念，但不需要裝它：實測一篇中文文章從 831 降到 404 token。

</details>

# 連結健康檢查

連結會失效、儲存庫會被封存。設定 `DRIFTNET_HEALTH=weekly`（建議開啟；預設關閉，因為會對外發送請求），driftnet 就會每週左右重新檢查每張卡片，一次檢查幾張。GitHub 儲存庫走 API（星數、是否封存、最後推送；可設 `GITHUB_TOKEN` 提高上限，遇到速率限制會自動暫停）；其他連結則用同一套私有位址防護發一個輕量的 `HEAD`。卡片會被標成 `dead`（404／已移除，或網域已不存在）、`archived`（已封存）、`stale`（超過 18 個月沒有推送）或 `moved`（儲存庫改名／搬家）；伺服器錯誤和逾時不會改變狀態，之後會再試。被標記的卡片會顯示徽章，出現在網頁的「需要檢查」和 `driftnet_search_items` 的 `view=needs_review`，卡片上的「檢查連結」按鈕（或 `POST /api/items/:id/health`）可以立刻測一個連結。

# 以語意搜尋

選配。有了嵌入模型，搜尋除了比對字，也能依「內容在講什麼」找卡片：搜「登入」會找到 OAuth 工具，搜「掃描文件」會找到 OCR 工具。找不到本機模型（或你沒指定服務）就不會開，**不花摘要的 token**；關閉、太慢或服務掛掉時，搜尋就和以前的關鍵字搜尋完全一樣。

```bash
ollama pull nomic-embed-text      # 這樣就好：重啟 driftnet，啟動訊息會寫「semantic search: on」
```

- **嵌入什麼。**每張卡片幾百個字：名稱、一句話介紹、標籤、重點、標題、連結的網域，也就是摘要模型本來就看過的欄位。聊天內容一律不嵌入；你自己寫的筆記只有在模型跑在這台電腦上時才會用到。卡片存好後在背景嵌入（一次一個請求），開啟後既有的卡片也會慢慢補上；存連結不會等它。
- **資料去哪。**`ollama` 和本機的 `DRIFTNET_EMBED_BASE_URL` 全程不離開你的電腦。`openai`、`gemini` 會把上述卡片文字和每次搜尋的關鍵字送給該服務，能接受再指定。金鑰只會送到該服務自己的位址（或你填的網址），摘要模型的金鑰只有同一家時才會沿用。
- **速度。**向量用精簡格式存、在記憶體內比對（一萬張卡片約 12 毫秒）。搜尋最多等 1.5 秒取得關鍵字的向量，等不到就改用關鍵字；失敗後 30 秒內不再嘗試。重複的搜尋有快取。
- **相關卡片。**卡片詳情最多列 5 張相似的卡片（有向量用向量，否則用共同標籤和名稱字詞）。`GET /api/items/:id` 和 `driftnet_get_item` 工具也會附上同一份清單。

| 變數 | 預設 | 用途 |
|---|---|---|
| `DRIFTNET_EMBED` | `auto` | `auto`：本機 Ollama 有嵌入模型、或設了 `DRIFTNET_EMBED_PROVIDER` 就開。`off`：一律不開 |
| `DRIFTNET_EMBED_PROVIDER` | *（自動）* | `ollama`、`openai`（也適用任何相容的 `/embeddings`，包含 Ollama 的 `/v1`）或 `gemini` |
| `DRIFTNET_EMBED_MODEL` | 依服務 | `nomic-embed-text`（Ollama）、`text-embedding-3-small`（OpenAI）、`gemini-embedding-001`（Gemini）。更換後會在背景重新嵌入全部卡片 |
| `DRIFTNET_EMBED_BASE_URL` | Ollama `http://127.0.0.1:11434`、OpenAI 官方位址 | `ollama` / `openai` 的端點 |
| `DRIFTNET_EMBED_API_KEY` | — | `openai` / `gemini` 的金鑰（本機不需要） |
| `DRIFTNET_EMBED_FLOOR` | nomic `0.55`；OpenAI `0.3`；Gemini `0.5` | 沒有字面相符時，餘弦相似度要多高才會出現；調高則結果變少。只實測過 nomic-embed-text |
