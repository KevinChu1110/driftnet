import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF guard. driftnet fetches whatever strangers paste into a chat, so a link
 * (or a redirect it leads to) must never reach the machine itself, the LAN, or
 * a cloud metadata endpoint — otherwise its content comes back as a "summary".
 *
 * Every hop is checked: redirects are followed by hand, and each target's DNS
 * answers must all be public. Residual risk: DNS rebinding between this lookup
 * and the connection. Set DRIFTNET_ALLOW_PRIVATE_URLS=1 to catalogue intranet
 * pages on purpose.
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

async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrl(`${url.protocol} links are not fetched`);
  if (process.env.DRIFTNET_ALLOW_PRIVATE_URLS === "1") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || !addresses.every(isPublicAddress)) {
    throw new BlockedUrl(`${url.hostname} resolves to a private or local address`);
  }
}

/** fetch() that refuses private targets on every hop. Max 5 redirects. */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
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
