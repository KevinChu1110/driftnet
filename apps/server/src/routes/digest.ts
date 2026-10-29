import type { Route } from "../route.ts";
import { runDigest } from "../digest.ts";

export const routes: Route[] = [
  {
    // Send the digest now (marks the period as covered), or with dryRun only show the text each target would get.
    method: "POST", pattern: "/api/digest/send", access: "write",
    handler: async ({ send, json, app: { dn, env } }) => {
      const body = await json<{ dryRun?: unknown }>();
      send(200, await runDigest(dn, env, { dryRun: body.dryRun === true }));
    },
  },
];
