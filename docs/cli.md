[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/cli.md)

# Command line

With driftnet running (`npx driftnet`), the same command talks to it. `search`, `export` and `backup` also work when it is not running (they read `~/.driftnet/driftnet.db` directly); `restore` only works when it is *not* running; `add` and `import` need it running.

| Command | Example |
|---|---|
| `driftnet add <url> [--note "…"]` | `npx driftnet add https://github.com/acme/widget --note "for the demo"` |
| `driftnet search [query…] [--folder id] [--kind …] [--view inbox\|favorites\|trash] [--limit N] [--json]` | `npx driftnet search vector database --kind repo --limit 5` |
| `driftnet open [id]` | `npx driftnet open 12` |
| `driftnet export [--format json\|md\|vault] [-o file]` | `npx driftnet export --format vault -o links.zip` |
| `driftnet import <file or pack link> [--keep-folders] [--yes]` | `npx driftnet import bookmarks.html --keep-folders` |
| `driftnet backup [-o file] [--secrets]` | `npx driftnet backup -o driftnet.zip` |
| `driftnet restore <file> [--print-settings]` | `npx driftnet restore driftnet.zip` |
| `driftnet status` (also says when a newer version is out) | `npx driftnet status` |
| `driftnet completion bash\|zsh` | `eval "$(driftnet completion zsh)"` |
| `driftnet init [--client claude-code\|claude-desktop\|cursor\|windsurf\|codex\|all] [--remote URL --token T] [--yes] [--dry-run]` | `npx driftnet init --yes` |

For a server elsewhere, add `--url http://host:8787 --token <password>` (or set `DRIFTNET_URL` and `DRIFTNET_TOKEN`; the password is also read from `~/.driftnet/.env`).
