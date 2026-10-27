// Sign-in adapter for an app that uses Auth.js (next-auth), written by `aida init`. Safe to
// edit: `aida init` never overwrites this file once it exists.
//
// Most apps can't complete a real sign-in during capture (email links, OAuth, passkeys), so this
// adapter skips the sign-in screen: it mints the same encrypted session cookie Auth.js sets after
// a real sign-in, using the app's own installed Auth.js encoder (`next-auth/jwt` in v4,
// `@auth/core/jwt` in v5) and the app's own secret, and puts it in the capture browser.
//
// Before relying on it:
// - JWT sessions only. With `session: { strategy: "database" }` the cookie is a session id
//   looked up in the app's database, so a minted JWT won't work: add a test-only credentials
//   provider that's enabled in development, or insert a session row and set its id instead.
// - The claims below must match what the app's own `jwt` callback puts in the token. Edit
//   `claims(persona)` to match (for example a user id in `sub`, or a `role` claim).
// - The persona's user may need to exist in the app's database (for example a page that loads
//   the user by `token.sub`). Seed it in the app's local database first.
// - The secret must be the one the app server under capture uses. It's read from the capture
//   run's environment first, then from the app's `.env.local` and `.env` (the files both
//   `next dev` and `next start` load). Never from `.env.production*`: those hold production
//   secrets. If yours is only there, set AUTH_SECRET (v4: NEXTAUTH_SECRET) in the environment of
//   the capture run instead. The secret is held in memory only, never written or logged.
// - Never against production: it refuses any baseUrl that isn't this machine.
// - After setting the cookie it asks the app for `/api/auth/session` and fails loudly if the
//   app doesn't see the persona signed in, so a wrong secret or claim never captures a signed-out
//   walkthrough by mistake.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The app this help site documents, relative to this file. `aida init` filled it in. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "__APP_DIR__");

/** How long the minted session lasts, in seconds (Auth.js's own default is 30 days). */
export const MAX_AGE = 30 * 24 * 60 * 60;

/** Set this if the app overrides `cookies.sessionToken.name` in its Auth.js config. */
export const COOKIE_NAME_OVERRIDE = undefined;

/** Set this to true or false if the app sets `useSecureCookies` in its Auth.js config. */
export const USE_SECURE_COOKIES = undefined;

/** The app's Auth.js session endpoint. Change it if the app sets a custom `basePath`. */
export const SESSION_PATH = "/api/auth/session";

/** The app's env files this adapter may read, highest precedence first: the ones `next start`
 * and `next dev` both load. Capturing against `next dev` with the secret only in a development
 * file? Use [".env.development.local", ".env.local", ".env.development", ".env"]. Never add
 * `.env.production*`. */
export const APP_ENV_FILES = [".env.local", ".env"];

// ---------------------------------------------------------------------------------------------
// EDIT ME: the token claims for a persona. `persona` is the walkthrough's `start.persona` (or
// `signed_in_as`): { role, name, email }. Match the shape the app's `jwt` callback produces —
// Auth.js's default token is { name, email, picture, sub }, and `sub` is usually the user's
// database id, which you may need to look up or hard-code per persona.
// ---------------------------------------------------------------------------------------------
export function claims(persona) {
  const token = {
    name: persona?.name,
    email: persona?.email,
    sub: persona?.email,
    role: persona?.role,
  };
  return Object.fromEntries(Object.entries(token).filter(([, v]) => v !== undefined));
}

// EDIT ME if the app's `session` callback reshapes `session.user`: true when the session the app
// returns from SESSION_PATH is `persona`'s. By default the email must match, or the name when the
// persona has no email.
export function sessionMatches(session, persona) {
  const user = session?.user;
  if (!user || typeof user !== "object") return false;
  if (persona?.email) return String(user.email ?? "").toLowerCase() === persona.email.toLowerCase();
  if (persona?.name) return user.name === persona.name;
  return true;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Throws unless `baseUrl` is this machine — a minted session must never reach a real server. */
export function assertLocalBaseUrl(baseUrl) {
  let hostname;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`sign-in: baseUrl ${JSON.stringify(baseUrl)} isn't a URL`);
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `sign-in: refusing to mint a session cookie for ${hostname}; this adapter only signs in to an app on this machine (localhost)`,
    );
  }
}

