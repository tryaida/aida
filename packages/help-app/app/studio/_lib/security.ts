// Shared CSRF/cross-site guard for every /studio/api/** route handler. The Studio only runs in
// `next dev` (see dev-only.ts), but a dev server is still a plain HTTP server that any page open
// in the same browser can reach: a malicious page in another tab can POST to these routes
// directly, and a `text/plain` body skips the CORS preflight that would otherwise block a
// cross-site JSON-shaped request. Since `{/* aida:begin k */}` is valid JS/JSX, a cross-site
// write into e.g. app/api/chat/route.ts can inject code that runs the next time `next dev`
// rebuilds — see the finding this guards against. Every handler under app/studio/api/** must
// call `assertStudioRequest(request)` first and return its result if non-null.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

// Next's dev server (Turbopack) compiles the page and each route handler into separate module
// graphs, so a plain `const STUDIO_TOKEN = randomBytes(...)` at module scope is NOT guaranteed to
// be the same value in page.tsx's copy as in a given route.ts's copy — each gets its own module
// instance. A real file, outside the repo (so it's never committed and never shows up in `git
// status`), is what makes the token the same value everywhere: generated once, lazily, and read
// back by whichever module needs it. Keyed by the help app's own path so unrelated projects on
// the same machine don't share a token.
function tokenFilePath(): string {
  const key = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 24);
  const dir = join(tmpdir(), "aida-studio-token");
  mkdirSync(dir, { recursive: true });
  return join(dir, key);
}

let cachedToken: string | undefined;

export function getStudioToken(): string {
  if (cachedToken) return cachedToken;
  const file = tokenFilePath();
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) {
      cachedToken = existing;
      return existing;
    }
  }
  const fresh = randomBytes(24).toString("hex");
  writeFileSync(file, fresh, { mode: 0o600 });
  cachedToken = fresh;
  return fresh;
}

export const STUDIO_TOKEN_HEADER = "x-aida-studio-token";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function hostnameOf(hostHeader: string | null): string | undefined {
  if (!hostHeader) return undefined;
  // Host header is "<hostname>[:<port>]"; IPv6 literals are bracketed, e.g. "[::1]:3000".
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(":")[0];
}

/** Extra hostnames the Studio accepts besides localhost, from `AIDA_STUDIO_ALLOWED_HOSTS`
 * (comma-separated, e.g. a dev proxy like "dev.example.com"). Opt-in only: anyone who can reach
 * an allowed host can edit this help app's files, so only list hosts behind your own sign-in. */
function allowedHostnames(): Set<string> {
  const extra = (process.env.AIDA_STUDIO_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...LOCAL_HOSTNAMES, ...extra]);
}

function isLocalHostname(hostname: string | undefined): boolean {
  return Boolean(hostname) && allowedHostnames().has(hostname!.toLowerCase());
}

/**
 * For the `/studio` page itself: the first host this request came through that the Studio doesn't
 * accept, or undefined when every one is allowed. Checks X-Forwarded-Host (set by a tunnel or
 * proxy, possibly a comma-separated chain) as well as Host, against the same allowlist
 * `assertStudioRequest` uses — so the page can say which line to add instead of loading forever
 * while Next's `allowedDevOrigins` (fed from the same variable in next.config.mjs) blocks its
 * scripts. Never loosens the API checks: they still run on every /studio/api/** call.
 */
export function blockedStudioHost(headers: Pick<Headers, "get">): string | undefined {
  const seen = [
    ...(headers.get("x-forwarded-host") ?? "").split(","),
    headers.get("host") ?? "",
  ]
    .map((h) => h.trim())
    .filter(Boolean);
  for (const host of seen) {
    const hostname = hostnameOf(host);
    if (!isLocalHostname(hostname)) return hostname;
  }
  return undefined;
}

/** The `.env.local` line that allows `hostname`. Deliberately built from the requesting host
 * alone: the blocked-host page is shown to anyone who reaches it, so it must never reveal which
 * hosts are already allowed (AIDA_STUDIO_ALLOWED_HOSTS). */
export function allowHostLine(hostname: string): string {
  return `AIDA_STUDIO_ALLOWED_HOSTS=${hostname}`;
}

