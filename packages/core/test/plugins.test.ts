import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlugins } from "../src/plugins.ts";
import { extract } from "../src/extractors/index.ts";

test("plugins from the plugins folder run before the built-ins; broken ones are skipped", async () => {
  const home = mkdtempSync(join(tmpdir(), "driftnet-plugins-"));
  const dir = join(home, "plugins");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.mjs"), `export default { name: "fixture-plugin", matches: (u) => u.startsWith("https://plugin.test/"),
    extract: async (url) => ({ url, kind: "post", title: "From a plugin", text: "hi", outlinks: [], meta: {} }) };`);
  writeFileSync(join(dir, "broken.mjs"), "export default 42;");
  writeFileSync(join(dir, "notes.txt"), "ignored");
  copyFileSync(new URL("../../../examples/plugins/hackernews.mjs", import.meta.url), join(dir, "hn.mjs"));
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  try {
    const loaded = await loadPlugins({ DRIFTNET_HOME: home });
    assert.deepEqual(loaded, ["fixture-plugin (a.mjs)", "hackernews (hn.mjs)"]);
    assert.match(warned.join("\n"), /broken\.mjs not loaded/);
  } finally {
    console.warn = warn;
  }
  assert.equal((await extract("https://plugin.test/x")).title, "From a plugin");
  assert.deepEqual(await loadPlugins({ DRIFTNET_HOME: join(home, "nowhere") }), []);
});
