import { randomBytes } from "node:crypto";
import { IMPORT_FORMATS, parseImport, planImport, runImport, type Driftnet, type ImportFormat, type ImportProgress } from "@driftnet/core";
import { BadRequest, type Route } from "../route.ts";

/** A bookmarks file can be big: this route takes 20 MB instead of the usual 1 MB. */
const BODY_LIMIT = 20_000_000;

interface Job extends ImportProgress {
  state: "running" | "done" | "failed";
}
/** In memory, per catalogue, one at a time; the last few finished jobs stay readable. */
const jobs = new WeakMap<Driftnet, Map<string, Job>>();
const jobsOf = (dn: Driftnet) => jobs.get(dn) ?? jobs.set(dn, new Map()).get(dn)!;

export const routes: Route[] = [
  {
    method: "POST", pattern: "/api/import", access: "write",
    handler: async ({ send, body, app: { dn } }) => {
      let req: { content?: unknown; format?: unknown; folders?: unknown; dryRun?: unknown };
      try { req = JSON.parse((await body(BODY_LIMIT)) || "{}"); } catch { throw new BadRequest("body is not valid JSON"); }
      if (typeof req.content !== "string" || !req.content.trim()) throw new BadRequest("content must be the text of a bookmarks file");
      const format = req.format ?? "auto";
      if (format !== "auto" && !IMPORT_FORMATS.includes(format as ImportFormat)) throw new BadRequest(`format must be auto, ${IMPORT_FORMATS.join(", ")}`);
      if (req.folders !== undefined && req.folders !== "keep" && req.folders !== "none") throw new BadRequest('folders must be "keep" or "none"');
      const folders = req.folders === "keep" ? "keep" : "none";

      const all = jobsOf(dn);
      const running = [...all.values()].some((j) => j.state === "running");
      if (running && !req.dryRun) return send(409, { error: "an import is already running" });

      const parsed = parseImport(req.content, format as ImportFormat | "auto");
      const plan = planImport(dn.store, parsed.entries);
      const counts = { format: parsed.format, total: plan.entries.length, duplicates: plan.duplicates, skipped: plan.skipped, capped: plan.capped };
      if (req.dryRun) return send(200, { ...counts, preview: plan.entries.slice(0, 20) });
      if (!plan.entries.length) return send(200, { job: null, ...counts });

      const id = randomBytes(6).toString("hex");
      const job: Job = { state: "running", total: plan.entries.length, done: 0, added: 0, already: 0, failed: 0, errors: [] };
      all.set(id, job);
      // Keep memory small: only the newest 20 jobs are remembered.
      for (const k of all.keys()) { if (all.size <= 20) break; if (all.get(k)!.state !== "running") all.delete(k); }
      runImport(dn, plan.entries, { folders }, job)
        .then(() => { job.state = "done"; })
        .catch((err) => {
          console.error("[import]", err);
          job.state = "failed";
          if (job.errors.length < 10) job.errors.push(String((err as Error).message ?? err).slice(0, 300));
        });
      return send(202, { job: id, ...counts });
    },
  },
  {
    method: "GET", pattern: /^\/api\/import\/([a-f0-9]+)$/, example: "/api/import/0123456789ab", access: "read",
    handler: ({ send, m, app: { dn } }) => {
      const job = jobsOf(dn).get(m[1]!);
      return job ? send(200, job) : send(404, { error: "no such import" });
    },
  },
];
