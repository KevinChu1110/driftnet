#!/usr/bin/env node
// `npx driftnet` — one command, no clone: the web page, chat bots and MCP.
const [cmd = "start"] = process.argv.slice(2);
const VERSION = process.env.DRIFTNET_VERSION ?? "dev";

const rest = process.argv.slice(3);
const SUBCOMMANDS = ["add", "search", "open", "export", "import", "completion", "status"];

if (cmd === "start") await import("./main.ts");
else if (cmd === "mcp") await import("./mcp-stdio.ts");
else if (SUBCOMMANDS.includes(cmd) && !rest.some((a) => a === "--help" || a === "-h")) {
  const { HANDLERS, realCtx } = await import("./cli/commands.ts");
  process.exitCode = await HANDLERS[cmd]!(realCtx(), rest);
} else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else {
  const known = cmd === "help" || cmd === "--help" || cmd === "-h" || SUBCOMMANDS.includes(cmd);
  if (!known) console.log(`unknown command "${cmd}"\n`);
  console.log(`driftnet ${VERSION} — drop links into any chat; get them sorted, explained and searchable.

  npx driftnet            start the web page (http://localhost:8787) and any chat bots you set up
  npx driftnet mcp        run as a local MCP server for agents (Claude Code, pi, Hermes…)
  npx driftnet --version  print the version (also -v)

Commands (talk to a running driftnet; search and export also read the database directly when none runs):
  driftnet add <url> [--note "…"]       save a link
  driftnet search [query…] [--folder id] [--kind repo|product|video|article|post|other]
                  [--view inbox|favorites|trash] [--limit N] [--json]
  driftnet open [id]                    open the web page (or one card) in the browser
  driftnet export [--format json|md|vault] [-o file]   (vault is a zip: needs -o)
  driftnet import <file|pack link> [--keep-folders] [--yes]  import bookmarks or a pack
  driftnet status                       is it running, how many links, where the data lives
  driftnet completion bash|zsh          print a shell completion script
  Options for all of them: --url <server>  --token <password>   (or DRIFTNET_URL / DRIFTNET_TOKEN)

Press Ctrl+C to stop.

Environment:
  PORT             port for the web page (default 8787)
  DRIFTNET_HOME    where settings and data live (default ~/.driftnet)
  DRIFTNET_OPEN=0  don't open the browser on first start

Settings: ~/.driftnet/.env, or ⚙ Settings on the page. Data: ~/.driftnet/driftnet.db.
Docs: https://github.com/KevinChu1110/driftnet`);
  if (!known) process.exitCode = 1;
}
