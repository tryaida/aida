// Sign-in adapter for an app that uses better-auth, written by `aida init`. Safe to edit:
// `aida init` never overwrites this file once it exists.
//
// Most apps can't complete a real sign-in during capture (emailed codes, magic links, OAuth,
// passkeys), so this adapter skips the sign-in screen: it does what better-auth does after a real
// sign-in. It inserts a row in the app's session table for the persona's user and sets the signed
// session cookie (`better-auth.session_token` = `<token>.<HMAC-SHA256(token, secret) base64>`) in
// the capture browser.
//
// Before relying on it:
// - Database sessions in Postgres. It talks to the database with the app's own installed `pg`
//   package. Another database (MySQL, SQLite) needs `insertSession()` rewritten for its driver.
// - The table and column names below are better-auth's defaults (`session`, `user`,
//   camelCase columns). Many apps rename them, for example with Prisma's `@@map("sessions")`
//   and `@map("user_id")`: check the app's schema and edit SESSION_TABLE and USER_TABLE.
// - Each walkthrough role needs a user that already exists in the app's local database. Map the
//   role to that user's email in USERS (a walkthrough's `start.persona.email` wins over it).
// - The secret must be the one the app server under capture uses. It's read from the capture
//   run's environment first, then from the app's `.env.local` and `.env` (the files both
//   `next dev` and `next start` load). Never from `.env.production*`: those hold production
//   secrets. If the app passes `secret:` to betterAuth() from another variable, add it to
//   SECRET_VARS. The secret is held in memory only, never written or logged.
// - Never against production: it refuses an app or a database that isn't on this machine.
// - After setting the cookie it asks the app who's signed in (SESSION_PATH) and fails loudly
//   unless it's the persona's user, so a wrong secret, table or path never captures a signed-out
//   walkthrough by mistake.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The app this help site documents, relative to this file. `aida init` filled it in. */
export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "__APP_DIR__");

/** The app's env files this adapter may read, highest precedence first. Never add
 * `.env.production*`. */
export const APP_ENV_FILES = [".env.local", ".env"];

/** Env vars the app's better-auth secret may be in, first found wins. */
export const SECRET_VARS = ["BETTER_AUTH_SECRET", "AUTH_SECRET"];

/** The env var holding the app's database URL. */
export const DATABASE_VAR = "DATABASE_URL";

/** better-auth's session endpoint. Change it if the app sets a custom `basePath`
 * (e.g. `/api/better-auth/get-session`). */
export const SESSION_PATH = "/api/auth/get-session";

/** Set this if the app sets `advanced.cookiePrefix` or renames the session cookie. */
export const COOKIE_NAME_OVERRIDE = undefined;

/** How long the inserted session lasts, in seconds (better-auth's default is 7 days). */
export const MAX_AGE = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------------------------
// EDIT ME: the app's session and user tables, as its database names them. These are
// better-auth's defaults; an app with snake_case names would use, for example,
// { table: "sessions", id: "id", token: "token", userId: "user_id", expiresAt: "expires_at",
//   createdAt: "created_at", updatedAt: "updated_at" }.
// ---------------------------------------------------------------------------------------------
export const SESSION_TABLE = {
  table: "session",
  id: "id",
  token: "token",
  userId: "userId",
  expiresAt: "expiresAt",
  createdAt: "createdAt",
  updatedAt: "updatedAt",
};
export const USER_TABLE = { table: "user", id: "id", email: "email" };

