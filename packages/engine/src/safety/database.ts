// App database guard (decisions #27; build-plan.md M24). capture/write-guard.ts only checks the
// app's web address, so an app on `localhost` whose `.env` points at a live hosted database
// passed it: capture would have created test records in production. This reads every database
// setting the app may start with and refuses unless each one is on this machine, or the config
// opts that exact database in.
//
// What's checked:
//   - `app.database.url` in aida.config (a string or a function returning one): the URL the
//     capture server is started with, when a script starts it with its own database.
//   - Every database-looking setting in `process.env` and in every env file of the app directory
//     and its parents up to the git root (safety/env.ts). Precedence doesn't matter: a remote
//     value in any of them refuses, because frameworks disagree on which file wins and aida's
//     own env isn't the env of a separately started dev server.
//   - "Database-looking": a database variable name (`isDatabaseVariable`), or a value with a
//     database scheme, a keyword connection string or a hosted database provider's host.
//
// Opt-ins, each bound to one exact thing:
//   - `app.database.throwaway`: databases that are disposable copies: `host`, `host/database`,
//     `user@host` (required on a shared host such as a Supabase pooler, PlanetScale or Prisma,
//     since the host alone covers every customer's project), plus `?endpoint=<id>` /
//     `?reference=<ref>` when the setting's `options` routes to another project; or
//     `#<fingerprint>` of any of those. A host-only entry that would cover several databases on
//     that host is refused with a `host/database` suggestion.
//   - `app.database.ignoreEnv`: env settings the capture server doesn't use because it's started
//     with `app.database.url`, each bound to what the setting points at now:
//     `.env:DATABASE_URL@<host>` or `.env:DATABASE_URL#<fingerprint>`. Pointing the setting
//     anywhere else refuses again. Only honoured with `app.database.url`. Also the explicit
//     acknowledgement for a secrets manager that injects settings at run time (`doppler.yaml#…`,
//     `.env:DATABASE_URL#…` for an op:// reference).
//
// Also refused: Doppler/Infisical config files and op:// references (secrets are injected at run
// time, so aida can't see the database).
//
// Nothing here holds or prints a password, token or full URL: findings carry the source,
// variable name, host, port and database name only; the user name appears only in a shared
// host's opt-in value, where it names the project.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AppDatabaseConfig } from "../config/types.js";
import {
  classifyDatabaseSetting,
  classifyFirebaseProject,
  classifyHost,
  fingerprint,
  injectedSetting,
  isSecretReference,
  isSharedHost,
  looksLikeDatabaseValue,
  normaliseHost,
  providerFor,
  PROXY_PORTS,
} from "./classify.js";
import type { ParsedDatabaseSetting } from "./classify.js";
import { collectAppEnv, findSecretInjectors } from "./env.js";
import type { AppEnvValue } from "./env.js";
import type { OutboundCheck } from "./outbound.js";

/**
 * Per setting: "local", "throwaway" (opted in), "remote" (refused), "unreadable" (a database
 * setting aida couldn't read: refused). Overall, also "unknown": no database setting found.
 */
export type AppDatabaseStatus = "local" | "throwaway" | "remote" | "unreadable" | "unknown";

/** One database setting the app may start with. Safe to print and to put in `--json` output. */
export interface AppDatabaseFinding {
  /** `config app.database.url`, `process.env.DATABASE_URL`, `.env.local:DATABASE_URL` or
   * `../../.env:DATABASE_URL` (a parent directory's file). */
  source: string;
  /** "secrets-manager": a Doppler/Infisical config file (`source` is the file). */
  from: "config" | "process-env" | "env-file" | "secrets-manager";
  /** Variable name; unset for `app.database.url`. */
  variable?: string;
  status: Exclude<AppDatabaseStatus, "unknown">;
  /** Listed in `app.database.ignoreEnv`: not counted. */
  ignored?: boolean;
  /** Host(s), comma-separated for a host list; unset when aida couldn't tell. */
  host?: string;
  port?: string;
  database?: string;
  /** Hosted provider recognised from the host, e.g. "Neon". */
  provider?: string;
  /** Plain-English remark, e.g. a single-label host or why the value couldn't be read. */
  note?: string;
}

export interface AppDatabaseCheck {
  /** "remote" when any counted setting points off this machine and isn't opted in;
   * "unreadable" when a database setting couldn't be read; "unknown" when nothing database-like
   * was found; else "throwaway" or "local". */
  status: AppDatabaseStatus;
  /** True when capture must not run ("remote" or "unreadable"). */
  refuse: boolean;
  findings: AppDatabaseFinding[];
  /** One plain-English paragraph saying what aida found. */
  message: string;
  /** What to do about it (empty when nothing needs doing). */
  suggestions: string[];
  /** Things worth saying that don't change `status` (an opt-in entry that was ignored). */
  warnings: string[];
  /** The app directory whose env files were read, when one was found. */
  appDir?: string;
  appDirFrom?: AppDirSource;
  /** Accepted throwaway opt-ins (`host`, `user@host`, `host/database`, `#fingerprint`), config +
   * `AIDA_THROWAWAY_DATABASE_HOST`. */
  throwawayHosts: string[];
  /** The settings `app.database.ignoreEnv` took out of the count (sources, e.g. `.env:DATABASE_URL`). */
  ignoredEnv: string[];
}

