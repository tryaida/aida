// `POST /api/feedback`, framework-agnostic: takes a web `Request`, returns a `Response`, so the
// help app's route stays a few lines (scope.md "Help app": keep the app thin). Reuses the chat's
// rate limiter (wrapped, with feedback's own lower budgets) and origin allowlist: the in-app
// widget posts from the app's own origin, exactly like it does to /api/chat. Answers 204 with no
// body on success and never echoes input.
import { CORS_HEADERS_FOR, resolveCorsOrigin } from "../chat/cors.js";
import { RateLimiter } from "../chat/rate-limit.js";
import { FEEDBACK_LIMITS, feedbackDay, validateFeedback } from "./entry.js";
import { defaultFeedbackStore, type FeedbackStore } from "./store.js";

/** Feedback's own budgets, below the chat's (20 per client, 300 overall): a reader votes once a
 * page and records each failed search once, so ten a minute is generous, and the overall cap is
 * what bounds a flood from many addresses. */
export const FEEDBACK_RATE_LIMITS = { perClientPerMinute: 10, globalPerMinute: 120 } as const;

type Env = Record<string, string | undefined>;

export interface FeedbackRouteOptions {
  /** `feedback-config.json`'s switch. False: every method answers 404. */
  enabled: boolean;
  /** `chat.allowedOrigins`: app origins the in-app widget may post from. */
  allowedOrigins: string[];
  /** The help site's own origin (`feedback-config.json`, from `publish.siteUrl`). */
  siteOrigin?: string;
  /** Per-client posts per minute. Default `FEEDBACK_RATE_LIMITS.perClientPerMinute`. */
  rateLimitPerMinute?: number;
  /** All clients together per minute. Default `FEEDBACK_RATE_LIMITS.globalPerMinute`. */
  globalRateLimitPerMinute?: number;
  /** `chat.trustProxyHeader`: a header the owner's own proxy sets to the client's address. */
  trustProxyHeader?: string;
  /** Where the hosting platform is detected from. Default `process.env`. */
  env?: Env;
  /** Default `defaultFeedbackStore()`. */
  store?: FeedbackStore;
  /** Tests pass their own; the route shares one per process per budget. */
  limiter?: FeedbackRateLimiter;
  now?: () => Date;
}

/**
 * Per-client and overall budgets around the chat's `RateLimiter`. A client the route can't
 * identify (no platform detected, no configured proxy header) counts against the overall budget
 * only: there is no address to give it a bucket of its own that it couldn't change per request.
 * The per-client check runs first, so a client already over its own budget can't use up the
 * overall one with posts that are refused anyway.
 */
export class FeedbackRateLimiter {
  private readonly perClient: RateLimiter;
  private readonly overall: RateLimiter;

  constructor(perClientPerMinute: number, globalPerMinute: number, now: () => number = Date.now) {
    this.perClient = new RateLimiter(perClientPerMinute, now);
    this.overall = new RateLimiter(globalPerMinute, now);
  }

  allow(clientId: string | undefined): boolean {
    if (clientId !== undefined && !this.perClient.allow(clientId)) return false;
    return this.overall.allow("all");
  }
}

/** The client-address header each hosting platform sets itself, overwriting whatever the client
 * sent, keyed by an environment variable only that platform sets. Anywhere else these headers are
 * just text the client chose, so they are never read. */
const PLATFORMS: { env: string; headers: string[] }[] = [
  { env: "VERCEL", headers: ["x-vercel-forwarded-for", "x-real-ip"] },
  { env: "NETLIFY", headers: ["x-nf-client-connection-ip"] },
  { env: "CF_PAGES", headers: ["cf-connecting-ip"] },
];

/**
 * The key the rate limiter counts a client under, or undefined when nothing trustworthy names
 * one. Used only in memory, for the limiter; never stored or logged with an entry. Trusted, in
 * order: the owner's `trustProxyHeader` (their own proxy sets it; for `X-Forwarded-For` the last
 * hop, the one that proxy added), then the detected platform's own header. A bare
 * `X-Forwarded-For` or `X-Real-IP` is not trusted: on `next start` with no proxy, or behind a
 * proxy that passes them through, the client writes them.
 */
export function clientIdFromHeaders(headers: Headers, trustProxyHeader?: string, env: Env = process.env): string | undefined {
  if (trustProxyHeader) {
    const value = headers.get(trustProxyHeader);
    if (value) {
      const hops = value.split(",").map((h) => h.trim()).filter(Boolean);
      const hop = trustProxyHeader.toLowerCase() === "x-forwarded-for" ? hops[hops.length - 1] : hops[0];
      if (hop) return hop;
    }
  }
  for (const platform of PLATFORMS) {
    if (!env[platform.env]) continue;
    for (const header of platform.headers) {
      const value = headers.get(header)?.split(",")[0]?.trim();
      if (value) return value;
    }
  }
  return undefined;
}