// ---------------------------------------------------------------------------------------------
// Access key. The token above only stops other sites in the same browser: the /studio page hands
// it to whoever loads it. Once `aida init --tunnel-host` lists a tunnel host, anyone with the
// tunnel URL could load the page, take the token and edit walkthrough/page files, which the dev
// server compiles: remote code execution on the developer's machine.
//
// Route handlers can't see the socket's address: Next doesn't expose it (NextRequest.ip is gone),
// and it only copies it into X-Forwarded-For when the client sent none (`??=` in Next's
// base-server), so a client can claim `X-Forwarded-For: 127.0.0.1` along with `Host: localhost`.
// A raw TCP tunnel (ssh -R, bore) also arrives from 127.0.0.1 with no forwarded headers at all.
// So no header can prove a request is local, and the rules are:
//   - `npm run dev` binds the dev server to 127.0.0.1, so other machines can't connect directly.
//   - With `AIDA_STUDIO_KEY` set (init sets it with --tunnel-host), every Studio request needs
//     the access cookie, loopback included: a tunnel is indistinguishable from loopback.
//   - With no key, only a request that looks local is allowed; forwarded headers can only make a
//     request look remote, never local.
// The private link is `/studio/access#key=<key>`: the key sits in the URL fragment, which the
// browser never sends, so it never shows up in the dev server's request log. The access page
// POSTs it (same-origin fetch, JSON) to /studio/access, which checks it in constant time and sets
// an httpOnly, SameSite=Strict cookie holding a value derived from the key.

export const STUDIO_KEY_VAR = "AIDA_STUDIO_KEY";
export const STUDIO_ACCESS_COOKIE = "aida_studio_access";
export const STUDIO_ACCESS_PATH = "/studio/access";
/** How long the access cookie lasts: a working day; open the private link again after. */
export const STUDIO_ACCESS_MAX_AGE_SECONDS = 12 * 60 * 60;
/** Shorter keys count as unset (`aida init --tunnel-host` writes 43 characters). */
const MIN_KEY_LENGTH = 32;
export const NO_KEY_MESSAGE = "set AIDA_STUDIO_KEY (run aida init --tunnel-host again)";

function studioKey(): string | undefined {
  const key = (process.env[STUDIO_KEY_VAR] ?? "").trim();
  return key.length >= MIN_KEY_LENGTH ? key : undefined;
}

