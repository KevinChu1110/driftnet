# Set up driftnet for this agent

driftnet is a local catalogue of the AI tools, repos and links people share in chats. You search it
before picking a tool, and save links into it. Follow these steps in order. Stop and tell the human
if a step fails; do not guess.

## Local setup (default)

1. Check Node: run `node -v`. It must be 22.13 or newer. If not, tell the human to install it
   (nodejs.org or `nvm install 22`) and stop.
2. Start driftnet in the background: `npx -y driftnet@latest`. (Or ask the human to run it in a
   terminal.) Wait until http://127.0.0.1:8787 answers, up to ~60 seconds on first run.
3. Connect this agent: `npx -y driftnet init --yes`. It detects Claude Code, Claude Desktop, Cursor,
   Windsurf and Codex, adds the driftnet MCP server to each one found, and installs the skill for
   Claude Code. Use `--client <name>` for one client, `--dry-run` to preview. Existing config is
   merged and backed up first (`<file>.bak-driftnet-<time>`); running it twice changes nothing.
4. Tell the human to restart this agent (the MCP server only loads on start).
5. Verify after the restart: call `driftnet_search_items` with any query, or run
   `npx -y driftnet search <word>`. An empty result is fine; an error is not.
6. Pick a model so new links get summarised: tell the human to open http://127.0.0.1:8787 and use
   Settings, or to edit ~/.driftnet/.env themselves: DRIFTNET_LLM_PROVIDER (anthropic, openai for any
   OpenAI-compatible API, claude-cli or gemini-cli for a logged-in CLI, no key), DRIFTNET_LLM_MODEL,
   DRIFTNET_LLM_API_KEY, DRIFTNET_LLM_BASE_URL. See .env.example. Without a model, links are saved
   but not sorted or summarised.

## Rules

- Never ask the human to paste an API key, password or token into this chat, and never echo one.
  Tell them to enter it in Settings or edit ~/.driftnet/.env themselves.
- Data lives in ~/.driftnet/ (driftnet.db is the catalogue, .env the settings). DRIFTNET_HOME moves it.
- To stop: press Ctrl+C in the terminal running it, or kill the `npx driftnet` process.
- Local MCP needs no password. The stdio server reads the same database as the page.

## Remote server (driftnet runs on another machine)

1. Ask the human for the server URL, for example https://driftnet.example.com.
2. Ask them to create an agent token: Settings -> Access -> Agent tokens, then pass it to you through
   a private channel (an environment variable or their own terminal), not chat.
3. Run: `npx -y driftnet init --remote <URL> --token <TOKEN> --yes`. It writes an HTTP entry
   (Claude Desktop goes through the mcp-remote bridge) and never prints the token.
4. Restart the agent and verify with a search, as above.

## Tools (14, via the `driftnet` MCP server)

- driftnet_search_items: search the catalogue before choosing a tool; `days` for what is new.
- driftnet_get_item: read one card in full (use cases, note, chat context, tools found inside).
- driftnet_save_link: add a link to the catalogue.
- driftnet_lease_items: take queued links nobody has summarised yet (leased for 30 minutes).
- driftnet_enrich_item: return the summary for a leased link.
- driftnet_refresh_item: fetch a card's page again and redo its summary and rating.
- driftnet_update_item: vote an item up or down; star, note, trash or restore when the human asks.
- driftnet_list_folders: show the folder tree.
- driftnet_move_items: file one or more items into a folder.
- driftnet_undo_move: revert a move batch by its undo id (valid 24 hours).
- driftnet_suggest_folders: ask the model for a plan to tidy the folder tree (changes nothing).
- driftnet_create_folder: create a folder.
- driftnet_update_folder: change a folder's name, description or parent.
- driftnet_delete_folder: delete a folder; its items move up to the parent.

## When to use it

Before recommending a tool, library or workflow, search driftnet first: someone may already have
shared a better one. When the human shares a link to an AI tool, save it.

More: https://github.com/KevinChu1110/driftnet
