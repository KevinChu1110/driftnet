import { PACK_MAX_BYTES, PackError, buildPack, packDisposition, parsePack, safeFetch, signPack } from "@driftnet/core";
import { isPrivate } from "../access.ts";
import { BadRequest, type Route } from "../route.ts";

/** Swappable so tests need no network; always the SSRF-guarded fetch in real use. */
export const packFetch: { fn: typeof safeFetch } = { fn: safeFetch };

/** Fetch a pack from a link: http(s) only, through the SSRF guard, at most 2 MB, and it must parse as a pack. Returns the text. */
export async function fetchPackText(link: string): Promise<string> {
  let url: URL;
  try { url = new URL(link); } catch { throw new BadRequest("that is not a link"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BadRequest("a pack link must start with http:// or https://");
  let res: Response;
  try {
    res = await packFetch.fn(url.href, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new BadRequest(`could not fetch the pack: ${(err as Error).message}`.slice(0, 200));
  }
  if (!res.ok) throw new BadRequest(`the pack link answered ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > PACK_MAX_BYTES) { await res.body?.cancel(); throw new BadRequest("the pack is over 2 MB"); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of (res.body ?? []) as AsyncIterable<Uint8Array>) {
    size += c.length;
    if (size > PACK_MAX_BYTES) throw new BadRequest("the pack is over 2 MB");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try { parsePack(text); } catch (err) { throw new BadRequest(err instanceof PackError ? err.message : "that link is not a driftnet pack"); }
  return text;
}

const idOf = (m: RegExpExecArray) => decodeURIComponent(m[1]!);

export const routes: Route[] = [
  // The pack as a download. Reads work with the share key, or with this pack's signed link (?s=, see app.ts) and nothing else.
  {
    method: "GET", pattern: /^\/api\/folders\/([^/]+)\/pack$/, example: "/api/folders/other/pack", access: "read",
    handler: ({ m, url, send, app: { dn } }) => {
      const id = idOf(m);
      if (!dn.store.folders().some((f) => f.id === id)) return send(404, { error: "no such folder" });
      try {
        const q = url.searchParams;
        const pack = buildPack(dn.store, id, {
          label: (f) => dn.folderLabel(f, "en"),
          ...(q.get("name") ? { name: q.get("name")! } : {}), ...(q.get("description") ? { description: q.get("description")! } : {}),
          ...(q.get("author") ? { author: q.get("author")! } : {}),
        });
        return send(200, JSON.stringify(pack, null, 1), "application/json; charset=utf-8", {
          "content-disposition": packDisposition(pack.name), "cache-control": "no-store",
        });
      } catch (err) {
        if (err instanceof PackError) return send(413, { error: err.message });
        throw err;
      }
    },
  },
  // The link to hand out. Private catalogue: signed for this one pack, so it opens without the share key.
  {
    method: "GET", pattern: /^\/api\/folders\/([^/]+)\/pack-link$/, example: "/api/folders/other/pack-link", access: "read",
    handler: ({ m, send, app: { dn, env } }) => {
      const id = idOf(m);
      if (!dn.store.folders().some((f) => f.id === id)) return send(404, { error: "no such folder" });
      const path = `/api/folders/${encodeURIComponent(id)}/pack`;
      const query = isPrivate(env) ? `?s=${signPack(dn.store, id)}` : "";
      const base = (env.DRIFTNET_TUNNEL_URL || env.DRIFTNET_PUBLIC_URL)?.replace(/\/$/, "");
      return send(200, { path: path + query, url: base ? base + path + query : null, signed: !!query });
    },
  },
];
