import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { strictJsonSchema } from "./openai.ts";
import { IncompleteOutput, parseStructured, type LlmProvider, type StructuredRequest } from "./types.ts";

export type CliKind = "claude" | "gemini";

export interface CliOptions {
  kind: CliKind;
  /** Model alias for the CLI (claude: "haiku", "sonnet"…; gemini: "gemini-3.5-flash-lite"…). */
  model?: string;
  /** claude only: --effort. */
  effort?: string;
  /** Path to the binary, if it is not on PATH as `claude` / `gemini`. */
  bin?: string;
  timeoutMs?: number;
  /** How many CLI processes may run at once. */
  concurrency?: number;
}

/**
 * Uses a coding CLI you are already logged in to — Claude Code or Gemini CLI —
 * so summaries run on your subscription instead of an API key. Only works on a
 * machine where that CLI is installed and logged in.
 *
 * Shared links are untrusted, so the CLI runs as a bare text model:
 *   - claude: no tools (--tools ""), no settings, hooks, MCP servers or CLAUDE.md
 *     (--setting-sources "", --strict-mcp-config), nothing saved to history
 *   - gemini: every tool excluded through a system-level settings file, no
 *     extensions, read-only approval mode, own system prompt (GEMINI_SYSTEM_MD)
 *   - both: run in an empty private directory, with driftnet's own secrets and
 *     the vendor API-key variables removed from the environment, so the CLI uses
 *     its login rather than silently switching to API billing
 */
export class CliProvider implements LlmProvider {
  readonly label: string;
  private readonly workdir = mkdtempSync(join(tmpdir(), "driftnet-cli-"));
  private readonly queue: Semaphore;

  constructor(private readonly opts: CliOptions) {
    this.label = `${opts.kind}-cli${opts.model ? `:${opts.model}` : ""}`;
    this.queue = new Semaphore(opts.concurrency ?? 1);
    if (opts.kind === "gemini") {
      writeFileSync(join(this.workdir, "gemini-settings.json"), JSON.stringify(GEMINI_LOCKDOWN));
    }
  }

  complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    return this.queue.run(() => (this.opts.kind === "claude" ? this.claude(req) : this.gemini(req)));
  }

  private async claude<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const args = [
      "-p", req.user,
      "--system-prompt", req.system,
      "--output-format", "json",
      "--json-schema", JSON.stringify(strictJsonSchema(req.schema)),
      "--tools", "",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--model", this.opts.model ?? "haiku",
      ...(this.opts.effort ? ["--effort", this.opts.effort] : []),
    ];
    const run = await this.exec(this.opts.bin ?? "claude", args, {});
    const out = lastJsonObject(run.stdout) as
      | { is_error?: boolean; result?: string; structured_output?: unknown; subtype?: string; api_error_status?: number }
      | undefined;
    if (!out) throw new Error(`claude exited ${run.code}: ${tail(run.stderr || run.stdout)}`);
    // Usage limits and auth problems will not fix themselves on a retry.
    if (out.is_error) throw new Error(`claude: ${out.subtype ?? "error"}${out.api_error_status ? ` (HTTP ${out.api_error_status})` : ""}: ${tail(out.result ?? "")}`);
    if (out.structured_output !== undefined) return parseStructured(req.schema, JSON.stringify(out.structured_output));
    if (typeof out.result === "string") return parseStructured(req.schema, out.result);
    throw new IncompleteOutput("claude returned no result");
  }

  private async gemini<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    // Gemini CLI has no schema flag: put the schema in the system prompt and
    // validate the reply ourselves.
    const system = `${req.system}\n\nReply with a single JSON object, no code fence, matching this JSON Schema:\n${JSON.stringify(strictJsonSchema(req.schema))}`;
    const args = [
      "-p", req.user,
      "-o", "json",
      "--approval-mode", "plan",
      "-e", "none",
      "--skip-trust",
      ...(this.opts.model ? ["-m", this.opts.model] : []),
    ];
    const run = await this.exec(this.opts.bin ?? "gemini", args, {
      GEMINI_SYSTEM_MD: this.systemFile(system),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(this.workdir, "gemini-settings.json"),
    });
    const out = lastJsonObject(run.stdout) as { response?: string; error?: { message?: string } } | undefined;
    if (out?.error || !out) {
      const err = (lastJsonObject(run.stderr) as { error?: { message?: string } } | undefined)?.error;
      throw new Error(`gemini exited ${run.code}: ${tail(out?.error?.message ?? err?.message ?? run.stderr)}`);
    }
    if (typeof out.response !== "string" || !out.response.trim()) throw new IncompleteOutput("gemini returned an empty response");
    return parseStructured(req.schema, out.response);
  }

  /** System prompts are stable per schema, so write each one once. */
  private systemFile(content: string): string {
    const path = join(this.workdir, `system-${createHash("sha1").update(content).digest("hex").slice(0, 12)}.md`);
    writeFileSync(path, content);
    return path;
  }

  private exec(bin: string, args: string[], extraEnv: Record<string, string>) {
    return run(bin, args, {
      cwd: this.workdir,
      env: { ...childEnv(this.opts.kind), ...extraEnv },
      timeoutMs: this.opts.timeoutMs ?? 120_000,
    });
  }
}

/** Every built-in tool off; nothing a hostile post could ask the model to use. */
const GEMINI_LOCKDOWN = {
  tools: {
    exclude: [
      "read_file", "read_many_files", "list_directory", "glob", "grep_search", "search_file_content",
      "google_web_search", "web_fetch", "run_shell_command", "write_file", "replace", "save_memory",
      "write_todos", "invoke_agent", "codebase_investigator",
    ],
  },
  mcpServers: {},
};

/** driftnet's own secrets never reach the child; neither do vendor API keys (see class doc). */
function childEnv(kind: CliKind): NodeJS.ProcessEnv {
  const drop = /^(DRIFTNET_|TYPESAFE_|TELEGRAM_|DISCORD_|LINE_|SLACK_|GITHUB_TOKEN$)/;
  const vendor = kind === "claude" ? /^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/ : /^(GEMINI_API_KEY|GOOGLE_API_KEY)$/;
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.test(k) && !vendor.test(k)));
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // No shell: the prompt is an argument, never interpreted.
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { if (stdout.length < 5_000_000) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 200_000) stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} timed out after ${opts.timeoutMs} ms`));
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`${bin} not found — is it installed and on PATH?`) : err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** CLIs print warnings before their JSON; take the last top-level JSON object. */
function lastJsonObject(text: string): unknown {
  for (let i = text.lastIndexOf("\n{"); i >= -1; i = text.lastIndexOf("\n{", i - 1)) {
    try {
      return JSON.parse(text.slice(i + 1));
    } catch {
      if (i < 0) break;
    }
  }
  const first = text.indexOf("{");
  if (first < 0) return undefined;
  try {
    return JSON.parse(text.slice(first));
  } catch {
    return undefined;
  }
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > 300 ? "…" + t.slice(-300) : t;
}

class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async run<R>(fn: () => Promise<R>): Promise<R> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
