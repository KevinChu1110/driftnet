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

連到別台機器：加 `--url http://host:8787 --token <密碼>`（或設 `DRIFTNET_URL`、`DRIFTNET_TOKEN`；密碼也會從 `~/.driftnet/.env` 讀）。