export type AppDirSource = "app.dir" | "impact.app" | "impact.appRepo" | "config parent";

/** The slice of a config this check reads. A `ResolvedConfig` fits; so does a hand-built one. */
export interface AppSafetyConfig {
  configDir?: string;
  app?: { dir?: string; database?: AppDatabaseConfig; outbound?: "dry-run"; allowLivePayments?: string[] };
  impact?: { app?: string; appRepo?: string };
}

export interface CheckAppDatabaseOptions {
  config?: AppSafetyConfig;
  /** Overrides the app directory the config would give (e.g. `aida init`'s app repo). */
  appDir?: string;
  /** Default `process.env`. */
  env?: Record<string, string | undefined>;
}

/** Variables that hold an app's database connection, beyond the name patterns below. */
export const DATABASE_VARIABLES = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "PGHOST",
  "SUPABASE_URL",
  "MONGODB_URI",
  "MONGODB_URL",
  "MONGO_URI",
  "MONGO_URL",
  "MYSQL_URL",
  "LIBSQL_URL",
  "CONVEX_URL",
  "FIREBASE_PROJECT_ID",
  "REDIS_URL",
  "KV_URL",
  "UPSTASH_REDIS_REST_URL",
  "POCKETBASE_URL",
  "PB_URL",
  "APPWRITE_ENDPOINT",
]);

/** Public-env prefixes frameworks add (`NEXT_PUBLIC_SUPABASE_URL`, `VITE_SUPABASE_URL`). */
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_|NUXT_PUBLIC_|NUXT_|GATSBY_|STORYBOOK_)/;

/** Variables whose value is a bare host (`DATABASE_HOST=aws.connect.psdb.cloud`,
 * `DB_SERVER=tcp:x.database.windows.net,1433`, `PGHOSTADDR=10.0.0.5`). */
function isHostVariable(name: string): boolean {
  const n = name.replace(PUBLIC_PREFIX, "");
  return (
    n === "PGHOST" ||
    n === "PGHOSTADDR" ||
    /(^|_)(DATABASE|DB|PG|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MSSQL|SQLSERVER|MONGO|MONGODB|REDIS)_(HOST|HOSTNAME|HOSTADDR|SERVER)$/.test(n)
  );
}

/** SQL Server style `tcp:host\\instance,port` to `host:port`. */
function serverHost(value: string): string {
  const m = /^\s*(?:tcp:)?([^,\\\s]+)(?:\\[^,\s]*)?(?:,(\d+))?\s*$/i.exec(value);
  return m ? (m[2] ? `${m[1]}:${m[2]}` : m[1]) : value;
}

/**
 * True for a variable that names the app's database: the list above, `*DATABASE_URL`,
 * `DATABASE_URL_*`, `*_DB_URL`, `DB_URL`, `*_DB_URI`, `*DATABASE_HOST`, `*_DB_HOST`,
 * `*_DB_SERVER`, `PGHOSTADDR`, Turso/libSQL URLs, Supabase/Convex/PocketBase/Appwrite URLs, Redis
 * and Vercel KV/Upstash URLs, a Firebase config, with or without a public prefix (`VITE_`,
 * `NEXT_PUBLIC_`, `PUBLIC_`, `EXPO_PUBLIC_`, ...).
 */
export function isDatabaseVariable(name: string): boolean {
  const n = name.replace(PUBLIC_PREFIX, "");
  return (
    DATABASE_VARIABLES.has(n) ||
    n.endsWith("DATABASE_URL") ||
    n.startsWith("DATABASE_URL_") ||
    /(^|_)DB_(URL|URI)$/.test(n) ||
    /^(TURSO|LIBSQL)_.*URL$/.test(n) ||
    /(^|_)(SUPABASE|CONVEX)_URL$/.test(n) ||
    /(^|_)FIREBASE_PROJECT_ID$/.test(n) ||
    /(^|_)FIREBASE(_WEBAPP)?_CONFIG$/.test(n) ||
    /(^|_)REDIS(_REST)?_(URL|URI)$/.test(n) ||
    /(^|_)KV(_REST_API)?_URL$/.test(n) ||
    /(^|_)(POCKETBASE|PB)_URL$/.test(n) ||
    /(^|_)APPWRITE_(ENDPOINT|URL)$/.test(n) ||
    isHostVariable(n)
  );
}

/** Env var that opts throwaway hosts in without a config change (comma-separated). */
export const THROWAWAY_ENV = "AIDA_THROWAWAY_DATABASE_HOST";

/**
 * Finds the app's own directory. Order: `app.dir` (relative to the config file), `impact.app`
 * (relative to `impact.appRepo`, else the config file), `impact.appRepo`, then the config file's
 * parent directory when it has a package.json.
 */
