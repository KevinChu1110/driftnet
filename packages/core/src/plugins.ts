import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerExtractor, type Extractor } from "./extractors/index.ts";
import { safeFetch } from "./extractors/net.ts";
import { driftnetHome } from "./home.ts";

/** What a plugin gets: the SSRF-safe fetch every built-in extractor uses. */
export interface PluginApi {
  fetch: typeof safeFetch;
}

/**
 * Extractors you add yourself, for sites driftnet doesn't read well: every
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
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
      let value = mod.default;
      if (typeof value === "function") value = await (value as (api: PluginApi) => unknown)({ fetch: safeFetch });
      const list = (Array.isArray(value) ? value : [value]) as Partial<Extractor>[];
      const valid = list.filter((x): x is Extractor => !!x && typeof x.name === "string" && typeof x.matches === "function" && typeof x.extract === "function");
      if (!valid.length) throw new Error("default export is not an extractor ({ name, matches, extract })");
      // Registered last-to-first so the file's first extractor is tried first.
      for (const ex of [...valid].reverse()) registerExtractor(ex);
      loaded.push(...valid.map((ex) => `${ex.name} (${file})`));
    } catch (err) {
      console.warn(`[driftnet] plugin ${file} not loaded: ${(err as Error).message}`);
    }
  }
  return loaded;
}
