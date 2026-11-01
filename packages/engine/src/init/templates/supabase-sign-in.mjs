// Sign-in adapter for an app that uses Supabase Auth, written by `aida init`. Safe to edit:
// `aida init` never overwrites this file once it exists.
//
// Most apps can't complete a real sign-in during capture (emailed codes, magic links, OAuth,
// passkeys), so this adapter skips the sign-in screen. With the local Supabase stack's secret
// key it makes a one-time sign-in link for the persona's user (nothing is emailed, no password is
// changed), redeems it for a session, and puts that session where the app's Supabase client looks
// for it:
// - the `sb-<ref>-auth-token` cookie, for server-rendered apps on `@supabase/ssr` or
//   `@supabase/auth-helpers-nextjs` (split into `.0`, `.1`, ... cookies when it's long), and
// - the same key in the app's localStorage, for single-page apps on plain `@supabase/supabase-js`
//   (Vite, Lovable, Bolt).
//
// Before relying on it:
// - Local Supabase only (`supabase start`). It refuses an app or a Supabase API that isn't on this
//   machine, so a hosted project (`*.supabase.co`) is never touched.
// - Each walkthrough role needs a user that already exists in the local stack (seed it, e.g. in
//   `supabase/seed.sql`). Map the role to that user's email in USERS, or to its id when a
//   walkthrough changes the email (a walkthrough's `start.persona.email` wins over both).
// - Keys: the API URL and publishable (anon) key are read from the variables the app itself uses
//   (URL_VARS, ANON_KEY_VARS); the secret (service role) key from SECRET_KEY_VARS. Each is looked
//   for in the capture run's environment, then the app's development env files, never
//   `.env.production*`. When a key isn't there, it asks the Supabase CLI (`supabase status -o env`
//   in the app's folder), which prints the local stack's keys. Keys are held in memory only, never
//   written or logged.
// - If the app passes its own `storageKey` to createClient(), set STORAGE_KEY_OVERRIDE to it.
// - After redeeming the link it asks Supabase who the session belongs to and fails loudly unless
//   it's the persona's user, so a wrong key or user never captures a signed-out walkthrough.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app this help site documents, relative to this file. `aida init` filled it in. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "__APP_DIR__");

/** The app's env files this adapter may read, highest precedence first (the order `next dev` and
 * `vite` load them). Never add `.env.production*`. */
export const APP_ENV_FILES = [".env.development.local", ".env.local", ".env.development", ".env"];

/** Env vars the app's Supabase API URL may be in, first found wins. */
export const URL_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "VITE_SUPABASE_URL", "PUBLIC_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL", "SUPABASE_URL"];

/** Env vars the app's publishable (anon) key may be in, first found wins. */
export const ANON_KEY_VARS = [
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "PUBLIC_SUPABASE_ANON_KEY",
  "EXPO_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
];

/** Env vars the local stack's secret (service role) key may be in, first found wins. */
export const SECRET_KEY_VARS = ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"];

/** Set this if the app passes `auth: { storageKey }` to createClient(). */
export const STORAGE_KEY_OVERRIDE = undefined;

/** The page the adapter opens to write the session into the app's localStorage. Any page on the
 * app's origin works; the sign-in page is fine. */
export const STORAGE_PAGE = "/";

/** How long the session cookie lasts, in seconds (`@supabase/ssr`'s default is 400 days; the
 * Supabase client refreshes the session inside it). */
export const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/** `@supabase/ssr` and auth-helpers split a cookie longer than this many (URL-encoded) characters. */
export const MAX_CHUNK_SIZE = 3180;

// EDIT ME: walkthrough role -> the email of a user that exists in the local Supabase stack, or
// { id: "<user id>" } when a walkthrough changes that user's email (the id still finds them).
export const USERS = {
  // admin: "admin@example.com",
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Throws unless `url` is on this machine. `what` names it in the error ("app", "Supabase API"). */
export function assertLocal(url, what = "app") {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`sign-in: the ${what} address isn't a URL`);
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(
      `sign-in: refusing: the ${what} is on ${hostname}, not this machine; this adapter only signs in to a local app ` +
        `with the local Supabase stack (supabase start)`,
    );
  }
}

/** Parses a dotenv file: `KEY=value`, `export KEY=value`, quotes and trailing comments. */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    const quoted = raw.match(/^(["'`])(.*?)\1(\s+#.*)?$/);
    out[m[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "");
  }
  return out;
}

/** The app's env as its dev server sees it, minus production files: the capture run's environment
 * wins, then APP_ENV_FILES in order. Returns `get(name)` and `first(names)`. */
export function appEnv(env, appDir = APP_DIR, files = APP_ENV_FILES) {
  const fromFiles = {};
  for (const name of files) {
    if (/^\.env\.production/.test(name)) continue;
    const file = join(appDir, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, "utf8")))) {
      if (!(key in fromFiles)) fromFiles[key] = value;
    }
  }
  const get = (name) => (env?.[name] !== undefined && env[name] !== "" ? env[name] : fromFiles[name]);
  const first = (names) => {
    for (const name of names) {
      const value = get(name);
      if (value) return value;
    }
    return undefined;
  };
  return { get, first };
}