export function resolveAppDir(config: AppSafetyConfig | undefined): { dir: string; from: AppDirSource } | undefined {
  if (!config) return undefined;
  const base = config.configDir ?? process.cwd();
  if (config.app?.dir) return { dir: resolve(base, config.app.dir), from: "app.dir" };
  const repo = config.impact?.appRepo ? resolve(base, config.impact.appRepo) : undefined;
  if (config.impact?.app) {
    return { dir: isAbsolute(config.impact.app) ? config.impact.app : resolve(repo ?? base, config.impact.app), from: "impact.app" };
  }
  if (repo) return { dir: repo, from: "impact.appRepo" };
  if (config.configDir) {
    const parent = dirname(config.configDir);
    if (parent !== config.configDir && existsSync(join(parent, "package.json"))) return { dir: parent, from: "config parent" };
  }
  return undefined;
}

/** A throwaway opt-in: `[user@]host[/database][?endpoint=<id>|?reference=<ref>]`, or `#<fingerprint>`. */
interface OptIn {
  text: string;
  host?: string;
  user?: string;
  database?: string;
  route?: string;
  fp?: string;
}

/** Splits `[user@]host[/database][?route]`. Undefined when it isn't that shape. */
function parseTarget(entry: string): { host: string; user?: string; database?: string; route?: string } | undefined {
  let rest = entry.trim();
  let route: string | undefined;
  const q = rest.indexOf("?");
  if (q >= 0) {
    const m = /^(endpoint|project|reference)=([a-z0-9._-]+)$/i.exec(rest.slice(q + 1));
    if (!m) return undefined;
    route = `${m[1].toLowerCase() === "reference" ? "reference" : "endpoint"}=${m[2].toLowerCase()}`;
    rest = rest.slice(0, q);
  }
  const at = rest.indexOf("@");
  const user = at >= 0 ? rest.slice(0, at).trim().toLowerCase() : undefined;
  const hostDb = at >= 0 ? rest.slice(at + 1) : rest;
  let host = hostDb;
  let database: string | undefined;
  // `/cloudsql/<instance>` is a host that starts with a slash.
  const slash = hostDb.startsWith("/") ? -1 : hostDb.indexOf("/");
  if (slash >= 0) {
    host = hostDb.slice(0, slash);
    database = hostDb.slice(slash + 1);
    if (database === "" || database.includes("/")) return undefined;
  }
  host = normaliseHost(host);
  if (host === "") return undefined;
  return { host, user, database, route };
}

function targetText(t: { host: string; user?: string; database?: string; route?: string }): string {
  return `${t.user ? `${t.user}@` : ""}${t.host}${t.database !== undefined ? `/${t.database}` : ""}${t.route ? `?${t.route}` : ""}`;
}

/** `need` (`[user@]host[?route]`) with `/database` added before the route. */
function withDatabase(need: string, database: string | undefined): string {
  if (database === undefined) return need;
  const q = need.indexOf("?");
  return q >= 0 ? `${need.slice(0, q)}/${database}${need.slice(q)}` : `${need}/${database}`;
}

/** `app.database.throwaway` plus `AIDA_THROWAWAY_DATABASE_HOST`, normalised. Wildcards and a
 * bare shared host are dropped, with the reason in `problems`. */
function throwawayOptIns(config: AppSafetyConfig | undefined, env: Record<string, string | undefined>, problems: string[]): OptIn[] {
  const raw = config?.app?.database?.throwaway;
  const listed = [...(Array.isArray(raw) ? raw : raw ? [raw] : []), ...(env[THROWAWAY_ENV] ?? "").split(",")]
    .map((h) => String(h).trim())
    .filter((h) => h !== "");
  const out: OptIn[] = [];
  for (const entry of listed) {
    if (/^#[0-9a-f]{10}$/i.test(entry)) {
      const text = entry.toLowerCase();
      if (!out.some((o) => o.text === text)) out.push({ text, fp: text.slice(1) });
      continue;
    }
    const t = /\*/.test(entry) ? undefined : parseTarget(entry);
    if (!t || /[*?]/.test(t.host) || (t.database !== undefined && /[*?]/.test(t.database))) {
      problems.push(
        `Ignoring throwaway "${entry}": list exact databases (host, host/database, user@host or #fingerprint); wildcards aren't allowed.`,
      );
      continue;
    }
    if (t.user !== undefined && (t.user === "" || t.user.includes(":"))) {
      problems.push(`Ignoring throwaway "${t.host}": write it as user@host, with no password.`);
      continue;
    }
    if (isSharedHost(t.host) && !t.user) {
      problems.push(
        `Ignoring throwaway "${t.host}": many customers' databases share that host, so the host alone would also cover your ` +
          `live project. Name the database's user as well, e.g. "postgres.<project-ref>@${t.host}" for a Supabase pooler.`,
      );
      continue;
    }
    const text = targetText(t);
    if (!out.some((o) => o.text === text)) out.push({ text, ...t });
  }
  return out;
}

/** An `app.database.ignoreEnv` entry: a setting plus what it points at (`@target` or `#fingerprint`). */
interface IgnoreEntry {
  text: string;
  /** Finding source (`process.env:X` normalised to `process.env.X`). */
  source: string;
  mark?: "@" | "#";
  target?: string;
}

