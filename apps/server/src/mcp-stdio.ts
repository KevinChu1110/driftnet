import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDriftnet, loadHomeEnv, loadPlugins } from "@driftnet/core";
import { createMcpServer } from "./mcp.ts";

// Local MCP for agents on the same machine (Claude Code, pi, Hermes…).
// stdout is the protocol channel, so route logs to stderr.
console.log = console.error;
loadHomeEnv();
await loadPlugins();
const dn = createDriftnet();
for (const w of dn.warnings) console.error(`⚠️  ${w}`);
await createMcpServer(dn, process.env.DRIFTNET_AGENT ?? "local").connect(new StdioServerTransport());
