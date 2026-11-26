import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createProvider, type LlmProvider } from "@driftnet/core";
import { z } from "zod";
import { SETTINGS } from "./settings.ts";

export interface DetectedAi {
  id: string;
  label: string;
  kind: "cli" | "local";
  values: Record<string, string>;
}

const EMBED_RE = /embed/i;
const PROBE_TIMEOUT_MS = 1500;
const TEST_TIMEOUT_MS = 15_000;

function hasBinOnPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const pathVar = env.PATH ?? env.Path ?? "";
  if (!pathVar) return false;
  const dirs = pathVar.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, ext ? `${name}${ext}` : name);
      try {
        accessSync(full, constants.X_OK);
        if (statSync(full).isFile()) return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

async function probeOllama(fetchFn: typeof fetch): Promise<DetectedAi[]> {
  try {
    const res = await fetchFn("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? [])
      .map((m) => (typeof m?.name === "string" ? m.name.trim() : ""))
      .filter((n) => n && !EMBED_RE.test(n))
      .slice(0, 5);
    return names.map((name) => ({
      id: `ollama:${name}`,
      label: `Ollama — ${name}`,
      kind: "local" as const,
      values: {
        DRIFTNET_LLM_PROVIDER: "openai",
        DRIFTNET_LLM_MODEL: name,
        DRIFTNET_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      },
    }));
  } catch {
    return [];
  }
}

async function probeLmStudio(fetchFn: typeof fetch): Promise<DetectedAi[]> {
  try {
    const res = await fetchFn("http://127.0.0.1:1234/v1/models", { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? [])
      .map((m) => (typeof m?.id === "string" ? m.id.trim() : ""))
      .filter((id) => id && !EMBED_RE.test(id))
      .slice(0, 3);
    return ids.map((id) => ({
      id: `lmstudio:${id}`,
      label: `LM Studio — ${id}`,
      kind: "local" as const,
      values: {
        DRIFTNET_LLM_PROVIDER: "openai",
        DRIFTNET_LLM_MODEL: id,
        DRIFTNET_LLM_BASE_URL: "http://127.0.0.1:1234/v1",
      },
    }));
  } catch {
    return [];
  }
}

export async function detectLocalAi(opts?: {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  hasBin?: (name: string) => boolean;
}): Promise<DetectedAi[]> {
  const env = opts?.env ?? process.env;
  const fetchFn = opts?.fetch ?? globalThis.fetch;
  const hasBin = opts?.hasBin ?? ((name: string) => hasBinOnPath(name, env));

  const cli: DetectedAi[] = [];
  try {
    if (hasBin("claude")) {
      cli.push({
        id: "claude-cli",
        label: "Claude Code (claude-cli)",
        kind: "cli",
        values: { DRIFTNET_LLM_PROVIDER: "claude-cli", DRIFTNET_LLM_MODEL: "haiku", DRIFTNET_LLM_BASE_URL: "" },
      });
    }
    if (hasBin("gemini")) {
      cli.push({
        id: "gemini-cli",
        label: "Gemini CLI (gemini-cli)",
        kind: "cli",
        values: { DRIFTNET_LLM_PROVIDER: "gemini-cli", DRIFTNET_LLM_MODEL: "", DRIFTNET_LLM_BASE_URL: "" },
      });
    }
  } catch {
    // never throw
  }

  const [ollama, lmstudio] = await Promise.all([probeOllama(fetchFn), probeLmStudio(fetchFn)]);
  return [...cli, ...ollama, ...lmstudio];
}

const PING_SCHEMA = z.object({ ok: z.boolean() });
const MODEL_SETTINGS = new Map(SETTINGS.filter((s) => s.group === "model").map((s) => [s.key, s]));

export type TestAiResult = { ok: true; provider: string; ms: number } | { ok: false; error: string };

export async function testAiConnection(
  env: NodeJS.ProcessEnv,
  values: Record<string, unknown>,
  opts?: { createProvider?: typeof createProvider; timeoutMs?: number; locked?: ReadonlySet<string> },
): Promise<TestAiResult> {
  const preview: NodeJS.ProcessEnv = { ...env };

  for (const [key, raw] of Object.entries(values ?? {})) {
    const s = MODEL_SETTINGS.get(key);
    if (!s || raw === undefined || opts?.locked?.has(key)) continue;
    if (raw !== null && typeof raw !== "string") return { ok: false, error: `${key} must be text` };
    let value = raw === null ? null : raw.trim();
    if (s.secret && value === "") continue;
    if (value === "") value = null;
    if (value !== null) {
      if (s.choices && !s.choices.includes(value)) {
        return { ok: false, error: `${key} must be one of ${s.choices.filter(Boolean).join(", ")}` };
      }
      if (value.length > (s.max ?? 500)) return { ok: false, error: `${key} is too long` };
      if (s.min && value.length < s.min) return { ok: false, error: `${key} needs at least ${s.min} characters` };
      if (value.includes("`")) return { ok: false, error: `${key} can't contain a backtick` };
      if (!s.multiline && /[\r\n]/.test(value)) return { ok: false, error: `${key} must be one line` };
      if (/URL$/.test(key) && !/^https?:\/\/\S+$/.test(value)) {
        return { ok: false, error: `${key} must be an http(s) URL` };
      }
      if (s.pattern && !s.pattern.test(value)) {
        return { ok: false, error: `${key} doesn't look right: it ${s.shape ?? "has the wrong shape"}` };
      }
      preview[key] = value;
    } else {
      delete preview[key];
    }
  }

  let provider: (LlmProvider & { dispose?: () => void }) | null | undefined;
  try {
    provider = (opts?.createProvider ?? createProvider)(preview) as (LlmProvider & { dispose?: () => void }) | null | undefined;
  } catch (err) {
    return { ok: false, error: ((err as Error)?.message ?? String(err)).slice(0, 300) };
  }
  if (!provider) return { ok: false, error: "No AI provider configured" };

  const timeoutMs = opts?.timeoutMs ?? TEST_TIMEOUT_MS;
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([
      provider.complete({
        system: "Reply with JSON.",
        user: "Ping",
        schema: PING_SCHEMA,
        schemaName: "ping",
        maxTokens: 32,
      }),
      timeout,
    ]);
    return { ok: true, provider: provider.label, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: ((err as Error)?.message ?? String(err)).slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
    provider.dispose?.();
  }
}
