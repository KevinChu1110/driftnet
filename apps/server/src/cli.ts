#!/usr/bin/env node
// `npx driftnet` — one command, no clone: the web page, chat bots and MCP.
const [cmd = "start"] = process.argv.slice(2);
const VERSION = process.env.DRIFTNET_VERSION ?? "dev";

if (cmd === "start") await import("./main.ts");
else if (cmd === "mcp") await import("./mcp-stdio.ts");
else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else {
  console.log(`driftnet ${VERSION} — drop links into any chat; get them sorted, explained and searchable.

  npx driftnet          start the web page (http://localhost:8787) and any chat bots you set up
  npx driftnet mcp      run as a local MCP server for agents (Claude Code, pi, Hermes…)

Settings: ~/.driftnet/.env, or ⚙ Settings on the page. Data: ~/.driftnet/driftnet.db.
Docs: https://github.com/KevinChu1110/driftnet`);
  if (cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
}
