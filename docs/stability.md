[← driftnet](../README.md) · **English** · [繁體中文](zh-TW/stability.md)

# What stays stable from 1.0

From 1.0.0 driftnet follows [semantic versioning](https://semver.org). Upgrading within 1.x never
needs you to change your setup, your agents or your scripts. If something below has to change, it
waits for 2.0, and the old way keeps working (with a warning) for at least one 1.x release first.

## Stable

| What | Promise |
|---|---|
| **Your data** | `driftnet.db` upgrades itself on start, after a backup copy (`VACUUM INTO`). A newer driftnet always opens an older database. Export (`GET /api/export`, Markdown, vault) keeps its shape. |
| **Settings** | Every variable in [Settings](settings.md) keeps its name and meaning. New ones are added with a default that keeps today's behaviour. |
| **MCP tools** | The 15 tool names stay: `search_items`, `get_item`, `save_link`, `lease_items`, `enrich_item`, `refresh_item`, `update_item`, `list_folders`, `move_items`, `undo_move`, `suggest_folders`, `create_folder`, `update_folder`, `delete_folder`, `delete_item`. Existing parameters keep their meaning; new ones are optional. Output may gain fields. |
| **HTTP API** | The routes in `/openapi.json`, their auth rules and their responses. Responses may gain fields; nothing is removed or renamed. |
| **Command line** | `driftnet` commands and flags in [Command line](cli.md), their exit codes (0 ok, 1 failed, 2 wrong usage) and `--json` output. Plain-text output is for people and may change. |
| **Webhook** | Events `item.added`, `item.updated`, `item.trashed`, `item.restored`, `digest.sent`, the payload fields and the signature header. |
| **Plugins** | `registerExtractor`, `registerProvider` and `registerJudge`, and the plugin file format in `~/.driftnet/plugins`. |
| **Chat commands** | Votes (`👍12`, `👎12 reason`, `+#12`, `-#12`) and reaction voting. |

## Not covered

- How the web page looks and where its buttons are.
- The wording of summaries, chat replies and log lines.
- Internal modules not listed above, and anything marked *experimental* in the docs.
- Which model answers by default, and the prompts sent to it.

Security fixes may change behaviour at any time; the release notes say so.
