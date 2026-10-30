#!/usr/bin/env node
// `npx driftnet` — one command, no clone: the web page, chat bots and MCP.
const [cmd = "start"] = process.argv.slice(2);
// The npm build injects the version; from source, read it from package.json.
const VERSION = process.env.DRIFTNET_VERSION ?? await import("node:fs").then((fs) => {
  try { return (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version; } catch { return "dev"; }
});

const rest = process.argv.slice(3);
const SUBCOMMANDS = ["add", "search", "open", "export", "import", "completion", "status", "init", "backup", "restore", "service"];

const wantsHelp = rest.some((a) => a === "--help" || a === "-h");
if (cmd === "start") await import("./main.ts");
else if (cmd === "mcp") await import("./mcp-stdio.ts");
else if (SUBCOMMANDS.includes(cmd) && !wantsHelp) {
  const { HANDLERS, realCtx } = await import("./cli/commands.ts");
  process.exitCode = await HANDLERS[cmd]!(realCtx(), rest);
} else if (cmd === "--version" || cmd === "-v") console.log(VERSION);
else {
  const known = cmd === "help" || cmd === "--help" || cmd === "-h" || SUBCOMMANDS.includes(cmd);
  const home = process.env.DRIFTNET_HOME || "~/.driftnet";
  const help = `driftnet ${VERSION} — drop links into any chat; get them sorted, explained and searchable.

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
  driftnet backup [-o file] [--secrets]  zip of your whole catalogue (secrets left out unless --secrets + --token)
  driftnet restore <file> [--print-settings]  put a backup back (only while driftnet is stopped; the old data is kept)
  driftnet status                       is it running, how many links, where the data lives
  driftnet completion bash|zsh          print a shell completion script
  driftnet init [--client claude-code|claude-desktop|cursor|windsurf|codex|all] [--remote URL --token T] [--yes] [--dry-run]
                                        connect your agents (MCP + skill) in one command
  driftnet service install|uninstall|status [--dry-run]
                                        start driftnet at login (macOS, Linux, Windows), no terminal window needed
  Options for all of them: --url <server>  --token <password>   (or DRIFTNET_URL / DRIFTNET_TOKEN)

Environment:
  PORT             port for the web page (default 8787)
  DRIFTNET_HOME    where settings and data live (default ~/.driftnet)
  DRIFTNET_OPEN=0  don't open the browser on first start

Settings: ${home}/.env, or ⚙ Settings on the page. Data: ${home}/driftnet.db.
Docs: https://github.com/KevinChu1110/driftnet/blob/main/docs/cli.md`;
  if (SUBCOMMANDS.includes(cmd)) {
    // `driftnet add --help`: just that command's lines.
    const lines = help.split("\n");
    const at = lines.findIndex((l) => l.trimStart().startsWith(`driftnet ${cmd} `) || l.trim() === `driftnet ${cmd}`);
    let end = at + 1;
    while (end < lines.length && /^\s{10,}\S/.test(lines[end]!)) end++;
    console.log(`usage:\n${lines.slice(at, end).join("\n")}`);
    if (cmd === "init") console.log("\n  It edits each agent's MCP config file; try --dry-run first to see what would change.");
    if (cmd === "service") console.log("\n  install also updates: `npx driftnet@latest service install`. --dry-run prints what would be written and run.");
    if (cmd !== "service") console.log("\n  Options for all commands: --url <server>  --token <password>   (or DRIFTNET_URL / DRIFTNET_TOKEN)");
  } else if (known) console.log(help);
  else {
    const near = [...SUBCOMMANDS, "mcp", "start"].map((c) => [c, distance(c, cmd)] as const).sort((a, b) => a[1] - b[1])[0]!;
    console.error(`driftnet: unknown command "${cmd}".${near[1] <= 2 ? ` Did you mean "${near[0]}"?` : ""} Run \`driftnet --help\` for the list.`);
    process.exitCode = 1;
  }
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length]![b.length]!;
}
