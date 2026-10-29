import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerExtractor, type Extractor } from "./extractors/index.ts";
import { registerJudge, type JudgeFactory } from "./judge/registry.ts";
import { registerProvider, type ProviderFactory } from "./llm/registry.ts";
import { safeFetch } from "./extractors/net.ts";
import { driftnetHome } from "./home.ts";

/** What a plugin gets: the SSRF-safe fetch every built-in extractor uses. */
export interface PluginApi {
  fetch: typeof safeFetch;
}

/**
 * The fuller plugin shape: any of the three, each optional. `providers` and
 * `judges` map a name to a factory that receives the settings (environment).
 */
export interface PluginExports {
  extractors?: Extractor[];
  providers?: Record<string, ProviderFactory>;
  judges?: Record<string, JudgeFactory>;
}

const isExtractor = (x: unknown): x is Extractor => {
  const e = x as Partial<Extractor> | null | undefined;
  return !!e && typeof e.name === "string" && typeof e.matches === "function" && typeof e.extract === "function";
};

/**
 * Extractors, model providers and judges you add yourself, for sites driftnet doesn't read well: every
 * .js / .mjs file in ~/.driftnet/plugins (or DRIFTNET_PLUGINS). A file's default
 * export is an extractor, a list of them, or a function given { fetch } that
 * returns either. They run before the built-ins. See examples/plugins/.
 * Plugins are ordinary code running with driftnet's permissions — only add
 * files you wrote or read.
 */
export async function loadPlugins(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const dir = resolve(env.DRIFTNET_PLUGINS || join(driftnetHome(env), "plugins"));
  if (!existsSync(dir)) return [];
  const loaded: string[] = [];
  for (const file of readdirSync(dir).filter((f) => /\.m?js$/.test(f)).sort()) {
    try {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown } & PluginExports;
      let value = mod.default;
      if (typeof value === "function") value = await (value as (api: PluginApi) => unknown)({ fetch: safeFetch });
      const shaped = (value && typeof value === "object" && !Array.isArray(value) && !isExtractor(value) ? value : { extractors: undefined }) as PluginExports;
      // Named exports work too: `export const judges = {...}`.
      const extractors = shaped.extractors ?? (isExtractor(value) || Array.isArray(value) ? ((Array.isArray(value) ? value : [value]) as unknown[]) : mod.extractors ?? []);
      const providers = shaped.providers ?? mod.providers ?? {};
      const judges = shaped.judges ?? mod.judges ?? {};
      const valid = (extractors as unknown[]).filter(isExtractor);
      const provNames = Object.entries(providers).filter(([, f]) => typeof f === "function");
      const judgeNames = Object.entries(judges).filter(([, f]) => typeof f === "function");
      if (!valid.length && !provNames.length && !judgeNames.length) {
        throw new Error("nothing to load: export an extractor ({ name, matches, extract }), or { extractors, providers, judges }");
      }
      // Registered last-to-first so the file's first extractor is tried first.
      for (const ex of [...valid].reverse()) registerExtractor(ex);
      for (const [name, factory] of provNames) registerProvider(name, factory);
      for (const [name, factory] of judgeNames) registerJudge(name, factory);
      loaded.push(
        ...valid.map((ex) => `${ex.name} (${file})`),
        ...provNames.map(([n]) => `provider ${n} (${file})`),
        ...judgeNames.map(([n]) => `judge ${n} (${file})`),
      );
    } catch (err) {
      console.warn(`[driftnet] plugin ${file} not loaded: ${(err as Error).message}`);
    }
  }
  return loaded;
}