// EDIT ME: walkthrough role -> the email of a user that exists in the app's local database.
export const USERS = {
  // admin: "admin@example.com",
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Throws unless `url` is on this machine. `what` names it in the error ("app", "database"). */
export function assertLocal(url, what = "app") {
  let hostname;
  try {
    // Database URLs (postgres://...) parse fine as URLs; only the hostname matters.
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`sign-in: the ${what} address isn't a URL`);
  }
  if (!LOCAL_HOSTNAMES.has(hostname)) {
    throw new Error(`sign-in: refusing: the ${what} is on ${hostname}, not this machine; this adapter only signs in to a local app with a local database`);
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

/** The app's env as its server sees it, minus production files: the capture run's environment
 * wins, then APP_ENV_FILES in order. Returns `get(name)`. */
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
  return { get: (name) => (env?.[name] !== undefined && env[name] !== "" ? env[name] : fromFiles[name]) };
}

/** The app's better-auth secret, from the environment, else APP_ENV_FILES. */
export function findSecret(env, appDir = APP_DIR) {
  const app = appEnv(env, appDir);
  for (const name of SECRET_VARS) {
    const secret = app.get(name);
    if (secret) return secret;
  }
  throw new Error(
    `sign-in: no ${SECRET_VARS.join(" or ")} found. Set ${SECRET_VARS[0]} in the environment of the capture run ` +
      `(the same secret the app server under capture uses), or add the app's own variable to SECRET_VARS. ` +
      `This adapter only looks in the environment and in ${APP_ENV_FILES.join(", ")} under ${appDir}; it never reads .env.production files.`,
  );
}

/** The session cookie better-auth reads: `better-auth.session_token`, with `__Secure-` when the
 * app is served over https. */
export function cookieName(baseUrl, override = COOKIE_NAME_OVERRIDE) {
  if (override) return override;
  return `${new URL(baseUrl).protocol === "https:" ? "__Secure-" : ""}better-auth.session_token`;
}

/** The signed cookie value better-auth expects: `<token>.<base64 HMAC-SHA256(token, secret)>`,
 * URL-encoded. */
export function signedCookieValue(token, secret) {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

/** The persona's email: its own, else USERS[role]. */
export function personaEmail(persona, users = USERS) {
  const email = persona?.email ?? users[persona?.role];
  if (!email) {
    throw new Error(`sign-in: no user for role ${JSON.stringify(persona?.role)}; add it to USERS in the sign-in adapter (or give the walkthrough's persona an email)`);
  }
  return email;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function loadPg(appDir) {
  try {
    return createRequire(join(appDir, "package.json"))("pg");
  } catch {
    throw new Error(
      `sign-in: couldn't load the "pg" package from ${appDir}. This adapter writes sessions to a Postgres database ` +
        `with the app's own pg install: install it there, or rewrite insertSession() for the app's database.`,
    );
  }
}

/** Inserts a session row for `email`'s user and returns its token. */
export async function insertSession({ databaseUrl, email, appDir = APP_DIR, now = Date.now() }) {
  const { Client } = loadPg(appDir);
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const u = USER_TABLE;
    const s = SESSION_TABLE;
    const { rows } = await db.query(
      `select ${quoteIdent(u.id)} as id from ${quoteIdent(u.table)} where lower(${quoteIdent(u.email)}) = lower($1)`,
      [email],
    );
    if (!rows[0]) throw new Error(`sign-in: no user ${email} in the app's database; seed it first`);
    const token = randomBytes(24).toString("base64url");
    await db.query(
      `insert into ${quoteIdent(s.table)} (${[s.id, s.token, s.userId, s.expiresAt, s.createdAt, s.updatedAt].map(quoteIdent).join(", ")}) values ($1, $2, $3, $4, $5, $5)`,
      [`aida-${randomBytes(8).toString("hex")}`, token, rows[0].id, new Date(now + MAX_AGE * 1000), new Date(now)],
    );
    return token;
  } finally {
    await db.end();
  }
}

/** Asks the app who's signed in and throws a plain-English error unless it's `email`. */
export async function verifySession({ context, baseUrl, email }) {
  const url = new URL(SESSION_PATH, baseUrl).href;
  let session;
  try {
    const res = await context.request.get(url, { headers: { accept: "application/json" } });
    if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
    session = await res.json();
  } catch (err) {
    throw new Error(
      `sign-in: couldn't check the session at ${url} (${err?.message ?? err}). Is the app running there, and is ` +
        `SESSION_PATH in the sign-in adapter right for its better-auth basePath?`,
    );
  }
  const got = session?.user?.email;
  if (String(got ?? "").toLowerCase() !== email.toLowerCase()) {
    throw new Error(
      `sign-in: the app didn't accept the session cookie for ${email} (it sees ${got ?? "no one"} signed in). ` +
        `Check the secret matches the app server's, and the cookie name and SESSION_PATH in the sign-in adapter.`,
    );
  }
  return session;
}

/** aida's sign-in adapter: inserts a session for the persona's user, puts its cookie in the
 * capture browser, then checks the app sees that user signed in. A walkthrough with no persona
 * runs signed out. */
export default async function signIn({ context, baseUrl, persona, env }) {
  if (!persona) return;
  assertLocal(baseUrl, "app");
  const app = appEnv(env);
  const databaseUrl = app.get(DATABASE_VAR);
  if (!databaseUrl) throw new Error(`sign-in: no ${DATABASE_VAR} found in the environment or the app's env files`);
  assertLocal(databaseUrl, "database");
  const secret = findSecret(env);
  const email = personaEmail(persona);
  const token = await insertSession({ databaseUrl, email });
  await context.addCookies([
    {
      name: cookieName(baseUrl),
      value: signedCookieValue(token, secret),
      url: new URL(baseUrl).origin,
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(baseUrl).protocol === "https:",
      expires: Math.floor(Date.now() / 1000) + MAX_AGE,
    },
  ]);
  await verifySession({ context, baseUrl, email });
}