// Separate from the chat's limiters (a reader's votes shouldn't eat their chat budget), shared
// across requests so each client's bucket persists.
const sharedLimiters = new Map<string, FeedbackRateLimiter>();
function limiterFor(perMinute: number, globalPerMinute: number): FeedbackRateLimiter {
  const key = `${perMinute}:${globalPerMinute}`;
  let limiter = sharedLimiters.get(key);
  if (!limiter) {
    limiter = new FeedbackRateLimiter(perMinute, globalPerMinute);
    sharedLimiters.set(key, limiter);
  }
  return limiter;
}

type OriginCheck = { allowed: true; cors?: string } | { allowed: false };

/**
 * The help site's own pages post same-origin; the widget posts from an allowlisted app origin;
 * anything else is refused. Same-site is any of: the browser's own `Sec-Fetch-Site: same-origin`
 * (a header page scripts can't set), the configured site origin (`publish.siteUrl`), or an
 * `Origin` whose host is the `Host` the request arrived with (no proxy in front). Never
 * `X-Forwarded-Host`, which any client can send. No `Origin` header (curl, a server) is let
 * through to the rate limit and validation, as the chat route does: it isn't a browser, so a
 * same-origin check would prove nothing about it.
 */
function checkOrigin(request: Request, allowedOrigins: string[], siteOrigin: string | undefined): OriginCheck {
  const origin = request.headers.get("origin");
  if (!origin) return { allowed: true };
  const cors = resolveCorsOrigin(origin, allowedOrigins);
  if (cors) return { allowed: true, cors };
  if (request.headers.get("sec-fetch-site") === "same-origin") return { allowed: true };
  if (siteOrigin && origin === siteOrigin) return { allowed: true };
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return { allowed: false };
  }
  const host = request.headers.get("host") || new URL(request.url).host;
  return originHost === host ? { allowed: true } : { allowed: false };
}

function respond(status: number, error: string | undefined, cors: string | undefined): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store", ...(cors ? CORS_HEADERS_FOR(cors) : {}) };
  if (!error) return new Response(null, { status, headers });
  headers["Content-Type"] = "application/json; charset=utf-8";
  return new Response(JSON.stringify({ error }), { status, headers });
}

type BodyRead = { ok: true; text: string } | { ok: false; status: 400 | 413 };

/** Reads the body counting bytes as they arrive and stops (cancelling the rest) the moment it
 * passes `max`, so a chunked upload with no Content-Length can't make the route buffer it. */
async function readBodyCapped(request: Request, max: number): Promise<BodyRead> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export async function handleFeedbackPost(request: Request, opts: FeedbackRouteOptions): Promise<Response> {
  if (!opts.enabled) return respond(404, "not found", undefined);

  const origin = checkOrigin(request, opts.allowedOrigins, opts.siteOrigin);
  if (!origin.allowed) return respond(403, "origin not allowed", undefined);
  const cors = origin.cors;

  const limiter =
    opts.limiter ??
    limiterFor(opts.rateLimitPerMinute ?? FEEDBACK_RATE_LIMITS.perClientPerMinute, opts.globalRateLimitPerMinute ?? FEEDBACK_RATE_LIMITS.globalPerMinute);
  if (!limiter.allow(clientIdFromHeaders(request.headers, opts.trustProxyHeader, opts.env))) {
    return respond(429, "too many requests, try again in a minute", cors);
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return respond(415, "send JSON", cors);

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > FEEDBACK_LIMITS.body) return respond(413, "request too large", cors);
  const read = await readBodyCapped(request, FEEDBACK_LIMITS.body);
  if (!read.ok) return respond(read.status, read.status === 413 ? "request too large" : "unreadable body", cors);

  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return respond(400, "invalid JSON", cors);
  }
  const result = validateFeedback(body);
  if (!result.ok) return respond(400, result.error, cors);

  try {
    await (opts.store ?? defaultFeedbackStore()).record({ ...result.input, at: feedbackDay(opts.now?.()) });
  } catch {
    // A read-only filesystem under `next start`, say. The reader can't fix it; say so plainly.
    return respond(500, "feedback could not be saved", cors);
  }
  return respond(204, undefined, cors);
}

/** CORS preflight for the in-app widget. */
export function handleFeedbackOptions(request: Request, opts: Pick<FeedbackRouteOptions, "enabled" | "allowedOrigins">): Response {
  if (!opts.enabled) return respond(404, "not found", undefined);
  const cors = resolveCorsOrigin(request.headers.get("origin"), opts.allowedOrigins);
  return respond(204, undefined, cors);
}