/** Parses a dotenv file: `KEY=value`, `export KEY=value`, quotes and trailing comments. Records
 * whether each value is single-quoted (Next never expands `$` in those). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    const quoted = raw.match(/^(["'`])(.*?)\1(\s+#.*)?$/);
    out[m[1]] = quoted
      ? { value: quoted[2], literal: quoted[1] === "'" }
      : { value: raw.replace(/\s+#.*$/, ""), literal: false };
  }
  return out;
}

/** The app's env as its server sees it, minus production files: the capture run's environment
 * wins, then APP_ENV_FILES in order. `get(name)` expands `$VAR`, `${VAR}` and `${VAR:-default}`
 * the way Next does (environment first, then the files), so `AUTH_SECRET=${OTHER}` is read as
 * the app reads it, never as the literal text. */
export function appEnv(env, appDir = APP_DIR, files = APP_ENV_FILES) {
  const fromFiles = {};
  for (const name of files) {
    if (/^\.env\.production/.test(name)) continue;
    const file = join(appDir, name);
    if (!existsSync(file)) continue;
    const vars = parseEnvFile(readFileSync(file, "utf8"));
    for (const [key, v] of Object.entries(vars)) if (!(key in fromFiles)) fromFiles[key] = v;
  }
  const expand = (value, depth) =>
    value.replace(/(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g, (all, escaped, braced, fallback, bare) => {
      if (escaped) return all.slice(1);
      const v = lookup(braced ?? bare, depth + 1);
      return v === undefined || v === "" ? (fallback ?? "") : v;
    });
  const lookup = (name, depth = 0) => {
    if (env?.[name] !== undefined && env[name] !== "") return env[name];
    const v = fromFiles[name];
    if (!v) return undefined;
    if (v.literal || depth > 10) return v.value;
    return expand(v.value, depth);
  };
  return { get: (name) => lookup(name) };
}

/** The env var names Auth.js reads its secret from: v5 `AUTH_SECRET` then `NEXTAUTH_SECRET`;
 * v4 only `NEXTAUTH_SECRET`. */
export function secretVars(generation) {
  return generation >= 5 ? ["AUTH_SECRET", "NEXTAUTH_SECRET"] : ["NEXTAUTH_SECRET"];
}

/** The app's Auth.js secret for `generation`, from the environment, else APP_ENV_FILES. */
export function findSecret(env, appDir = APP_DIR, generation = 5) {
  const vars = secretVars(generation);
  const app = appEnv(env, appDir);
  for (const name of vars) {
    const secret = app.get(name);
    if (secret) return secret;
  }
  throw new Error(
    `sign-in: no ${vars.join(" or ")} found. Set ${vars[0]} in the environment of the capture run ` +
      `(the same secret the app server under capture uses). This adapter only looks in the environment ` +
      `and in ${APP_ENV_FILES.join(", ")} under ${appDir}; it never reads .env.production files.`,
  );
}

/** Whether Auth.js uses `__Secure-` cookies, by its own rule: `useSecureCookies` if set, else
 * the app's URL. v5 takes it from AUTH_URL or NEXTAUTH_URL, else the request's own URL; v4 from
 * NEXTAUTH_URL (or the request's URL when VERCEL or AUTH_TRUST_HOST is set), else
 * http://localhost:3000. */
export function usesSecureCookies(generation, baseUrl, env = {}, appDir = APP_DIR, override = USE_SECURE_COOKIES) {
  if (typeof override === "boolean") return override;
  const app = appEnv(env, appDir);
  const requestIsHttps = new URL(baseUrl).protocol === "https:";
  if (generation >= 5) {
    const url = app.get("AUTH_URL") || app.get("NEXTAUTH_URL");
    return url ? url.trim().startsWith("https://") : requestIsHttps;
  }
  if (app.get("VERCEL") || app.get("AUTH_TRUST_HOST")) return requestIsHttps;
  const url = app.get("NEXTAUTH_URL");
  return url ? url.trim().startsWith("https://") : false;
}

/** The session cookie Auth.js reads: `authjs.session-token` in v5, `next-auth.session-token` in
 * v4, with the `__Secure-` prefix when it uses secure cookies (see usesSecureCookies). */
export function sessionCookieName(generation, secure, override = COOKIE_NAME_OVERRIDE) {
  if (override) return override;
  const base = generation >= 5 ? "authjs.session-token" : "next-auth.session-token";
  return `${secure ? "__Secure-" : ""}${base}`;
}

function packageInfo(require, name) {
  let entry;
  try {
    entry = require.resolve(name);
  } catch {
    return undefined;
  }
  // Neither next-auth version exports ./package.json, so walk up from the resolved entry.
  for (let dir = dirname(entry); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.name === name) return { dir, version: pkg.version ?? "0.0.0" };
  }
  return undefined;
}