function ignoreEnvEntries(config: AppSafetyConfig | undefined): IgnoreEntry[] {
  const raw = config?.app?.database?.ignoreEnv;
  const list = Array.isArray(raw) ? raw : raw ? [raw as unknown as string] : [];
  const out: IgnoreEntry[] = [];
  for (const e of list) {
    const text = String(e).trim();
    if (text === "") continue;
    const i = text.search(/[@#]/);
    const source = (i >= 0 ? text.slice(0, i) : text).replace(/^process\.env:/, "process.env.");
    const entry: IgnoreEntry = i >= 0 ? { text, source, mark: text[i] as "@" | "#", target: text.slice(i + 1).trim().toLowerCase() } : { text, source };
    if (!out.some((o) => o.text === text)) out.push(entry);
  }
  return out;
}

/** The forms a setting can be named by: its identity, and with `/database` for one host. */
function identityForms(parsed: ParsedDatabaseSetting): string[] {
  if (!parsed.identity) return [];
  const forms = [parsed.identity];
  if (parsed.database !== undefined && !parsed.identity.includes(",")) forms.push(withDatabase(parsed.identity, parsed.database));
  return forms;
}

function bindingMatches(entry: IgnoreEntry, parsed: ParsedDatabaseSetting): boolean {
  if (!entry.mark || !entry.target) return false;
  const forms = identityForms(parsed);
  if (entry.mark === "#") return forms.some((f) => fingerprint(f) === entry.target);
  return forms.some((f) => f.toLowerCase() === entry.target);
}

/** The `ignoreEnv` entry to suggest for a setting: its fingerprint form. */
function ignoreEntryFor(c: Checked): string | undefined {
  if (!c.parsed.identity) return undefined;
  return `${c.finding.source.replace(/^process\.env\./, "process.env:")}#${fingerprint(c.parsed.identity)}`;
}

interface Checked {
  finding: AppDatabaseFinding;
  parsed: ParsedDatabaseSetting;
}

function statusFor(parsed: ParsedDatabaseSetting, optIns: OptIn[]): AppDatabaseFinding["status"] {
  if (parsed.kind === "unknown") return "unreadable";
  if (parsed.kind === "remote" && parsed.unboundHosts.length === 0 && parsed.optIns.every((need) => optedIn(need, parsed.database, optIns))) {
    return "throwaway";
  }
  return parsed.kind;
}

function toFinding(base: Pick<AppDatabaseFinding, "source" | "from" | "variable">, parsed: ParsedDatabaseSetting, optIns: OptIn[]): Checked {
  const finding: AppDatabaseFinding = { ...base, status: statusFor(parsed, optIns) };
  if (parsed.hosts.length > 0) finding.host = parsed.hosts.join(",");
  if (parsed.port) finding.port = parsed.port;
  if (parsed.database) finding.database = parsed.database;
  if (parsed.provider) finding.provider = parsed.provider;
  if (parsed.note) finding.note = parsed.note;
  return { finding, parsed };
}

/** Does one opt-in cover `need` (`[user@]host[?route]`) on `database`? Exact host; the user too
 * when it names one (required on a shared host); the database when it names one; the same
 * `?endpoint=`/`?reference=` route (or none). */
function optInCovers(o: OptIn, need: string, database: string | undefined): boolean {
  if (o.fp) return fingerprint(need) === o.fp || (database !== undefined && fingerprint(withDatabase(need, database)) === o.fp);
  const t = parseTarget(need);
  if (!t) return false;
  if (o.host !== t.host) return false;
  if (o.user === undefined ? isSharedHost(t.host) : o.user !== t.user) return false;
  if ((o.route ?? "") !== (t.route ?? "")) return false;
  return o.database === undefined || o.database === database;
}

function optedIn(need: string, database: string | undefined, optIns: OptIn[]): boolean {
  return optIns.some((o) => optInCovers(o, need, database));
}

/** The user name a bare host setting goes with: `DATABASE_USERNAME` next to `DATABASE_HOST`. */
function siblingUser(v: AppEnvValue): string | undefined {
  const candidates =
    v.variable === "PGHOST" || v.variable === "PGHOSTADDR"
      ? ["PGUSER"]
      : ["USERNAME", "USER"].map((u) => v.variable.replace(/(HOST(NAME|ADDR)?|SERVER)$/, u));
  for (const c of candidates) {
    const found = v.siblings(c);
    if (found) return found;
  }
  return undefined;
}

/** The Appwrite project an `APPWRITE_ENDPOINT` goes with: Appwrite Cloud's host is shared. */
function appwriteProject(v: AppEnvValue): string | undefined {
  for (const suffix of ["PROJECT_ID", "PROJECT"]) {
    const found = v.siblings(v.variable.replace(/(ENDPOINT|URL)$/, suffix));
    if (found) return found;
  }
  return undefined;
}

/** Names that hold a key or password, not a connection: an op:// reference there doesn't hide a database. */
const KEY_LIKE = /(KEY|SECRET|TOKEN|PASSWORD|PASS|PWD|SALT|_ID)$/;

/** Which env values the database check reads. */
function isDatabaseCandidate(name: string, value: string): boolean {
  if (name === THROWAWAY_ENV) return false; // aida's own opt-in, not an app setting
  return isDatabaseVariable(name) || looksLikeDatabaseValue(value) || (isSecretReference(value) && !KEY_LIKE.test(name));
}

function fromEnvValue(v: AppEnvValue, optIns: OptIn[]): Checked {
  const value = v.value.trim();
  let parsed: ParsedDatabaseSetting;
  if (isSecretReference(value)) {
    parsed = injectedSetting("1Password", value, "an op:// reference");
  } else if (/(^|_)FIREBASE_PROJECT_ID$/.test(v.variable)) {
    parsed = classifyFirebaseProject(v.variable, value);
  } else if (isHostVariable(v.variable) && !value.includes("://")) {
    const bare = /SERVER$/.test(v.variable) ? serverHost(value) : value;
    parsed = classifyDatabaseSetting(v.variable, bare, { bareHost: true, user: siblingUser(v) });
  } else if (/APPWRITE_(ENDPOINT|URL)$/.test(v.variable)) {
    parsed = classifyDatabaseSetting(v.variable, value, { user: appwriteProject(v) });
  } else {
    parsed = classifyDatabaseSetting(v.variable, value);
  }
  return toFinding({ source: v.source, from: v.from, variable: v.variable }, parsed, optIns);
}

function where(f: AppDatabaseFinding): string {
  let s = f.host ?? "an unknown host";
  if (f.port) s += `:${f.port}`;
  if (f.database) s += `/${f.database}`;
  return s;
}

function overallStatus(counted: AppDatabaseFinding[]): AppDatabaseStatus {
  if (counted.length === 0) return "unknown";
  if (counted.some((f) => f.status === "remote")) return "remote";
  if (counted.some((f) => f.status === "unreadable")) return "unreadable";
  if (counted.some((f) => f.status === "throwaway")) return "throwaway";
  return "local";
}

/**
 * Reads every database setting the app may start with and classifies it (see the file comment).
 * Async because `app.database.url` may be a function. Throws only when that function throws.
 */
export async function checkAppDatabase(opts: CheckAppDatabaseOptions = {}): Promise<AppDatabaseCheck> {
  const env = opts.env ?? process.env;
  const config = opts.config;
  const warnings: string[] = [];
  const optInProblems: string[] = [];
  const optIns = throwawayOptIns(config, env, optInProblems);

  const resolvedDir = opts.appDir ? { dir: resolve(opts.appDir), from: "app.dir" as AppDirSource } : resolveAppDir(config);
  const appDir = resolvedDir?.dir;
  if (appDir && !existsSync(appDir)) {
    warnings.push(`The app directory ${appDir} (from ${resolvedDir!.from}) doesn't exist, so aida couldn't read the app's env files.`);
  }
  const readableDir = appDir && existsSync(appDir) ? appDir : undefined;

  // A database variable name, a value that looks like a database connection, or an op:// reference.
  const appEnv = collectAppEnv(readableDir, env, isDatabaseCandidate);

  let configUrl: string | undefined;
  const urlSetting = config?.app?.database?.url;
  if (typeof urlSetting === "function") {
    try {
      configUrl = await urlSetting();
    } catch {
      // The error text may contain the URL; don't repeat it.
      throw new Error("app.database.url in aida.config threw an error; fix it, or set app.database.url to a string");
    }
  } else if (typeof urlSetting === "string") {
    configUrl = urlSetting;
  }
  const hasConfigUrl = typeof configUrl === "string" && configUrl.trim() !== "";

  const checked: Checked[] = [];
  if (hasConfigUrl) checked.push(toFinding({ source: "config app.database.url", from: "config" }, classifyDatabaseSetting(undefined, configUrl!), optIns));
  for (const v of appEnv.values) checked.push(fromEnvValue(v, optIns));
  // Doppler/Infisical: `doppler run -- next dev` injects settings aida can't see. Bound to the
  // config file's content, so switching project or config refuses again.
  if (readableDir) {
    for (const inj of findSecretInjectors(readableDir)) {
      checked.push(toFinding({ source: inj.label, from: "secrets-manager" }, injectedSetting(inj.tool, `${inj.tool}:${inj.content}`, inj.label), optIns));
    }
  }

  // ignoreEnv: only with app.database.url, which says what the capture server uses instead. Each
  // entry is bound to what its setting points at now.
  const ignore = ignoreEnvEntries(config);
  const ignoredEnv: string[] = [];
  if (ignore.length > 0 && !hasConfigUrl) {
    optInProblems.push(
      "Ignoring app.database.ignoreEnv: it only applies together with app.database.url (the URL the capture server is started with instead).",
    );
  } else if (ignore.length > 0) {
    const used = new Set<string>();
    for (const c of checked) {
      if (c.finding.from === "config") continue;
      const entries = ignore.filter((e) => e.source === c.finding.source);
      if (entries.length === 0) continue;
      for (const e of entries) used.add(e.text);
      if (entries.some((e) => bindingMatches(e, c.parsed))) {
        c.finding.ignored = true;
        ignoredEnv.push(c.finding.source);
      } else {
        optInProblems.push(staleIgnoreEntry(entries[0], c));
      }
    }
    const unused = ignore.filter((e) => !used.has(e.text)).map((e) => e.text);
    if (unused.length > 0) warnings.push(`app.database.ignoreEnv lists ${list(unused)}, which aida didn't find; remove ${unused.length === 1 ? "it" : "them"} if no longer needed.`);
  }

  // A host-only throwaway entry that would cover several databases on that host covers none.
  const counted = checked.filter((c) => !c.finding.ignored);
  const ambiguous = new Set<OptIn>();
  for (const o of optIns) {
    if (o.fp || o.database !== undefined) continue;
    const dbs = new Set<string>();
    for (const c of counted) {
      if (c.parsed.database === undefined) continue;
      for (const need of c.parsed.optIns) if (optInCovers(o, need, c.parsed.database)) dbs.add(c.parsed.database);
    }
    if (dbs.size < 2) continue;
    ambiguous.add(o);
    const names = [...dbs];
    optInProblems.push(
      `Ignoring throwaway "${o.text}": that host serves several databases here (${list(names)}), so the host alone would also cover the ones ` +
        `that aren't throwaway copies. Name the one that is, e.g. "${withDatabase(o.text, names[0])}".`,
    );
  }
  if (ambiguous.size > 0) {
    const kept = optIns.filter((o) => !ambiguous.has(o));
    for (const c of checked) c.finding.status = statusFor(c.parsed, kept);
  }

  const findings = checked.map((c) => c.finding);
  const status = overallStatus(counted.map((c) => c.finding));
  const refuse = status === "remote" || status === "unreadable";
  const { message, suggestions } = describe(status, counted, {
    appDir,
    filesRead: appEnv.filesRead,
    hasConfigUrl,
    ignoredEnv,
    optInProblems,
  });
  if (!refuse) warnings.push(...optInProblems);

  // Tunnels and proxies (cloud-sql-proxy, pscale connect, ssh -L) make a hosted database look local.
  const local = counted.filter((c) => c.finding.status === "local");
  for (const c of local) {
    const why = c.finding.port ? PROXY_PORTS[c.finding.port] : undefined;
    if (why && isLoopbackTcp(c)) {
      warnings.push(`${c.finding.source} uses port ${c.finding.port} on this machine, ${why}: if it's a tunnel or proxy to a hosted database, capture isn't safe.`);
    }
  }
  const hints = [...new Set(appEnv.proxyHints.map((h) => `${h.file} mentions ${h.hint}`))];
  if (hints.length > 0) {
    warnings.push(`${list(hints)}: if the app's local database address is a tunnel or proxy to a hosted database, capture isn't safe.`);
  }
  return {
    status,
    refuse,
    findings,
    message: !refuse && local.some(isLoopbackTcp) ? `${message} ${LOCAL_TUNNEL_NOTE}` : message,
    suggestions,
    warnings,
    appDir,
    appDirFrom: resolvedDir?.from,
    throwawayHosts: optIns.filter((o) => !ambiguous.has(o)).map((o) => o.text),
    ignoredEnv,
  };
}

/** Said with every "local" result that's a network address on this machine. */
export const LOCAL_TUNNEL_NOTE = "Local address: if this is a tunnel or proxy to a hosted database, it isn't safe.";

/** A local setting reached over TCP (127.0.0.1, localhost), which a tunnel could be behind. */
function isLoopbackTcp(c: Checked): boolean {
  return c.parsed.kind === "local" && c.parsed.remoteHosts.length === 0 && c.parsed.hosts.some((h) => !h.startsWith("(") && classifyHost(h).kind === "local");
}

/** What a setting points at, for a message: its host, or the secrets manager that fills it. */
function pointsAt(c: Checked): string {
  return c.parsed.injected ? `secrets ${c.parsed.injected} injects at run time` : where(c.finding);
}

/** Why an `ignoreEnv` entry naming this setting doesn't apply, with the entry to use instead. */
function staleIgnoreEntry(e: IgnoreEntry, c: Checked): string {
  const now = ignoreEntryFor(c);
  if (!now) {
    return (
      `app.database.ignoreEnv lists "${e.text}", but aida can't read where ${c.finding.source} points ` +
      `(${c.finding.note ?? "unreadable value"}), so the entry can't be bound to a database and the setting still counts.`
    );
  }
  const lead = e.mark
    ? `app.database.ignoreEnv lists "${e.text}", but ${c.finding.source} now points at ${pointsAt(c)}, a different database, so it counts again.`
    : `app.database.ignoreEnv lists "${e.text}" without saying which database it points at, so it doesn't apply (${c.finding.source} points at ${pointsAt(c)}).`;
  return `${lead} If the capture server still doesn't use it, list it as "${now}" instead.`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function quoted(values: string[]): string {
  return values.length === 1 ? `"${values[0]}"` : `[${values.map((v) => `"${v}"`).join(", ")}]`;
}

interface DescribeContext {
  appDir?: string;
  filesRead: string[];
  hasConfigUrl: boolean;
  ignoredEnv: string[];
  optInProblems: string[];
}

function runCommand(tool: string): string {
  return tool === "1Password" ? "`op run`" : tool === "Doppler" ? "`doppler run`" : tool === "Infisical" ? "`infisical run`" : `${tool}'s run command`;
}

function describe(status: AppDatabaseStatus, counted: Checked[], ctx: DescribeContext): { message: string; suggestions: string[] } {
  const ignoredLine = ctx.ignoredEnv.length > 0 ? ` Not counted (app.database.ignoreEnv): ${list(ctx.ignoredEnv)}.` : "";

  if (status === "remote" || status === "unreadable") {
    const remote = counted.filter((c) => c.finding.status === "remote");
    const unreadable = counted.filter((c) => c.finding.status === "unreadable");
    const sentences: string[] = [];
    const suggestions: string[] = [...ctx.optInProblems];

    if (remote.length > 0) {
      const first = remote[0].finding;
      const others = remote.length > 1 ? ` (also ${list(remote.slice(1).map((c) => `${c.finding.source}: ${where(c.finding)}`))})` : "";
      const provider = remote.map((c) => c.parsed.remoteHosts.map(providerFor).find(Boolean)).find(Boolean);
      sentences.push(
        `Refusing to capture: the app's database is not on this machine. ${first.source} points at ${where(first)}${others}.` +
          (provider ? ` This is a ${provider.name} database: ${provider.advice}.` : "") +
          " Capture runs each walkthrough's steps for real, so it would create and change records in that database.",
      );
      suggestions.push(
        provider && provider.name !== "Neon"
          ? `${provider.name}: ${provider.advice}.`
          : "Create a Neon branch (or a Supabase branch) for capture and start the app with its URL.",
        "Or run a local database (Postgres on localhost) and start the app with it.",
      );
    }
    const injected = unreadable.filter((c) => c.parsed.injected);
    const plainUnreadable = unreadable.filter((c) => !c.parsed.injected);
    if (injected.length > 0) {
      const tools = [...new Set(injected.map((c) => c.parsed.injected!))];
      sentences.push(
        `${remote.length > 0 ? "Also, secrets" : "Refusing to capture: secrets"} are injected at run time (${list(injected.map((c) => `${c.finding.source}, ${c.parsed.injected}`))}); ` +
          "aida can't see the database the app would use.",
      );
      const entries = injected.map(ignoreEntryFor).filter((e): e is string => !!e);
      suggestions.push(
        `Secrets are injected at run time; aida can't see the database. Set app.database.url in aida.config to the URL the capture server is ` +
          `started with, start that server without ${list(tools.map(runCommand))} (or with a config holding only test settings), and acknowledge it: ` +
          `app: { database: { ignoreEnv: ${quoted(entries)} } }. Each entry is bound to that ${injected.length === 1 ? "reference or config" : "reference or config file"} ` +
          "(a fingerprint, so nothing private is published): if it changes, capture refuses again.",
      );
    }
    if (plainUnreadable.length > 0) {
      sentences.push(
        `${remote.length > 0 || injected.length > 0 ? "Also, aida" : "Refusing to capture: aida"} couldn't read where ${list(plainUnreadable.map((c) => c.finding.source))} ` +
          `${plainUnreadable.length === 1 ? "points" : "point"} (${plainUnreadable[0].finding.note ?? "unreadable value"}), so it can't tell whether capture would write to a live database.`,
      );
      suggestions.push(
        "Make the setting a plain connection URL aida can read (percent-encode @, /, ? and # in a password; a ${VAR} it uses must be defined in the same env files or the environment).",
      );
    }

    // Env settings a capture server started with app.database.url may not use. Each suggested
    // entry is bound to what the setting points at now (a fingerprint of its host).
    const envRefused = counted.filter(
      (c) => c.finding.from !== "config" && !c.parsed.injected && (c.finding.status === "remote" || c.finding.status === "unreadable"),
    );
    const envEntries = envRefused.map(ignoreEntryFor).filter((e): e is string => !!e);
    const binding =
      "Each entry is bound to the database the setting points at now (after # is a fingerprint of its host, so a public aida.config doesn't " +
      'publish the hostname; "<setting>@<host>" also works): pointing it anywhere else, or a new file or variable pointing off this machine, is refused again.';
    if (ctx.hasConfigUrl && envRefused.length > 0) {
      sentences.push(
        `aida.config sets app.database.url, but if the app is started the normal way (npm run dev, next dev, vite) it reads ` +
          `${list(envRefused.map((c) => c.finding.source))} and uses ${envRefused.length === 1 ? "that database" : "those databases"}.`,
      );
      if (envEntries.length > 0) {
        suggestions.push(
          `Only if the server you capture against is started with app.database.url (a demo or test script that overrides these settings), ` +
            `say so in aida.config: app: { database: { ignoreEnv: ${quoted(envEntries)} } }. ${binding}`,
        );
      }
    } else if (envEntries.length > 0) {
      suggestions.push(
        "If the server you capture against is started with a different database (a demo or test script), set app.database.url in aida.config " +
          `to that URL and list the settings it overrides in app.database.ignoreEnv: ${quoted(envEntries)}. ${binding}`,
      );
    }

    // A host that serves several databases here: suggest `host/database`.
    const dbsByNeed = new Map<string, Set<string>>();
    for (const c of counted) {
      for (const n of c.parsed.optIns) {
        if (!dbsByNeed.has(n)) dbsByNeed.set(n, new Set());
        if (c.parsed.database !== undefined) dbsByNeed.get(n)!.add(c.parsed.database);
      }
    }
    const needs = [
      ...new Set(
        remote.flatMap((c) =>
          c.parsed.optIns.map((n) => (c.parsed.database && (dbsByNeed.get(n)?.size ?? 0) > 1 ? withDatabase(n, c.parsed.database) : n)),
        ),
      ),
    ];
    const unbound = [...new Set(remote.flatMap((c) => c.parsed.unboundHosts))];
    const singleLabel = [...new Set(remote.flatMap((c) => c.parsed.singleLabelHosts))];
    for (const host of singleLabel) {
      suggestions.push(
        ["db", "postgres", "postgresql", "mysql", "mariadb", "mongo", "mongodb", "database"].includes(host)
          ? `"${host}" looks like a docker-compose service. If it runs on this machine, opt it in: app: { database: { throwaway: "${host}" } }.`
          : `"${host}" has no domain, so it may be a machine on your network or VPN. If it's a docker-compose service on this machine, opt it in: app: { database: { throwaway: "${host}" } }.`,
      );
    }
    if (unbound.length > 0) {
      suggestions.push(
        `${list(unbound)} ${unbound.length === 1 ? "is a host" : "are hosts"} many customers' databases share, and the setting doesn't name a user, ` +
          "so aida can't tell which project it is and no opt-in can cover it. Point the capture server at a local database or a direct connection URL that includes the user.",
      );
    }
    const optable = needs.filter((n) => !singleLabel.includes(n));
    if (optable.length > 0) {
      sentences.push(` If ${optable.length === 1 ? "it is" : "they are"} already a throwaway copy, name ${optable.length === 1 ? "it" : "them"} in aida.config: app.database.throwaway: ${quoted(optable)}.`);
      suggestions.push(
        `If ${optable.length === 1 ? "this database is" : "these databases are"} already a throwaway copy, mark ${optable.length === 1 ? "it" : "them"} in aida.config: ` +
          `app: { database: { throwaway: ${quoted(optable)} } } (or set ${THROWAWAY_ENV}=${optable.join(",")}).`,
      );
    }
    return { message: sentences.join(" ").replace(/\s+/g, " ").trim() + ignoredLine, suggestions };
  }

  if (status === "unknown") {
    const looked = ctx.appDir
      ? `${ctx.filesRead.length > 0 ? list(ctx.filesRead) : "the env files"} in ${ctx.appDir} and process.env`
      : "process.env (no app directory found: set app.dir in aida.config)";
    return {
      message: `aida couldn't find the app's database setting (looked in ${looked}).${ignoredLine} Make sure the app isn't connected to a live database while aida captures it.`,
      suggestions: [
        "Set app.database.url in aida.config to the URL the app server is started with, so aida can check it.",
        ...(ctx.appDir ? [] : ["Set app.dir in aida.config to the app's own directory (where its .env files live)."]),
      ],
    };
  }

  const all = counted.map((c) => c.finding);
  if (status === "throwaway") {
    const marked = all.filter((f) => f.status === "throwaway");
    const local = all.filter((f) => f.status === "local");
    return {
      message:
        `The app's database is ${list([...new Set(marked.map(where))])}, marked as a throwaway copy (app.database.throwaway).` +
        (local.length > 0 ? ` Other settings are on this machine.` : "") +
        ignoredLine,
      suggestions: [],
    };
  }

  return {
    message: `The app's database is on this machine (${list(all.map((f) => `${f.source}: ${where(f)}`))}).${ignoredLine}`,
    suggestions: [],
  };
}

/**
 * Thrown by the capture safety gate (`assertAppDatabaseSafe`, `runCaptureSafetyChecks`): the
 * app's database isn't safe to capture against, or (`reason: "live-payments"`) a live payment
 * key is set. `check` is always the database check; `outbound` is set for a live-payments refusal.
 */
export class AppDatabaseRefusedError extends Error {
  readonly check: AppDatabaseCheck;
  readonly reason: "database" | "live-payments";
  readonly outbound?: OutboundCheck;
  constructor(check: AppDatabaseCheck, live?: { message: string; suggestions: string[]; outbound: OutboundCheck }) {
    super(live ? [live.message, ...live.suggestions.map((s) => `  - ${s}`)].join("\n") : [check.message, ...check.suggestions.map((s) => `  - ${s}`)].join("\n"));
    this.name = "AppDatabaseRefusedError";
    this.check = check;
    this.reason = live ? "live-payments" : "database";
    if (live) this.outbound = live.outbound;
  }
}

const warnedOnce = new Set<string>();

/**
 * Stops a capture run when `check.refuse` (throws `AppDatabaseRefusedError`; its message is the
 * check's message plus suggestions, one per line). "unknown" and any warnings are passed to
 * `warn` once per process, and don't refuse.
 */
export function assertAppDatabaseSafe(
  check: AppDatabaseCheck,
  warn: (message: string) => void = (m) => console.error(`warning: ${m}`),
): void {
  if (check.refuse) throw new AppDatabaseRefusedError(check);
  const notes = [...check.warnings];
  if (check.status === "unknown") notes.unshift(`${check.message} ${check.suggestions[0] ?? ""}`.trim());
  for (const note of notes) {
    if (warnedOnce.has(note)) continue;
    warnedOnce.add(note);
    warn(note);
  }
}

/** Test hook: forget which warnings were already shown. */
export function resetAppDatabaseWarnings(): void {
  warnedOnce.clear();
}
