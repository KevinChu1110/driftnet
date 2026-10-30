[← driftnet](../../README.zh-TW.md) · [English](../stability.md) · **繁體中文**

# 1.0 起保持穩定的部分

從 1.0.0 開始，driftnet 遵循[語意化版本](https://semver.org/lang/zh-TW/)。在 1.x 之內升級，
你的設定、agent 和腳本都不用改。下面列的東西如果非改不可，會等到 2.0，而且舊的用法會先在至少一個
1.x 版本裡繼續可用（並顯示提醒）。

## 保持穩定

| 項目 | 承諾 |
|---|---|
| **你的資料** | `driftnet.db` 啟動時會先備份一份（`VACUUM INTO`）再自動升級。新版一定能打開舊版的資料庫。匯出（`GET /api/export`、Markdown、vault）的格式不變。 |
| **設定** | [設定](settings.md)裡的每個變數名稱和意思都不變。新增的設定會有預設值，維持現在的行為。 |
| **MCP 工具** | 15 個工具名稱不變：`search_items`、`get_item`、`save_link`、`lease_items`、`enrich_item`、`refresh_item`、`update_item`、`list_folders`、`move_items`、`undo_move`、`suggest_folders`、`create_folder`、`update_folder`、`delete_folder`、`delete_item`。既有參數的意思不變，新參數都是選填。回傳內容可能多出欄位。 |
| **HTTP API** | `/openapi.json` 列出的路由、權限規則和回應。回應可能多出欄位，但不會刪除或改名。 |
| **指令列** | [指令列](cli.md)裡的 `driftnet` 指令和參數、結束代碼（0 成功、1 失敗、2 用法錯誤）和 `--json` 輸出。給人看的純文字輸出可能調整。 |
| **Webhook** | 事件 `item.added`、`item.updated`、`item.trashed`、`item.restored`、`digest.sent`，以及內容欄位和簽章標頭。 |
| **外掛** | `registerExtractor`、`registerProvider`、`registerJudge`，以及 `~/.driftnet/plugins` 的外掛檔案格式。 |
| **聊天指令** | 投票（`👍12`、`👎12 原因`、`+#12`、`-#12`）和用表情符號投票。 |

## 不在承諾範圍內

- 網頁的外觀和按鈕位置。
- 摘要、聊天回覆和記錄訊息的用字。
- 上面沒列到的內部模組，以及文件裡標為「實驗性」的功能。
- 預設由哪個模型回答，以及送給模型的提示詞。

安全性修正可能隨時改變行為，版本說明會寫清楚。
