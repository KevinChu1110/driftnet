[← driftnet](../../README.zh-TW.md) · [English](../chrome-extension.md) · **繁體中文**

# Chrome 擴充

<p align="center"><img src="../../assets/extension-zh-TW.jpg" alt="driftnet 彈出視窗疊在一則社群貼文上：已收錄，附分類、評價和三點摘要" width="100%"></p>
<sub>由擴充的端到端測試（<code>pnpm e2e:extension</code>）在測試頁面上錄製：說明被截斷，連結藏在留言裡。</sub>

不登入去抓 FB 圖片貼文，什麼都拿不到。擴充改送**你自己**登入後看到的內容：會先按開「查看更多」；如果貼文本身
沒有外部連結，會打開留言找一次。實測：圖片貼文從 0 字變成完整內文加留言；說「連結在留言」的 reel，
從留言裡找到了 GitHub repo。

- **工具列按鈕**：送出目前這頁。
- **在連結上按右鍵**：送出那個連結，加上它所在那則貼文的文字。
- **選取文字後按右鍵**：只送選取的內容。

**在 Threads、X、Instagram 讀什麼。** 只在你按下時、只讀畫面上有的，不會另外去抓；網站改版讀不懂時，
會退回上面的通用讀法。

| 網站 | 擷取內容 |
|---|---|
| **Threads** | 貼文與作者、引用／轉發的貼文、最多 20 則回覆（會按開「查看回覆」，最多 3 秒），以及其中去掉轉址的連結 |
| **X / Twitter** | 把 `t.co` 短網址換成真正目標的推文（取自連結本身的 title，不會另外抓）、引用推文、卡片連結，以及作者自己串的討論串（作者後面的推文；別人的回覆不收） |
| **Instagram**（`/p/`、`/reel/`） | 說明（展開「更多」）、作者、前 20 則留言和其中的連結。個人簡介連結和限時動態連結貼紙不在貼文頁上，所以略過；「連結在留言」找得到 |

**安裝**

- **[Chrome 線上應用程式商店](https://chromewebstore.google.com/detail/driftnet/inmlinbodfopmanbllkkjcgheelacddm)**：一鍵安裝，自動更新。
- **用 zip**（[建置產物](https://github.com/KevinChu1110/driftnet/actions/workflows/extension.yml)，或 `pnpm build:extension` → `dist/driftnet-extension-<版本>.zip`）：解壓縮，開 `chrome://extensions` → 開發人員模式 → **載入未封裝項目** → 選解壓縮後的資料夾。
- **用原始碼**：同上，選 `apps/chrome-extension`。

預設連 `http://localhost:8787`；用遠端伺服器的話，到擴充的設定填網址和 token。只有你按下時才讀取該分頁，內容只送到你自己的伺服器。
見[隱私權政策](../../apps/chrome-extension/store/PRIVACY.md)。
