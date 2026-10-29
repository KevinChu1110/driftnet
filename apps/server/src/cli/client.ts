import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { driftnetHome } from "@driftnet/core";

export interface Connection {
  url: string;
  token?: string;
  /** Where settings come from (for `status`), if the file exists. */
  envFile?: string;
  /** The environment with ~/.driftnet/.env merged under it (shell wins). */
  env: NodeJS.ProcessEnv;
}

/** Real environment first, then DRIFTNET_HOME/.env: the same precedence the server uses. Never mutates `env`. */
export function mergedEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; envFile?: string } {
  const file = join(driftnetHome(env), ".env");
  if (!existsSync(file)) return { env: { ...env } };
  let fromFile: Record<string, string | undefined> = {};
  try { fromFile = parseEnv(readFileSync(file, "utf8")); } catch { /* unreadable: ignore */ }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(fromFile)) if (merged[k] === undefined && v !== undefined) merged[k] = v;
  return { env: merged, envFile: file };
}

/** URL: --url, DRIFTNET_URL, http://127.0.0.1:PORT. Token: --token, DRIFTNET_TOKEN. */
export function resolveConnection(flags: Record<string, string | boolean>, rawEnv: NodeJS.ProcessEnv): Connection {
  const { env, envFile } = mergedEnv(rawEnv);
  const flag = (n: string) => (typeof flags[n] === "string" ? (flags[n] as string) : undefined);
  const url = (flag("url") || env.DRIFTNET_URL || `http://127.0.0.1:${env.PORT || 8787}`).replace(/\/+$/, "");
  const token = flag("token") || env.DRIFTNET_TOKEN || undefined;
  return { url, ...(token ? { token } : {}), ...(envFile ? { envFile } : {}), env };
}

/** No server answered (refused, timed out, DNS): the signal to fall back or say how to start one. */
export class ServerDown extends Error {}
/** The server answered with an error status. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface Reply { status: number; headers: Headers; text: string; bytes: Uint8Array }

export async function call(
  conn: Connection, fetchFn: typeof fetch, method: string, path: string,
  opts: { json?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<Reply> {
  let res: Response;
  try {
    res = await fetchFn(conn.url + path, {
      method,
      headers: {
        "X-Driftnet-Agent": "cli",
        ...opts.headers,
        ...(conn.token ? { Authorization: `Bearer ${conn.token}` } : {}),
        ...(opts.json !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (err) {
    throw new ServerDown(err instanceof Error ? err.message : String(err));
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder().decode(bytes) };
}

export function errorOf(r: Reply): string {
  try {
    const e = (JSON.parse(r.text) as { error?: unknown }).error;
    if (typeof e === "string" && e) return e;
  } catch { /* not JSON */ }
  if (r.status === 401 || r.status === 403) return "the server refused the password (set DRIFTNET_TOKEN or pass --token)";
  return `server answered ${r.status}`;
}

/** The body as JSON, or an HttpError carrying the server's own message. */
export function ok<T>(r: Reply, accept: number[] = [200]): T {
  if (!accept.includes(r.status)) throw new HttpError(r.status, errorOf(r));
  return JSON.parse(r.text) as T;
}