function tryResolve(require, specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

async function importEncoder(file, specifier) {
  const mod = await import(pathToFileURL(file).href);
  const encode = mod.encode ?? mod.default?.encode;
  if (typeof encode !== "function") throw new Error(`sign-in: ${specifier} has no encode()`);
  return encode;
}

/** The app's own Auth.js JWT encoder: `{ generation: 4 | 5, encode }`. */
export async function loadEncoder(appDir = APP_DIR) {
  const require = createRequire(join(appDir, "package.json"));
  const nextAuth = packageInfo(require, "next-auth");
  if (nextAuth && Number.parseInt(nextAuth.version, 10) < 5) {
    const file = tryResolve(require, "next-auth/jwt");
    if (file) return { generation: 4, encode: await importEncoder(file, "next-auth/jwt") };
  }
  // v5 (or @auth/core on its own): @auth/core may be nested under next-auth rather than hoisted.
  const requires = [require];
  if (nextAuth) requires.push(createRequire(join(nextAuth.dir, "package.json")));
  for (const r of requires) {
    const file = tryResolve(r, "@auth/core/jwt");
    if (file) return { generation: 5, encode: await importEncoder(file, "@auth/core/jwt") };
  }
  throw new Error(`sign-in: couldn't find next-auth or @auth/core installed in ${appDir}; run npm install there first`);
}

/** Mints the session cookie for `persona`. `encoder` and `now` are injectable for tests. */
export async function mintSessionCookie({ baseUrl, persona, env, appDir = APP_DIR, encoder, now = Date.now() }) {
  assertLocalBaseUrl(baseUrl);
  const { generation, encode } = encoder ?? (await loadEncoder(appDir));
  const secret = findSecret(env, appDir, generation);
  const secure = usesSecureCookies(generation, baseUrl, env, appDir);
  const name = sessionCookieName(generation, secure);
  const issuedAt = Math.floor(now / 1000);
  const token = { ...claims(persona), iat: issuedAt, exp: issuedAt + MAX_AGE };
  // v5 derives the encryption key from the cookie name (the salt); v4 uses an empty salt.
  const value = await encode({ token, secret, maxAge: MAX_AGE, salt: generation >= 5 ? name : "" });
  return {
    name,
    value,
    url: new URL(baseUrl).origin,
    httpOnly: true,
    sameSite: "Lax",
    // A `__Secure-` cookie must be Secure; browsers accept Secure cookies on http://localhost.
    secure,
    expires: issuedAt + MAX_AGE,
  };
}

/** Asks the app who's signed in (SESSION_PATH, with the browser context's cookies) and throws a
 * plain-English error unless it's `persona`, so a cookie the app rejects never turns into a
 * silently signed-out capture. */
export async function verifySession({ context, baseUrl, persona, cookieName, appDir = APP_DIR }) {
  const url = new URL(SESSION_PATH, baseUrl).href;
  const who = persona?.email ?? persona?.name ?? persona?.role ?? "the persona";
  let session;
  try {
    const res = await context.request.get(url, { headers: { accept: "application/json" } });
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    session = await res.json();
  } catch (err) {
    throw new Error(
      `sign-in: couldn't check the session at ${url} (${err?.message ?? err}). Is the app running there, ` +
        `and is SESSION_PATH in the sign-in adapter right for its Auth.js basePath?`,
    );
  }
  if (!session || typeof session !== "object" || !session.user) {
    const prod = [".env.production.local", ".env.production"].filter((f) => existsSync(join(appDir, f)));
    throw new Error(
      `sign-in: the app didn't accept the minted ${cookieName} cookie, so ${who} isn't signed in. ` +
        `Usually the secret differs from the one the app server under capture uses: set AUTH_SECRET ` +
        `(Auth.js v4: NEXTAUTH_SECRET) in the environment of the capture run to that same secret` +
        (prod.length ? ` (the app also has ${prod.join(" and ")}, which this adapter never reads)` : "") +
        `. Also check the app uses JWT sessions and that claims() matches its jwt callback.`,
    );
  }
  if (!sessionMatches(session, persona)) {
    const got = session.user.email ?? session.user.name ?? JSON.stringify(session.user);
    throw new Error(
      `sign-in: the app signed in ${got}, not ${who}. Check claims() and sessionMatches() in the ` +
        `sign-in adapter against the app's jwt and session callbacks.`,
    );
  }
  return session;
}

/** aida's sign-in adapter: puts the minted session cookie in the capture browser, then checks
 * the app sees the persona signed in. A walkthrough with no persona runs signed out. */
export default async function signIn({ context, baseUrl, persona, env }) {
  if (!persona) return;
  const cookie = await mintSessionCookie({ baseUrl, persona, env });
  await context.addCookies([cookie]);
  await verifySession({ context, baseUrl, persona, cookieName: cookie.name });
}
