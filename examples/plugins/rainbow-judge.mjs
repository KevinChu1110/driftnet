// A judge plugin: files every YouTube link under "videos" and everything from
// GitHub under "coding", for free. Copy to ~/.driftnet/plugins/, restart, then
// set DRIFTNET_JUDGE=rainbow. A plugin file may export any of
// { extractors, providers, judges }; this one only adds a judge.
//
// A model provider has the same shape: providers: { name: (env) => ({ label, complete }) },
// chosen with DRIFTNET_LLM_PROVIDER=name. `complete({ system, user, schema, ... })`
// must return data that passes `schema.parse` (a zod schema).

/** The judge's answer, or null to let the model decide. `categories` maps folder id → "Path — description". */
export default {
  judges: {
    rainbow: () => ({
      name: "rainbow",
      async judge(digest, _note, categories) {
        const host = new URL(digest.url).hostname.replace(/^www\./, "");
        const folder = host.endsWith("youtube.com") || host === "youtu.be" ? "videos" : host === "github.com" ? "coding" : undefined;
        if (!folder || !(folder in categories)) return null;
        return {
          judgement: { isAiTool: 0.5, category: folder, kind: digest.kind, worth: "normal", engine: "rainbow", confidence: 1 },
        };
      },
    }),
  },
};
