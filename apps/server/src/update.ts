import type { Store } from "@driftnet/core";

/**
 * "A new version is out". One plain GET to the npm registry (fixed host, no cookies, no
 * identifiers, 3 s timeout), at most once a day: the time of the last try lives in the
 * store's state table, so restarting does not check again. Off with DRIFTNET_UPDATE_CHECK=0.
 * Never blocks startup (main.ts calls it after listen and ignores the result).
 */
export const UPDATE_URL = "https://registry.npmjs.org/driftnet/latest";
export const RELEASES_URL = "https://github.com/KevinChu1110/driftnet/releases";
const STATE_KEY = "update_check";
const DAY = 24 * 60 * 60_000;
const MAX_BYTES = 256 * 1024;

type Triple = [number, number, number, string[]];

/** 1.2.3 or 1.2.3-rc.1 (a leading v is fine); anything else is not a version we will compare. */
export function parseSemver(v: string): Triple | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split(".") : []] : null;
}

/** Semver order: <0, 0, >0; a pre-release sorts below its release; null when either side is not a version. */
export function compareSemver(a: string, b: string): number | null {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) < (y[i] as number) ? -1 : 1;
  const [p, q] = [x[3], y[3]];
  if (!p.length || !q.length) return p.length === q.length ? 0 : p.length ? -1 : 1;
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const [pn, qn] = [/^\d+$/.test(p[i]!), /^\d+$/.test(q[i]!)];
    if (pn && qn) { if (Number(p[i]) !== Number(q[i])) return Number(p[i]) < Number(q[i]) ? -1 : 1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p[i] !== q[i]) return p[i]! < q[i]! ? -1 : 1;
  }
  return 0;
}

export const currentVersion = (env: NodeJS.ProcessEnv = process.env) => env.DRIFTNET_VERSION ?? "dev";
export const updateCheckOn = (env: NodeJS.ProcessEnv) => env.DRIFTNET_UPDATE_CHECK?.trim() === "1";

interface Saved { at: number; latest?: string }
const saved = (store: Store): Saved => {
  try {
    const s = JSON.parse(store.getState(STATE_KEY) ?? "{}") as Saved;
    return { at: Number.isFinite(s.at) ? s.at : 0, ...(typeof s.latest === "string" && parseSemver(s.latest) ? { latest: s.latest } : {}) };
  } catch { return { at: 0 }; }
};

/** What /api/stats and `driftnet status` show: {latest, current} when a newer release is known, from what the last check saved (no network). */
export function updateNotice(store: Store, env: NodeJS.ProcessEnv): { latest: string; current: string } | undefined {
  const current = currentVersion(env);
  if (!updateCheckOn(env)) return undefined;
  const { latest } = saved(store);
  return latest && (compareSemver(latest, current) ?? 0) > 0 ? { latest, current } : undefined;
}

/** Ask the registry if it has been a day since the last try. Returns the newer version, if any. Never throws. */
export async function checkForUpdate(
  store: Store, env: NodeJS.ProcessEnv, opts: { fetch?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const current = currentVersion(env);
  if (!updateCheckOn(env) || !parseSemver(current)) return undefined; // off, or a checkout ("dev"): nothing to compare
  const now = opts.now ?? Date.now();
  const last = saved(store);
  if (now - last.at < DAY && last.at <= now) return updateNotice(store, env)?.latest;
  // Remember the try first: a registry that is down is not asked again until tomorrow.
  store.setState(STATE_KEY, JSON.stringify({ ...last, at: now }));
  // A plain timer, not AbortSignal.timeout(): Node 22 doesn't let that one keep a short-lived process
  // (the CLI, a test) alive, so the abort could never fire there.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await (opts.fetch ?? fetch)(UPDATE_URL, {
      method: "GET", headers: { accept: "application/json" }, credentials: "omit", redirect: "error", signal: abort.signal,
    });
    if (!res.ok) return updateNotice(store, env)?.latest;
    const text = await res.text();
    if (text.length > MAX_BYTES) return undefined;
    const version = (JSON.parse(text) as { version?: unknown }).version;
    // Only a well-formed version is kept: nothing else from the response is stored or shown.
    if (typeof version === "string" && parseSemver(version)) store.setState(STATE_KEY, JSON.stringify({ at: now, latest: version.replace(/^v/, "") }));
  } catch {
    // offline, slow, blocked: say nothing
  } finally {
    clearTimeout(timer);
  }
  return updateNotice(store, env)?.latest;
}
