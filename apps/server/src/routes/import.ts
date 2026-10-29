import { randomBytes } from "node:crypto";
import { IMPORT_FORMATS, PackError, parseImport, planImport, runImport, runPackImport, type Driftnet, type ImportFormat, type ImportProgress } from "@driftnet/core";
import { BadRequest, type Route } from "../route.ts";
import { fetchPackText } from "./packs.ts";

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
      let req: { url?: unknown; content?: unknown; format?: unknown; folders?: unknown; dryRun?: unknown };
      try { req = JSON.parse((await body(BODY_LIMIT)) || "{}"); } catch { throw new BadRequest("body is not valid JSON"); }
      // A link to a folder pack: fetched here (SSRF-guarded, 2 MB), then treated like a pasted pack.
      const fromLink = typeof req.url === "string" && req.url.trim() !== "";
      if (!fromLink && (typeof req.content !== "string" || !req.content.trim())) throw new BadRequest("content must be the text of a bookmarks file, or url a link to a pack");
      const format = fromLink ? "pack" : req.format ?? "auto";
      if (format !== "auto" && !IMPORT_FORMATS.includes(format as ImportFormat)) throw new BadRequest(`format must be auto, ${IMPORT_FORMATS.join(", ")}`);
      if (req.folders !== undefined && req.folders !== "keep" && req.folders !== "none") throw new BadRequest('folders must be "keep" or "none"');
      const folders = req.folders === "keep" ? "keep" : "none";

      const all = jobsOf(dn);
      const running = [...all.values()].some((j) => j.state === "running");
      if (running && !req.dryRun) return send(409, { error: "an import is already running" });

      const content = fromLink ? await fetchPackText(String(req.url).trim()) : (req.content as string);
      let parsed: ReturnType<typeof parseImport>;
      try { parsed = parseImport(content, format as ImportFormat | "auto"); } catch (err) {
        if (err instanceof PackError) throw new BadRequest(err.message);
        throw err;
      }
      const plan = planImport(dn.store, parsed.entries);
      const counts = { format: parsed.format, total: plan.entries.length, duplicates: plan.duplicates, skipped: plan.skipped + (parsed.pack?.skipped ?? 0), capped: plan.capped,
        ...(parsed.pack ? { pack: { name: parsed.pack.pack.name, description: parsed.pack.pack.description, ...(parsed.pack.pack.author ? { author: parsed.pack.pack.author } : {}) } } : {}) };
      if (req.dryRun) return send(200, { ...counts, preview: plan.entries.slice(0, 20) });
      const id = randomBytes(6).toString("hex");
      if (parsed.pack) {
        // A pack is already summarised: nothing to wait for, no model call, so it runs right here (still readable as a job).
        const job: Job = { state: "running", total: parsed.pack.pack.items.length, done: 0, added: 0, already: 0, failed: 0, errors: [] };
        runPackImport(dn.store, parsed.pack, job);
        job.state = "done";
        all.set(id, job);
        for (const k of all.keys()) { if (all.size <= 20) break; if (all.get(k)!.state !== "running") all.delete(k); }
        return send(202, { job: id, ...counts, total: job.total });
      }
      if (!plan.entries.length) return send(200, { job: null, ...counts });

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
