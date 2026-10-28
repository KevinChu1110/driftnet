import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciInit } from "undici";

/**
 * SSRF guard. driftnet fetches whatever strangers paste into a chat, so a link
 * (or a redirect it leads to) must never reach the machine itself, the LAN, or
 * a cloud metadata endpoint — otherwise its content comes back as a "summary".
 *
 * Every hop is checked: redirects are followed by hand. Host names are checked
 * inside the connection's own DNS lookup, so the address that was checked is
 * the address that gets connected to: a name that resolves to a public IP for
 * a check and to 127.0.0.1 a moment later (DNS rebinding) gets nowhere. Set
 * DRIFTNET_ALLOW_PRIVATE_URLS=1 to catalogue intranet pages on purpose.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

export class BlockedUrl extends Error {}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const lower = address.toLowerCase();
  // IPv4 smuggled in IPv6: ::ffff:127.0.0.1 and NAT64 64:ff9b::7f00:1.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) return false;
  return !blocked.check(address, "ipv6");
}

const allowPrivate = () => process.env.DRIFTNET_ALLOW_PRIVATE_URLS === "1";

type Resolver = (host: string) => Promise<LookupAddress[]>;
let resolve: Resolver = (host) => lookup(host, { all: true, verbatim: true });

/** Tests only: answer DNS from a fake resolver. Returns a function that restores the real one. */
export function useResolverForTests(fake: Resolver): () => void {
  const real = resolve;
  resolve = fake;
  return () => {
    resolve = real;
  };
}

/** net.connect-compatible lookup that refuses private answers. */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  resolve(hostname).then(
    (answers) => {
      if (!answers.length) return callback(new BlockedUrl(`${hostname} did not resolve`), "");
      if (!allowPrivate() && !answers.every((a) => isPublicAddress(a.address))) {
        return callback(new BlockedUrl(`${hostname} resolves to a private or local address`), "");
      }
      if (options.all) return callback(null, answers);
      callback(null, answers[0]!.address, answers[0]!.family);
    },
    (err: Error) => callback(err, ""),
  );
}

const dispatcher = new Agent({ connect: { lookup: guardedLookup as never } });

function assertAllowed(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrl(`${url.protocol} links are not fetched`);
  // Literal IPs never go through DNS, so they are checked here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!allowPrivate() && isIP(host) && !isPublicAddress(host)) {
    throw new BlockedUrl(`${url.hostname} is a private or local address`);
  }
}

/** fetch() that refuses private targets on every hop. Max 5 redirects. */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; hop <= 5; hop++) {
    assertAllowed(url);
    let res: Response;
    try {
      res = (await undiciFetch(url, { ...(init as UndiciInit), redirect: "manual", dispatcher })) as unknown as Response;
    } catch (err) {
      // undici wraps lookup errors as "fetch failed"; surface the refusal itself.
      const cause = (err as { cause?: unknown }).cause;
      throw cause instanceof BlockedUrl ? cause : err;
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      url = new URL(location, url);
      continue;
    }
    return res;
  }
  throw new BlockedUrl("too many redirects");
}
