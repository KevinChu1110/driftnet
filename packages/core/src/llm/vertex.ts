import { createSign } from "node:crypto";
import type { z } from "zod";
import { generateContentBody, parseGenerateContent } from "./gemini.ts";
import { failFromResponse, safeSegment } from "./shared.ts";
import type { LlmProvider, StructuredRequest } from "./types.ts";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface VertexOptions {
  model: string;
  region: string;
  project?: string;
  /** A service-account key (the parsed JSON file)… */
  serviceAccount?: ServiceAccount;
  /** …or a ready access token (e.g. from `gcloud auth print-access-token`). */
  accessToken?: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** The self-signed JWT Google exchanges for an access token (RS256). */
export function signServiceAccountJwt(sa: ServiceAccount, nowSeconds: number): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key);
  return `${head}.${claims}.${b64url(sig)}`;
}

/** Parse a service-account key from a JSON string; throws a message that never includes the key. */
export function parseServiceAccount(json: string): ServiceAccount {
  let sa: Partial<ServiceAccount>;
  try {
    sa = JSON.parse(json) as Partial<ServiceAccount>;
  } catch {
    throw new Error("the Vertex credentials are not valid JSON");
  }
  if (typeof sa.client_email !== "string" || typeof sa.private_key !== "string") throw new Error("the Vertex credentials need client_email and private_key (a service-account key file)");
  return { client_email: sa.client_email, private_key: sa.private_key, ...(typeof sa.project_id === "string" ? { project_id: sa.project_id } : {}) };
}

/**
 * Gemini on Google Cloud (Vertex AI): the same generateContent request as the
 * Gemini API, authorised with an OAuth access token. A service-account key is
 * exchanged for one (cached until just before it expires); no Google library.
 */
export class VertexProvider implements LlmProvider {
  readonly label: string;
  private readonly project: string;
  private readonly host: string;
  private token: { value: string; expiresAt: number } | undefined;
  private inflight: Promise<string> | undefined;

  constructor(private readonly opts: VertexOptions) {
    if (!opts.serviceAccount && !opts.accessToken) throw new Error("vertex needs a service-account key (GOOGLE_APPLICATION_CREDENTIALS) or an access token (DRIFTNET_LLM_API_KEY)");
    const project = opts.project ?? opts.serviceAccount?.project_id;
    if (!project) throw new Error("vertex needs a project: set GOOGLE_CLOUD_PROJECT, or use a key file that names one");
    this.project = safeSegment("project", project);
    const region = safeSegment("region", opts.region);
    this.host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
    this.label = `vertex:${opts.model} @ ${region}`;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async accessToken(): Promise<string> {
    if (this.opts.accessToken) return this.opts.accessToken;
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    // One exchange at a time: a burst of items shouldn't each mint a token.
    this.inflight ??= this.exchange().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async exchange(): Promise<string> {
    const sa = this.opts.serviceAccount!;
    const assertion = signServiceAccountJwt(sa, Math.floor(this.now() / 1000));
    const res = await (this.opts.fetch ?? fetch)(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) await failFromResponse(res, [assertion, sa.private_key]);
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("Google's token endpoint returned no access token");
    // Renew a minute early so a request never goes out with a token about to lapse.
    this.token = { value: data.access_token, expiresAt: this.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000 };
    return data.access_token;
  }

  async complete<T extends z.ZodType>(req: StructuredRequest<T>): Promise<z.infer<T>> {
    const token = await this.accessToken();
    const model = this.opts.model.replace(/^(publishers\/google\/)?models\//, "");
    const url = `https://${this.host}/v1/projects/${this.project}/locations/${safeSegment("region", this.opts.region)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    const res = await (this.opts.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(generateContentBody(req)),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) {
      // A 401 means the cached token was revoked early: drop it so the retry mints a new one.
      if (res.status === 401) this.token = undefined;
      await failFromResponse(res, [token]);
    }
    return parseGenerateContent(req.schema, (await res.json()) as Parameters<typeof parseGenerateContent>[1]);
  }
}
