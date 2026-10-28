import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Everything a local install keeps lives in one folder: ~/.driftnet (or
 * DRIFTNET_HOME). Running from a checkout, a service or an MCP client all find
 * the same settings and the same database.
 */
export function driftnetHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DRIFTNET_HOME ?? join(homedir(), ".driftnet");
}

/**
 * Load DRIFTNET_HOME/.env into `env`. Variables already set win, so a shell
 * export or a service's EnvironmentFile can override the file.
 */
export function loadHomeEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = join(driftnetHome(env), ".env");
  if (!existsSync(file)) return undefined;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (env[key] === undefined && value !== undefined) env[key] = value;
  }
  return file;
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = driftnetHome(env);
  mkdirSync(home, { recursive: true });
  return join(home, "driftnet.db");
}
