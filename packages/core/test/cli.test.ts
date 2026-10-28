import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { CliProvider } from "../src/llm/cli.ts";
import { IncompleteOutput } from "../src/llm/types.ts";

const dir = mkdtempSync(join(tmpdir(), "driftnet-cli-test-"));
const schema = z.object({ name: z.string() });
const req = { system: "SYS", user: "USER", schema, schemaName: "t", maxTokens: 10 };

/** A fake CLI that records how it was called and prints `stdout`. */
function fakeCli(name: string, stdout: string, exitCode = 0): { bin: string; calls: () => any } {
  const log = join(dir, `${name}.log`);
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const env = process.env;
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  env: Object.keys(env).filter((k) => /^(ANTHROPIC_|DRIFTNET_|GEMINI_|TELEGRAM_)/.test(k)),
  systemMd: env.GEMINI_SYSTEM_MD ? fs.readFileSync(env.GEMINI_SYSTEM_MD, "utf8") : null,
  settings: env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ? JSON.parse(fs.readFileSync(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, "utf8")) : null,
}));
process.stdout.write(${JSON.stringify(stdout)});
process.exit(${exitCode});
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => JSON.parse(readFileSync(log, "utf8")) };
}

test("claude-cli runs without tools, settings or vendor keys, and reads structured_output", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  process.env.DRIFTNET_TOKEN = "secret";
  process.env.TELEGRAM_BOT_TOKEN = "secret";
  try {
    const cli = fakeCli("claude", JSON.stringify({ is_error: false, result: "", structured_output: { name: "ascii-sharks" } }));
    const out = await new CliProvider({ kind: "claude", bin: cli.bin }).complete(req);
    assert.deepEqual(out, { name: "ascii-sharks" });
    const call = cli.calls();
    const arg = (flag: string) => call.args[call.args.indexOf(flag) + 1];
    assert.equal(arg("-p"), "USER");
    assert.equal(arg("--system-prompt"), "SYS");
    assert.equal(arg("--tools"), "");
    assert.equal(arg("--setting-sources"), "");
    assert.equal(arg("--model"), "haiku");
    assert.ok(call.args.includes("--strict-mcp-config"));
    assert.equal(JSON.parse(arg("--json-schema")).additionalProperties, false);
    assert.deepEqual(call.env, []);
    assert.match(call.cwd, /driftnet-cli-/);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DRIFTNET_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test("claude-cli errors (usage limit, auth) are not retryable", async () => {
  const cli = fakeCli("claude-err", JSON.stringify({ is_error: true, subtype: "error", api_error_status: 429, result: "usage limit reached" }));
  const err = await new CliProvider({ kind: "claude", bin: cli.bin }).complete(req).catch((e) => e);
  assert.ok(err instanceof Error && !(err instanceof IncompleteOutput));
  assert.match(err.message, /429/);
});

test("gemini-cli locks tools down, sends its own system prompt and parses noisy output", async () => {
  const noisy = 'Ripgrep is not available. Falling back to GrepTool.\n' +
    JSON.stringify({ session_id: "x", response: '```json\n{"name": "paperclip"}\n```', stats: {} }, null, 2);
  const cli = fakeCli("gemini", noisy);
  const out = await new CliProvider({ kind: "gemini", bin: cli.bin, model: "gemini-3.5-flash-lite" }).complete(req);
  assert.deepEqual(out, { name: "paperclip" });
  const call = cli.calls();
  assert.ok(call.args.includes("--skip-trust"));
  assert.equal(call.args[call.args.indexOf("--approval-mode") + 1], "plan");
  assert.equal(call.args[call.args.indexOf("-e") + 1], "none");
  assert.equal(call.args[call.args.indexOf("-m") + 1], "gemini-3.5-flash-lite");
  assert.match(call.systemMd, /^SYS\n\nReply with a single JSON object/);
  for (const tool of ["web_fetch", "google_web_search", "read_file", "run_shell_command", "invoke_agent"]) {
    assert.ok(call.settings.tools.exclude.includes(tool), tool);
  }
});

test("gemini-cli: an empty reply is retryable, a missing binary is not", async () => {
  const empty = fakeCli("gemini-empty", JSON.stringify({ response: "" }));
  assert.ok((await new CliProvider({ kind: "gemini", bin: empty.bin }).complete(req).catch((e) => e)) instanceof IncompleteOutput);
  const missing = await new CliProvider({ kind: "gemini", bin: join(dir, "nope") }).complete(req).catch((e) => e);
  assert.match(missing.message, /not found/);
});

test("calls are serialised by default", async () => {
  const bin = join(dir, "slow");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("fs"); const log = ${JSON.stringify(join(dir, "slow.log"))};
fs.appendFileSync(log, "start\\n");
setTimeout(() => { fs.appendFileSync(log, "end\\n"); process.stdout.write(JSON.stringify({ is_error: false, structured_output: { name: "x" } })); }, 150);
`);
  chmodSync(bin, 0o755);
  const p = new CliProvider({ kind: "claude", bin });
  await Promise.all([p.complete(req), p.complete(req)]);
  assert.equal(readFileSync(join(dir, "slow.log"), "utf8"), "start\nend\nstart\nend\n");
});
