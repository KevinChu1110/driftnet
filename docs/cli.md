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
| `driftnet service install\|uninstall\|status [--dry-run]` | `npx driftnet service install` |

For a server elsewhere, add `--url http://host:8787 --token <password>` (or set `DRIFTNET_URL` and `DRIFTNET_TOKEN`; the password is also read from `~/.driftnet/.env`).

## Start at login

`npx driftnet service install` makes driftnet start by itself whenever you log in, with no terminal window:

- **macOS:** a LaunchAgent, `~/Library/LaunchAgents/io.github.kevinchu1110.driftnet.plist` (restarted after a crash, at most every 10 s).
- **Linux:** a systemd user unit, `~/.config/systemd/user/driftnet.service`. To keep it running when nobody is logged in (a server), run `loginctl enable-linger $USER` once.
- **Windows:** a hidden script in your Startup folder (`driftnet.vbs`). Not a scheduled task: making a logon task needs an administrator prompt, the Startup folder does not. *Experimental:* tested by the test suite, not yet on a real Windows machine; please [report](https://github.com/KevinChu1110/driftnet/issues) how it goes.

What the service runs: a private copy of the same driftnet version, installed with npm into `~/.driftnet/service/` and started with the `node` you ran the command with. Not `npx driftnet` itself, because npx's cache can be cleaned at any time and fetching again at login needs the network (and might pick up another version); not a global install, which can need `sudo`. Nothing here needs `sudo` or an administrator.

- Logs go to `~/.driftnet/logs/driftnet.log`. The service never opens a browser; open http://localhost:8787 yourself.
- `DRIFTNET_HOME` and `PORT`, if set when you install, are passed to the service.
- `npx driftnet service status` says whether it is installed and running, what it runs, where the logs are, and whether something already listens on the port.
- `--dry-run` prints exactly what would be written and run, and changes nothing.
- Update: `npx driftnet@latest service install` (installing again replaces everything). Remove: `npx driftnet service uninstall` (your links and settings stay).
- If you update or reinstall Node.js, run `service install` again so the service points at the new `node`.

