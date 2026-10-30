[← driftnet](README.zh-TW.md) · [English](CONTRIBUTING.md) · **繁體中文**

# 參與開發

```text
packages/core          流程、擷取器、大綱、判斷、摘要＋模型轉接、防污染、儲存
apps/server            HTTP API、網頁、MCP、聊天平台轉接
apps/chrome-extension  送出你登入後看到的內容
skills/driftnet        Agent Skill
assets · scripts       logo、主視覺、服務安裝
```

```bash
pnpm typecheck && pnpm test
CHROME=/path/to/chromium pnpm e2e:extension   # 在真的瀏覽器裡測擴充（Chrome for Testing 或 Chromium）
CHROME=/path/to/chrome pnpm e2e:web             # 用手機尺寸和真的觸控滑動測網頁
pnpm build:npm                                  # 打包 npm 套件到 dist/npm（試用：cd dist/npm && npm pack）
pnpm demo -- --many --private --password demo-pass-123 --read-key demo-share-key-0000   # 開一個帶示範資料的臨時 driftnet
```

發新版：改 `apps/server/package.json`、`server.json` 和 `.claude-plugin/` 裡的版號，再推一個標籤
（`git tag v0.2.0 && git push origin v0.2.0`）。[`release.yml`](.github/workflows/release.yml) 會跑完測試，發到 npm（受信任發佈）
和 MCP Registry，並建立 GitHub Release，不需要任何密碼或驗證碼。

可以擴充：網站（放一個外掛檔到 `~/.driftnet/plugins`，像
[`examples/plugins/hackernews.mjs`](examples/plugins/hackernews.mjs)，或用 `registerExtractor()`）、模型（`LlmProvider`）、判斷器（`Judge`）、聊天平台（`handleChatText()`）、
瀏覽器擷取（`collect.js`）、bot 介面語言（`i18n.ts`）。

**想幫忙？** 到 GitHub 找標著 [`good first issue`](https://github.com/KevinChu1110/driftnet/labels/good%20first%20issue) 的題目，或開一個 issue，
附上 driftnet 處理得不好的連結：這裡每個功能，都是拿大家真正會分享的連結實測後發現的。
