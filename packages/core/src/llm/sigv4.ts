import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string;
  /** Headers to send and sign besides host / x-amz-date (e.g. content-type). */
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  date?: Date;
}

const sha256hex = (data: string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as AWS wants it: only A-Z a-z 0-9 - _ . ~ stay. */
const awsEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function signingKey(secret: string, day: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
}

/**
 * AWS Signature Version 4, by hand. Returns the headers to send: everything in
 * `headers`, plus host, x-amz-date, x-amz-security-token (when there is a
 * session token) and authorization.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...(input.headers ?? {}), host: url.host, "x-amz-date": amzDate };
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;

  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const byLower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")]));
  const canonicalHeaders = names.map((n) => `${n}:${byLower[n]}\n`).join("");
  const signedHeaders = names.join(";");

  // Every service but S3 encodes the (already encoded) path a second time.
  const canonicalUri = url.pathname.split("/").map((seg) => awsEncode(seg)).join("/") || "/";
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonical = [input.method.toUpperCase(), canonicalUri, query, canonicalHeaders, signedHeaders, sha256hex(input.body ?? "")].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonical)].join("\n");
  const signature = createHmac("sha256", signingKey(input.credentials.secretAccessKey, day, input.region, input.service)).update(toSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