/** Constant-time string comparison (hashing first makes the lengths equal). */
export function sameSecret(a: string, b: string): boolean {
  const digest = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** The cookie holds a value derived from the key, not the key itself; changing the key revokes it. */
function accessCookieValue(key: string): string {
  return createHmac("sha256", key).update("aida-studio-access-v1").digest("base64url");
}

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackAddress(value: string): boolean {
  const v = value.trim().toLowerCase().replace(/^"|"$/g, "");
  const bare = v.startsWith("[") ? v.slice(1, v.indexOf("]") === -1 ? undefined : v.indexOf("]")) : v;
  return bare === "::1" || bare === "localhost" || /^(::ffff:)?127(\.\d{1,3}){3}$/.test(bare.replace(/:\d+$/, ""));
}

function splitList(value: string | null): string[] {
  return (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

/** Client-address headers proxies and tunnels add. Any non-loopback value means "remote". */
const CLIENT_ADDRESS_HEADERS = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip"];

/**
 * True when nothing about the request says it came from somewhere other than this machine: Host
 * and any X-Forwarded-Host are loopback, every client-address header (X-Forwarded-For, X-Real-IP,
 * CF-Connecting-IP, ...) and Forwarded `for=`/`host=` is loopback, and an Origin, if sent, is
 * loopback too. This is NOT proof of being local (see above: a client can forge every one of these
 * headers, and a raw tunnel looks the same), so it only ever decides access when no key is set,
 * where the loopback-only `npm run dev` binding is what keeps other machines out. The headers can
 * only make a request look remote.
 */
export function isLoopbackRequest(headers: Pick<Headers, "get">): boolean {
  const hosts = [headers.get("host") ?? "", ...splitList(headers.get("x-forwarded-host"))];
  if (!hosts.every((h) => LOOPBACK_HOSTNAMES.has((hostnameOf(h) ?? "").toLowerCase()))) return false;
  for (const name of CLIENT_ADDRESS_HEADERS) {
    if (!splitList(headers.get(name)).every(isLoopbackAddress)) return false;
  }
  const forwarded = headers.get("forwarded");
  if (forwarded) {
    for (const m of forwarded.matchAll(/\b(for|host)=("[^"]*"|[^;,\s]*)/gi)) {
      const value = m[2].replace(/^"|"$/g, "");
      const ok = m[1].toLowerCase() === "for" ? isLoopbackAddress(value) : LOOPBACK_HOSTNAMES.has((hostnameOf(value) ?? "").toLowerCase());
      if (!ok) return false;
    }
  }
  const origin = headers.get("origin");
  if (origin) {
    try {
      if (!LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export type StudioAccess = { ok: true } | { ok: false; reason: "no-key" | "locked" };

/** Whether this request may use the Studio. With a key set: only with a valid access cookie,
 * wherever the request came from. With no key: only when it looks local (`isLoopbackRequest`). */
export function studioAccess(headers: Pick<Headers, "get">): StudioAccess {
  const key = studioKey();
  if (key) {
    const cookie = readCookie(headers.get("cookie"), STUDIO_ACCESS_COOKIE);
    return cookie && sameSecret(cookie, accessCookieValue(key)) ? { ok: true } : { ok: false, reason: "locked" };
  }
  return isLoopbackRequest(headers) ? { ok: true } : { ok: false, reason: "no-key" };
}

const PLAIN_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

function plainPage(status: number, title: string, body: string, extra: { head?: string; script?: string } = {}): Response {
  const script = extra.script ? `<script>${extra.script}</script>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">${extra.head ?? ""}<title>${title}</title></head><body><h1>${title}</h1><p id="studio-access-status">${body}</p>${script}</body></html>`;
  const headers: Record<string, string> = { ...PLAIN_PAGE_HEADERS };
  if (extra.script) {
    const hash = createHash("sha256").update(extra.script).digest("base64");
    headers["content-security-policy"] += `; script-src 'sha256-${hash}'; connect-src 'self'`;
  }
  return new Response(html, { status, headers });
}

/** The 403 shown without access. Says nothing about this app: no token, no hosts, no file names. */
export function studioAccessDenied(reason: "no-key" | "locked"): Response {
  return reason === "no-key"
    ? plainPage(403, "Studio locked", `The Studio only opens on localhost until you ${NO_KEY_MESSAGE}, then restart the dev server.`)
    : plainPage(403, "Studio locked", "Open the Studio with its private access link.");
}

/**
 * Runs on the locked access page: takes `#key=<key>` from the fragment, drops it from the address
 * bar and history, POSTs it to this same path and, once the cookie is set, moves on to /studio.
 * The hop to /studio is a navigation started by this same-origin page, so the SameSite=Strict
 * cookie is sent even when the link itself was opened from another site.
 */
export const ACCESS_PAGE_SCRIPT =
  '(function(){var s=document.getElementById("studio-access-status");' +
  'var k=new URLSearchParams(location.hash.slice(1)).get("key");if(!k)return;' +
  'history.replaceState(null,"",location.pathname);s.textContent="Opening the Studio\\u2026";' +
  'fetch(location.pathname,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({key:k})})' +
  '.then(function(r){if(r.ok){location.replace("/studio")}else{s.textContent="That access link isn\'t valid. Open the Studio with its current private access link."}},' +
  'function(){s.textContent="Couldn\'t reach the dev server."})})()';

/**
 * GET /studio/access. With access already (the cookie, or loopback with no key set): on to
 * /studio. With a key set but no cookie: a 403 "locked" page whose script sends the link's
 * `#key=` (if any) back as a POST, so the key never appears in a URL the server sees or logs.
 */
export function studioAccessPage(request: Request): Response {
  const access = studioAccess(request.headers);
  if (access.ok) {
    return plainPage(200, "Opening the Studio", '<a href="/studio">Continue to the Studio</a>', {
      head: '<meta http-equiv="refresh" content="0;url=/studio">',
    });
  }
  if (access.reason === "no-key") return studioAccessDenied("no-key");
  return plainPage(403, "Studio locked", "Open the Studio with its private access link.", { script: ACCESS_PAGE_SCRIPT });
}

/** Whether the request reached the dev server as plain http on loopback, the one case where the
 * access cookie can't be `Secure` (anything through a tunnel or proxy is https to the browser). */
function plainHttpLoopback(request: Request): boolean {
  if (!isLoopbackRequest(request.headers)) return false;
  let proto = splitList(request.headers.get("x-forwarded-proto"))[0]?.toLowerCase();
  if (!proto) {
    try {
      proto = new URL(request.url).protocol.replace(/:$/, "");
    } catch {
      return false;
    }
  }
  return proto === "http";
}

function denied(status = 403): Response {
  return new Response(JSON.stringify({ error: "forbidden" }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** The access cookie, as POST /studio/access sets it. */
export function accessCookieHeader(key: string, secure: boolean): string {
  return [
    `${STUDIO_ACCESS_COOKIE}=${accessCookieValue(key)}`,
    "Path=/studio",
    `Max-Age=${STUDIO_ACCESS_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/**
 * POST /studio/access with `{"key": "<key>"}` (from the access page's script). Same-origin JSON
 * only: Origin must match the request's own host (Host or X-Forwarded-Host) or an allowed host,
 * Sec-Fetch-Site, when sent, must be same-origin, and Content-Type must be application/json. A
 * right key sets the access cookie (204); anything else is a 403 that sets nothing.
 */
export async function unlockStudio(request: Request): Promise<Response> {
  const key = studioKey();
  if (!key) return denied();
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return denied();
  const origin = request.headers.get("origin");
  if (!origin) return denied();
  let originHostname: string;
  try {
    originHostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return denied();
  }
  const ownHosts = [request.headers.get("host") ?? "", ...splitList(request.headers.get("x-forwarded-host"))]
    .map((h) => (hostnameOf(h) ?? "").toLowerCase())
    .filter(Boolean);
  if (!ownHosts.includes(originHostname) && !isLocalHostname(originHostname)) return denied();
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return denied();
  const text = await request.text();
  if (text.length > 1024) return denied();
  let given: unknown;
  try {
    given = (JSON.parse(text) as { key?: unknown })?.key;
  } catch {
    return denied();
  }
  if (typeof given !== "string" || !sameSecret(given, key)) return denied();
  return new Response(null, {
    status: 204,
    headers: { "set-cookie": accessCookieHeader(key, !plainHttpLoopback(request)), "cache-control": "no-store" },
  });
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function forbidden(): NextResponse {
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

/**
 * Guards every /studio/api/** handler against cross-site requests. In order: the request's own
 * Host must be localhost-ish or an allowed host (rules out DNS-rebinding-style attacks that spoof
 * Host); the request needs Studio access (`studioAccess`: the access cookie whenever a key is set);
 * an Origin header, if present, must also be localhost-ish or allowed (a fetch() call always sets
 * Origin; a plain top-level navigation doesn't, but those only ever GET); a body-bearing request
 * must declare `Content-Type: application/json` (closing the `text/plain` simple-request
 * loophole); and the per-process Studio token header must match, compared in constant time.
 * Returns a 403 `NextResponse` to return immediately, or `null` to continue handling the request.
 */
export function assertStudioRequest(request: Request): NextResponse | null {
  if (!isLocalHostname(hostnameOf(request.headers.get("host")))) {
    return forbidden();
  }

  if (!studioAccess(request.headers).ok) return forbidden();

  const origin = request.headers.get("origin");
  if (origin) {
    let originHostname: string;
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      return forbidden();
    }
    if (!isLocalHostname(originHostname)) return forbidden();
  }

  if (BODY_METHODS.has(request.method)) {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("application/json")) return forbidden();
  }

  if (!sameSecret(request.headers.get(STUDIO_TOKEN_HEADER) ?? "", getStudioToken())) return forbidden();

  return null;
}