/** The local stack's settings from `supabase status -o env` run in the app's folder (the
 * project's own CLI first, then one on the PATH), or `{}` when there's no CLI or no stack. */
export function supabaseStatus(appDir = APP_DIR, run = execFileSync) {
  const attempts = [
    ["npx", ["--no-install", "supabase", "status", "-o", "env"]],
    ["supabase", ["status", "-o", "env"]],
  ];
  for (const [cmd, args] of attempts) {
    try {
      const out = run(cmd, args, { cwd: appDir, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
      const parsed = parseEnvFile(String(out));
      if (parsed.API_URL || parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY) return parsed;
    } catch {
      // No CLI here or the stack isn't running: try the next one.
    }
  }
  return {};
}

/** The Supabase API URL, publishable key and secret key: the app's own variables first, then the
 * CLI's view of the local stack. Throws a plain-English error naming what's missing. */
export function supabaseSettings(env, appDir = APP_DIR, status = () => supabaseStatus(appDir)) {
  const app = appEnv(env, appDir);
  let url = app.first(URL_VARS);
  let anonKey = app.first(ANON_KEY_VARS);
  let secretKey = app.first(SECRET_KEY_VARS);
  if (!url || !anonKey || !secretKey) {
    const s = status();
    url ??= s.API_URL;
    anonKey ??= s.PUBLISHABLE_KEY ?? s.ANON_KEY;
    secretKey ??= s.SECRET_KEY ?? s.SERVICE_ROLE_KEY;
  }
  const missing = [
    !url && `the API URL (${URL_VARS[0]})`,
    !anonKey && `the publishable key (${ANON_KEY_VARS[0]})`,
    !secretKey && `the secret key (${SECRET_KEY_VARS[1]})`,
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(
      `sign-in: couldn't find ${missing.join(", ")}. Start the local stack with \`supabase start\` in ${appDir}, or set ` +
        `the variable in the environment of the capture run. This adapter looks in the environment, in ` +
        `${APP_ENV_FILES.join(", ")} under ${appDir}, and in \`supabase status\`; it never reads .env.production files.`,
    );
  }
  return { url: url.replace(/\/+$/, ""), anonKey, secretKey };
}

/** The key supabase-js stores the session under: `sb-<first part of the API hostname>-auth-token`. */
export function storageKey(supabaseUrl, override = STORAGE_KEY_OVERRIDE) {
  if (override) return override;
  return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
}

/** How the app's server-side client encodes the session cookie: `@supabase/ssr` (0.5+) reads
 * `base64-<base64url JSON>`; `@supabase/auth-helpers-nextjs` without ssr reads URL-encoded JSON. */
export function cookieEncoding(appDir = APP_DIR) {
  try {
    const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!deps["@supabase/ssr"] && deps["@supabase/auth-helpers-nextjs"]) return "raw";
  } catch {
    // No readable package.json: assume @supabase/ssr.
  }
  return "base64url";
}

/** The session cookies: one `<key>` cookie when the value fits in MAX_CHUNK_SIZE, else `<key>.0`,
 * `<key>.1`, ... the way `@supabase/ssr` and auth-helpers write them. Returns `[name, value]` pairs
 * with values ready for a Cookie header (never splits a `%XX` escape). */
export function sessionCookies(key, session, encoding = "base64url", max = MAX_CHUNK_SIZE) {
  const json = JSON.stringify(session);
  const value = encoding === "raw" ? encodeURIComponent(json) : `base64-${Buffer.from(json, "utf8").toString("base64url")}`;
  if (value.length <= max) return [[key, value]];
  const chunks = [];
  let rest = value;
  while (rest.length > 0) {
    let end = Math.min(max, rest.length);
    const escape = rest.lastIndexOf("%", end - 1);
    if (escape > end - 3 && escape >= 0 && end < rest.length) end = escape;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  return chunks.map((chunk, i) => [`${key}.${i}`, chunk]);
}

/** The persona's user: its own email, else USERS[role]: an email, or `{ id: "<user id>" }` when a
 * walkthrough changes that user's email (then the id still finds them). */
export function personaUser(persona, users = USERS) {
  const entry = persona?.email ?? users[persona?.role];
  if (!entry) {
    throw new Error(`sign-in: no user for role ${JSON.stringify(persona?.role)}; add it to USERS in the sign-in adapter (or give the walkthrough's persona an email)`);
  }
  return typeof entry === "string" ? { email: entry } : { id: String(entry.id) };
}

/** Request headers for a Supabase key. New-style keys (`sb_publishable_...`, `sb_secret_...`) go in
 * `apikey` only; legacy JWT keys also go in `Authorization`. */
export function keyHeaders(key, bearer) {
  const headers = { apikey: key, "content-type": "application/json", accept: "application/json" };
  const token = bearer ?? (/^eyJ/.test(key) ? key : undefined);
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function call(url, init, what) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`sign-in: couldn't reach Supabase at ${new URL(url).origin} to ${what} (${err?.cause?.code ?? err?.message ?? err}). Is \`supabase start\` running?`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    const message = body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
    const err = new Error(`sign-in: Supabase refused to ${what}: ${message}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** The existing auth user for `{ email }` or `{ id }`, found with the admin API. Never creates
 * one: a missing user is an error. */
export async function findUser({ url, secretKey, user }) {
  const headers = keyHeaders(secretKey);
  if (user.id) {
    try {
      return await call(`${url}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, { headers }, "look up the persona's user");
    } catch (err) {
      if (err.status === 404) throw new Error(`sign-in: no user ${user.id} in the local Supabase stack; seed it first`);
      throw err;
    }
  }
  const want = user.email.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 100; page++) {
    const body = await call(`${url}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { headers }, "list users");
    const users = Array.isArray(body?.users) ? body.users : [];
    const found = users.find((u) => String(u.email ?? "").toLowerCase() === want);
    if (found) return found;
    if (users.length < perPage) break;
  }
  throw new Error(`sign-in: no user ${user.email} in the local Supabase stack; seed it first`);
}

/** Makes a one-time sign-in link for the user (admin API, nothing is emailed) and redeems it for a
 * session: `{ access_token, refresh_token, expires_in, expires_at, token_type, user }`. */
export async function createSession({ url, anonKey, secretKey, email, now = Date.now() }) {
  const link = await call(
    `${url}/auth/v1/admin/generate_link`,
    { method: "POST", headers: keyHeaders(secretKey), body: JSON.stringify({ type: "magiclink", email }) },
    "make a sign-in link",
  );
  const tokenHash = link?.hashed_token ?? link?.properties?.hashed_token;
  if (!tokenHash) throw new Error("sign-in: Supabase made a sign-in link without a token; is the local stack's auth service current?");
  let session;
  let lastError;
  // `email` is the current type for a magic link; older auth servers only know `magiclink`.
  for (const type of ["email", "magiclink"]) {
    try {
      session = await call(
        `${url}/auth/v1/verify`,
        { method: "POST", headers: keyHeaders(anonKey), body: JSON.stringify({ type, token_hash: tokenHash }) },
        "redeem the sign-in link",
      );
      break;
    } catch (err) {
      lastError = err;
      if (err.status !== 400 && err.status !== 422) throw err;
    }
  }
  if (!session?.access_token) throw lastError ?? new Error("sign-in: Supabase redeemed the sign-in link without a session");
  if (!session.expires_at && session.expires_in) session.expires_at = Math.floor(now / 1000) + Number(session.expires_in);
  return session;
}

/** Asks Supabase who the access token belongs to and throws unless it's `userId`. */
export async function verifySession({ url, anonKey, session, userId }) {
  const user = await call(`${url}/auth/v1/user`, { headers: keyHeaders(anonKey, session.access_token) }, "check the new session");
  if (String(user?.id ?? "") !== String(userId)) {
    throw new Error(`sign-in: the new session belongs to ${user?.email ?? user?.id ?? "no one"}, not user ${userId}; check USERS in the sign-in adapter`);
  }
  return user;
}

/** aida's sign-in adapter: makes a session for the persona's user in the local Supabase stack, then
 * puts it in the capture browser's cookies and the app's localStorage. A walkthrough with no
 * persona runs signed out. */
export default async function signIn({ page, context, baseUrl, persona, env }) {
  if (!persona) return;
  assertLocal(baseUrl, "app");
  const settings = supabaseSettings(env);
  assertLocal(settings.url, "Supabase API");
  const found = await findUser({ url: settings.url, secretKey: settings.secretKey, user: personaUser(persona) });
  if (!found?.email) throw new Error(`sign-in: user ${found?.id ?? "?"} has no email; Supabase can only make a sign-in link for an email user`);
  const session = await createSession({ ...settings, email: found.email });
  await verifySession({ url: settings.url, anonKey: settings.anonKey, session, userId: found.id });

  const key = storageKey(settings.url);
  const origin = new URL(baseUrl).origin;
  const secure = new URL(baseUrl).protocol === "https:";
  const expires = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  await context.addCookies(
    sessionCookies(key, session, cookieEncoding()).map(([name, value]) => ({ name, value, url: origin, sameSite: "Lax", secure, expires })),
  );

  // A single-page app's client reads localStorage instead. Written on a page of the app's own
  // origin so capture's saved sign-in state keeps it. A string, not a function: a transpiled
  // function can carry helper calls that don't exist in the page.
  await page.goto(new URL(STORAGE_PAGE, baseUrl).href, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).origin !== origin) {
    throw new Error(`sign-in: ${STORAGE_PAGE} left the app (now on ${new URL(page.url()).origin}); set STORAGE_PAGE in the sign-in adapter to a page on ${origin}`);
  }
  await page.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(session))})`);
}
