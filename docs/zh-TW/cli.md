[← driftnet](../../README.zh-TW.md) · [English](../cli.md) · **繁體中文**

# 指令列

driftnet 在跑的時候（`npx driftnet`），同一個指令就能跟它說話。`search`、`export` 和 `backup` 在它沒開時也能用（直接讀 `~/.driftnet/driftnet.db`）；`restore` 只能在它「沒開」時用；`add` 和 `import` 需要它在跑。

| 指令 | 範例 |
|---|---|
| `driftnet add <url> [--note "…"]` | `npx driftnet add https://github.com/acme/widget --note "demo 要用"` |
| `driftnet search [關鍵字…] [--folder id] [--kind …] [--view inbox\|favorites\|trash] [--limit N] [--json]` | `npx driftnet search 向量資料庫 --kind repo --limit 5` |
| `driftnet open [id]` | `npx driftnet open 12` |
| `driftnet export [--format json\|md\|vault] [-o 檔案]` | `npx driftnet export --format vault -o links.zip` |
| `driftnet import <檔案或資料夾包連結> [--keep-folders] [--yes]` | `npx driftnet import bookmarks.html --keep-folders` |
| `driftnet backup [-o file] [--secrets]` | `npx driftnet backup -o driftnet.zip` |
| `driftnet restore <file> [--print-settings]` | `npx driftnet restore driftnet.zip` |
| `driftnet status`（有新版也會告訴你） | `npx driftnet status` |
| `driftnet completion bash\|zsh` | `eval "$(driftnet completion zsh)"` |
| `driftnet init [--client claude-code\|claude-desktop\|cursor\|windsurf\|codex\|all] [--remote URL --token T] [--yes] [--dry-run]` | `npx driftnet init --yes` |
| `driftnet service install\|uninstall\|status [--dry-run]` | `npx driftnet service install` |

連到別台機器：加 `--url http://host:8787 --token <密碼>`（或設 `DRIFTNET_URL`、`DRIFTNET_TOKEN`；密碼也會從 `~/.driftnet/.env` 讀）。

## 開機（登入）自動啟動

`npx driftnet service install` 讓 driftnet 在你每次登入時自己啟動，不用開著終端機視窗：

- **macOS：** LaunchAgent，`~/Library/LaunchAgents/io.github.kevinchu1110.driftnet.plist`（當掉會自動重開，最快 10 秒一次）。
- **Linux：** systemd 使用者服務，`~/.config/systemd/user/driftnet.service`。想在沒人登入時也繼續跑（伺服器），執行一次 `loginctl enable-linger $USER`。
- **Windows：** 「啟動」資料夾裡一個隱藏視窗的腳本（`driftnet.vbs`）。不用排程工作，因為建立登入時執行的排程要系統管理員權限，「啟動」資料夾不用。*實驗性*：目前只有自動測試，還沒在真的 Windows 電腦上跑過，用了請[回報](https://github.com/KevinChu1110/driftnet/issues)結果。

服務跑的是什麼：用 npm 在 `~/.driftnet/service/` 裝一份同版本的 driftnet，再用你執行指令時的那個 `node` 啟動它。不直接跑 `npx driftnet`，因為 npx 的快取隨時可能被清掉，登入時重新下載要有網路（還可能抓到別的版本）；也不用全域安裝，因為那可能要 `sudo`。整個過程都不需要 `sudo` 或系統管理員。

- 記錄檔在 `~/.driftnet/logs/driftnet.log`。服務不會自己開瀏覽器，請自己打開 http://localhost:8787。
- 安裝時如果有設 `DRIFTNET_HOME`、`PORT`，會一併帶給服務。
- `npx driftnet service status` 會告訴你有沒有裝、有沒有在跑、跑的是什麼指令、記錄檔在哪，以及那個連接埠是不是已經有東西在用。
- 加 `--dry-run` 會把要寫的檔案和要執行的指令完整印出來，什麼都不改。
- 更新：`npx driftnet@latest service install`（重裝會整個取代）。移除：`npx driftnet service uninstall`（連結和設定都會留著）。
- 更新或重裝 Node.js 之後，再執行一次 `service install`，讓服務指向新的 `node`。

