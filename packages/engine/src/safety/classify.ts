// Classifies a database setting's host as on this machine or not (decisions #27). Pure string
// work, no DNS: a hostname that merely starts like a local one (`localhost.evil.com`,
// `127.0.0.1.nip.io`) is remote, and so is a single-label name (`prod-db` may resolve through
// /etc/hosts or a VPN). Builds on capture/write-guard.ts's exact-hostname check and its
// `host`/`hostaddr` override params.
import { createHash } from "node:crypto";
import { HOST_OVERRIDE_PARAMS, isLocalHostname } from "../capture/write-guard.js";
import { UNRESOLVED } from "./env.js";

/**
 * A short, one-way fingerprint (first 10 hex of sha256) of what an opt-in is bound to: a host,
 * `user@host`, a secrets-manager reference or a live key. Lets a public aida.config name the
 * exact database or key without publishing the hostname or the key.
 */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/** Where a database lives, as far as its setting says. "unknown": aida couldn't read it. */
export type HostKind = "local" | "remote" | "unknown";

/** One database setting, reduced to what's safe to show: no password, token or query. */
export interface ParsedDatabaseSetting {
  kind: HostKind;
  /** Every host the setting connects to (lower-case; several for a host list or `?host=`). */
  hosts: string[];
  /** The hosts that aren't local. */
  remoteHosts: string[];
  /**
   * What `app.database.throwaway` must list to opt each remote host in: the host itself, or
   * `user@host` on a shared host (a Supabase pooler, PlanetScale, Prisma) where the host alone
   * doesn't say which project, plus `?endpoint=<id>` / `?reference=<ref>` when the setting's
   * `options` (or Neon's `endpoint=<id>$` password prefix) routes to another project. Shared
   * hosts whose setting has no user are in `unboundHosts`.
   */
  optIns: string[];
  /**
   * What the setting points at, for binding an `app.database.ignoreEnv` entry to it: every host
   * (in `optIns` form for remote ones), sorted and comma-joined; a 1Password reference; or a
   * secrets manager's config. Unset when aida couldn't read it. Shown only as a host (already
   * in `hosts`) or a `fingerprint`.
   */
  identity?: string;
  /** Secrets are injected at run time by this tool ("1Password", "Doppler", "Infisical"). */
  injected?: string;
  /** Shared hosts this setting reaches without naming a user, so no opt-in can be bound to it. */
  unboundHosts: string[];
  /** Single-label remote hosts (`db`, `prod-db`): maybe a docker-compose service. */
  singleLabelHosts: string[];
  port?: string;
  database?: string;
  /** Hosted provider recognised from a remote host, e.g. "Neon". */
  provider?: string;
  /** Plain-English remark, e.g. "unix socket" or why the value couldn't be read. */
  note?: string;
}

export interface Provider {
  suffixes: string[];
  name: string;
  /** What to do instead, in one clause. */
  advice: string;
  /** False for suffixes that also host ordinary web apps (`railway.app`): matched to name a
   * database setting's provider, but not to spot a database by its value alone. */
  byValue?: false;
}

/** Hosted database providers, matched by hostname suffix. */
export const PROVIDERS: Provider[] = [
  { suffixes: ["neon.tech", "neon.build"], name: "Neon", advice: "create a Neon branch for capture (`neonctl branches create --name aida-capture`) and point the app at it" },
  { suffixes: ["vercel-storage.com"], name: "Vercel Postgres (Neon)", advice: "create a Neon branch for capture and point the app at it", byValue: false },
  { suffixes: ["supabase.co", "supabase.com"], name: "Supabase", advice: "use a Supabase branch, or run Supabase locally with `supabase start`" },
  { suffixes: ["psdb.cloud"], name: "PlanetScale", advice: "create a PlanetScale development branch for capture" },
  { suffixes: ["rds.amazonaws.com"], name: "Amazon RDS", advice: "restore a snapshot into a separate instance for capture, or use a local database" },
  { suffixes: ["turso.io"], name: "Turso", advice: "create a separate Turso database for capture, or use a local `file:` database" },
  { suffixes: ["mongodb.net"], name: "MongoDB Atlas", advice: "use a separate Atlas cluster or a local MongoDB for capture" },
  { suffixes: ["convex.cloud", "convex.site"], name: "Convex", advice: "point the app at a Convex dev deployment or local backend made for capture" },
  { suffixes: ["firebaseio.com", "firebasedatabase.app", "firebaseapp.com"], name: "Firebase", advice: "use the Firebase emulators or a separate Firebase project for capture" },
  { suffixes: ["rlwy.net", "railway.internal"], name: "Railway", advice: "use a separate Railway environment for capture" },
  { suffixes: ["railway.app"], name: "Railway", advice: "use a separate Railway environment for capture", byValue: false },
  { suffixes: ["render.com"], name: "Render", advice: "use a separate Render database for capture", byValue: false },
  { suffixes: ["upstash.io"], name: "Upstash", advice: "use a separate Upstash database for capture", byValue: false },
  { suffixes: ["redis-cloud.com", "redislabs.com", "redis.cache.windows.net", "cache.amazonaws.com"], name: "Hosted Redis", advice: "use a local Redis (or a separate one made for capture)" },
  { suffixes: ["appwrite.io"], name: "Appwrite", advice: "run Appwrite locally, or use a separate Appwrite project for capture" },
  { suffixes: ["pockethost.io"], name: "PocketBase (PocketHost)", advice: "run PocketBase locally (`./pocketbase serve`) for capture" },
  { suffixes: ["cockroachlabs.cloud"], name: "CockroachDB Cloud", advice: "use a separate CockroachDB cluster for capture" },
  { suffixes: ["aivencloud.com"], name: "Aiven", advice: "fork the Aiven service for capture" },
  { suffixes: ["db.ondigitalocean.com"], name: "DigitalOcean", advice: "use a separate DigitalOcean database for capture" },
  { suffixes: ["prisma-data.net", "db.prisma.io"], name: "Prisma Postgres", advice: "use a separate Prisma Postgres database for capture" },
  { suffixes: ["xata.sh"], name: "Xata", advice: "create a Xata branch for capture" },
  { suffixes: ["database.azure.com", "database.windows.net", "documents.azure.com"], name: "Azure", advice: "use a separate Azure database for capture" },
  { suffixes: ["azure.com"], name: "Azure", advice: "use a separate Azure database for capture", byValue: false },
];

const CLOUD_SQL: Provider = { suffixes: [], name: "Google Cloud SQL", advice: "clone the instance for capture, or use a local database" };

function hasSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

export function providerFor(host: string): Provider | undefined {
  if (host.startsWith("/cloudsql/")) return CLOUD_SQL;
  return PROVIDERS.find((p) => p.suffixes.some((s) => hasSuffix(host, s)));
}

/** True for a host that belongs to a hosted database provider (by value: `byValue` providers). */
export function isDatabaseProviderHost(host: string): boolean {
  const h = normaliseHost(host);
  return PROVIDERS.some((p) => p.byValue !== false && p.suffixes.some((s) => hasSuffix(h, s)));
}

/**
 * Hosts many customers' databases share: the host alone doesn't say which project, so an opt-in
 * must also name the user (`postgres.<project ref>@aws-0-<region>.pooler.supabase.com`).
 */
export function isSharedHost(host: string): boolean {
  const h = normaliseHost(host);
  return (
    hasSuffix(h, "pooler.supabase.com") ||
    hasSuffix(h, "connect.psdb.cloud") ||
    h === "accelerate.prisma-data.net" ||
    h === "db.prisma.io" ||
    // Appwrite Cloud: the project is a separate setting (APPWRITE_PROJECT_ID), not the host.
    h === "cloud.appwrite.io" ||
    /^[a-z0-9-]+\.cloud\.appwrite\.io$/.test(h)
  );
}

/** Strict dotted-quad IPv4 check (so `127.0.0.1.nip.io` isn't one). */
function ipv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
  return parts.map(Number);
}

/** A name without dots (`db`, `prod-db`): a docker-compose service, or a machine reached
 * through /etc/hosts or a VPN. aida can't tell, so it isn't local. */
export function isSingleLabelHost(host: string): boolean {
  return /^[a-z0-9_-]+$/i.test(host.trim()) && !/^\d+$/.test(host.trim()) && host.trim().toLowerCase() !== "localhost";
}

/**
 * Classifies one host string as `URL#hostname` (or a libpq `host=` value) gives it. Local:
 * localhost, `*.localhost`, 127.0.0.0/8, 0.0.0.0, ::1, `host.docker.internal`, or a unix socket
 * directory. Anything else is remote, including a single-label name (`db`, `prod-db`).
 */
export function classifyHost(rawHost: string): { kind: HostKind; note?: string } {
  let host = rawHost.trim().toLowerCase();
  if (host.includes(UNRESOLVED)) return { kind: "unknown", note: "host comes from a variable aida couldn't resolve" };
  try {
    host = decodeURIComponent(host);
  } catch {
    // keep as-is
  }
  host = host.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  // Cloud SQL's socket directory is a proxy to a hosted database, not a local server.
  if (host.startsWith("/cloudsql/")) return { kind: "remote", note: "Cloud SQL proxy socket" };
  if (host === "" || host.startsWith("/")) return { kind: "local", note: "unix socket" };
  if (isLocalHostname(host) || host === "localhost" || host.endsWith(".localhost")) return { kind: "local" };
  const v4 = ipv4(host);
  if (v4) return v4[0] === 127 || host === "0.0.0.0" ? { kind: "local" } : { kind: "remote" };
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || /^::ffff:127\./.test(host)) return { kind: "local" };
  if (host === "host.docker.internal") return { kind: "local", note: "host.docker.internal (the machine running Docker)" };
  if (host.includes(":")) return { kind: "remote" }; // any other IPv6 address
  if (isSingleLabelHost(host)) {
    return { kind: "remote", note: `single-label host "${host}" (a docker-compose service, or a machine on your network or VPN)` };
  }
  return { kind: "remote" };
}

/** True for settings that are a local file (SQLite, libSQL `file:`). */
function isFileSetting(value: string): boolean {
  if (/^(file|sqlite3?):/i.test(value)) return true;
  if (value === ":memory:") return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return /^(\.{0,2}\/|~\/)/.test(value) || /\.(db|sqlite3?|db3)$/i.test(value);
}

/** Connection-URL schemes that are a database (`jdbc:` prefix allowed). */
const DATABASE_SCHEME =
  /^(jdbc:)?(postgres|postgresql|pgsql|mysql|mysql2|mariadb|mongodb|mongodb\+srv|libsql|prisma|prisma\+postgres|sqlserver|mssql|cockroachdb|redshift|clickhouse|tidb|oracle|db2|redis|rediss|valkey|valkeys):\/\//i;

/** Firebase hosts inside a longer value (a config held as JSON in one variable). */
const FIREBASE_HOST = /\b((?:[a-z0-9-]+\.)+(?:firebaseio\.com|firebaseapp\.com|firebasedatabase\.app))\b/i;

/** A secrets-manager reference resolved at run time (`op run`): aida can't see the value. */
export function isSecretReference(value: string): boolean {
  return /^op:\/\//i.test(value.trim());
}

/** Local TCP ports that tunnels and proxies to hosted databases commonly listen on. */
export const PROXY_PORTS: Record<string, string> = {
  "15432": "the port `fly proxy` examples use",
  "6543": "Supabase's pooler port",
  "25060": "DigitalOcean's managed database port",
  "3307": "a common second port for cloud-sql-proxy",
  "5434": "a common port for a second Postgres or a tunnel",
};

const DSN_KEYS = new Set(["host", "hostaddr", "port", "dbname", "user", "password", "sslmode", "server", "data source", "database", "initial catalog", "uid", "user id", "pwd"]);

/** Keyword/value connection strings: libpq `host=… dbname=…`, or ADO `Server=…;Database=…`. */
function parseKeywordDsn(value: string): Map<string, string> | undefined {
  if (value.includes("://") || !/^\s*[a-z][a-z ]*\s*=/i.test(value)) return undefined;
  const out = new Map<string, string>();
  const re = value.includes(";")
    ? /\s*([a-z][a-z ]*?)\s*=\s*("(?:[^"]*)"|'(?:[^']*)'|[^;]*)\s*(?:;|$)/gi
    : /\s*([a-z_]+)\s*=\s*('(?:\\'|[^'])*'|\S*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m[0] === "") break;
    out.set(m[1].toLowerCase().trim(), m[2].replace(/^(['"])([\s\S]*)\1$/, "$2"));
  }
  const keys = [...out.keys()];
  if (keys.length === 0 || !keys.every((k) => DSN_KEYS.has(k) || /^[a-z_ ]+$/.test(k))) return undefined;
  if (!keys.some((k) => ["host", "hostaddr", "dbname", "server", "data source", "database", "initial catalog"].includes(k))) return undefined;
  return out;
}

/** A bare `host[:port][,host2[:port]]` value (DATABASE_HOST, PGHOST). */
function parseBareHosts(value: string): { hosts: string[]; port?: string } | undefined {
  const hosts: string[] = [];
  let port: string | undefined;
  for (const entry of value.split(",")) {
    const m = /^\s*(\[[^\]]*\]|\/[^:,]*|[^:/\s,]*)(?::(\d+))?\s*$/.exec(entry);
    if (!m) return undefined;
    hosts.push(m[1]);
    port ??= m[2];
  }
  return { hosts, port };
}

/**
 * True when a value looks like a database connection whatever its variable is called: a
 * database URL scheme, a keyword connection string, or a hosted database provider's host.
 */
export function looksLikeDatabaseValue(rawValue: string): boolean {
  const value = rawValue.trim();
  if (DATABASE_SCHEME.test(value)) return true;
  // A Firebase config held as JSON (`{"projectId": ...}`), or a Firebase host inside a value.
  if (/"projectId"\s*:/.test(value) || FIREBASE_HOST.test(value)) return true;
  const dsn = parseKeywordDsn(value);
  if (dsn && (dsn.has("host") || dsn.has("hostaddr") || dsn.has("server") || dsn.has("data source"))) return true;
  let host: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      host = new URL(value).hostname;
    } catch {
      host = undefined;
    }
  } else if (/^[a-z0-9.-]+(:\d+)?$/i.test(value)) {
    host = value.split(":")[0];
  }
  return host !== undefined && isDatabaseProviderHost(host);
}

interface Authority {
  hosts: string[];
  port?: string;
  database?: string;
  /** The URL's user name, decoded. Only ever shown for a shared host (it names the project). */
  user?: string;
  params: URLSearchParams;
  /** Neon's `endpoint=<id>$<password>` password prefix: the endpoint id only. */
  passwordRoute?: string;
}

/**
 * True when `@`, `/`, `?` or `#` appear before the URL's last `@`: an unescaped character in the
 * user name or password. Parsers then split the URL in the wrong place and part of the password
 * lands in the host, port or database name (`admin:2024/HunterPass@db.mycorp.com/app`), so
 * aida reports it as unreadable and shows none of it.
 */
function hasAmbiguousUserInfo(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return false;
  const rest = value.slice(schemeEnd + 3);
  const lastAt = rest.lastIndexOf("@");
  return lastAt >= 0 && /[@/?#]/.test(rest.slice(0, lastAt));
}

/** Neon's password workaround for clients without SNI: `endpoint=<id>$<password>` (or `;`). */
function passwordRoute(password: string): string | undefined {
  // `$` may already have been read as a `$VAR` reference (UNRESOLVED starts with \u0000).
  const m = /^endpoint=([a-z0-9-]+)[$;\u0000]/i.exec(safeDecode(password));
  return m ? `endpoint=${m[1].toLowerCase()}` : undefined;
}

/**
 * A Postgres `options` value that routes to a project other than the host's: Neon
 * `endpoint=<id>` (or the older `project=<id>`), Supabase's pooler `reference=<ref>`. Returned as
 * `endpoint=<id>` or `reference=<ref>`.
 */
export function routeFromOptions(options: string | null | undefined): string | undefined {
  if (!options) return undefined;
  const m = /(?:^|\s)(?:--)?(endpoint|project|reference)=([A-Za-z0-9._-]+)/i.exec(safeDecode(options));
  if (!m) return undefined;
  return `${m[1].toLowerCase() === "reference" ? "reference" : "endpoint"}=${m[2].toLowerCase()}`;
}

/**
 * Splits `scheme://[user[:password]@]host[:port][,host2...][/db][?query]` without keeping the
 * password. Uses WHATWG `URL` when it can (it already finds the right `@` in a password
 * containing one); falls back to a hand split for host lists and other shapes `URL` rejects.
 */
function parseAuthority(rawValue: string): Authority | "ambiguous" | undefined {
  const value = rawValue.replace(/^jdbc:/i, "");
  if (hasAmbiguousUserInfo(value)) return "ambiguous";
  try {
    const url = new URL(value);
    // `URL` keeps `a,b` as one opaque host: split host lists by hand.
    if (!url.hostname.includes(",") && (url.host !== "" || /^[a-z][a-z0-9+.-]*:\/\/\//i.test(value) || /^[a-z][a-z0-9+.-]*:\/\/\?/i.test(value))) {
      return {
        hosts: [url.hostname],
        port: url.port || undefined,
        database: firstPathSegment(url.pathname),
        user: url.username ? safeDecode(url.username) : undefined,
        params: url.searchParams,
        passwordRoute: url.password ? passwordRoute(url.password) : undefined,
      };
    }
  } catch {
    // fall through to the hand split
  }
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return undefined;
  let rest = value.slice(schemeEnd + 3);
  const queryAt = rest.indexOf("?");
  const beforeQuery = queryAt >= 0 ? rest.slice(0, queryAt) : rest;
  const at = beforeQuery.lastIndexOf("@");
  let user: string | undefined;
  let pwRoute: string | undefined;
  if (at >= 0) {
    const userInfo = rest.slice(0, at);
    user = safeDecode(userInfo.split(":")[0]) || undefined;
    const colon = userInfo.indexOf(":");
    if (colon >= 0) pwRoute = passwordRoute(userInfo.slice(colon + 1));
    rest = rest.slice(at + 1);
  }
  const end = rest.search(/[/?#;]/);
  const hostPart = end >= 0 ? rest.slice(0, end) : rest;
  const tail = end >= 0 ? rest.slice(end) : "";
  const pathMatch = /^\/([^?#;]*)/.exec(tail);
  const query = tail.includes("?") ? tail.slice(tail.indexOf("?") + 1).split("#")[0] : "";
  const bare = parseBareHosts(hostPart);
  if (!bare) return undefined;
  return {
    hosts: bare.hosts,
    port: bare.port,
    database: pathMatch ? firstPathSegment(`/${pathMatch[1]}`) : undefined,
    user,
    params: new URLSearchParams(query),
    passwordRoute: pwRoute,
  };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function firstPathSegment(pathname: string): string | undefined {
  const seg = pathname.replace(/^\/+/, "").split("/")[0];
  if (!seg || seg.includes(UNRESOLVED)) return undefined;
  return safeDecode(seg);
}

/** Reduces several hosts to one setting's kind: remote if any is, unknown if any is, else local. */
function summarise(hosts: string[], user: string | undefined, extra: Partial<ParsedDatabaseSetting> = {}, route?: string): ParsedDatabaseSetting {
  const kinds = hosts.map((h) => ({ host: h, ...classifyHost(h) }));
  const remoteHosts = [...new Set(kinds.filter((k) => k.kind === "remote").map((k) => normaliseHost(k.host)))];
  const kind: HostKind = remoteHosts.length > 0 ? "remote" : kinds.some((k) => k.kind === "unknown") ? "unknown" : "local";
  const shown = [...new Set(kinds.filter((k) => k.kind !== "unknown").map((k) => displayHost(k.host, k.note)))];
  const provider = remoteHosts.map((h) => providerFor(h)?.name).find(Boolean);
  const note = extra.note ?? kinds.map((k) => k.note).find(Boolean);
  const cleanUser = user && !user.includes(UNRESOLVED) ? user.toLowerCase() : undefined;
  const optIns: string[] = [];
  const unboundHosts: string[] = [];
  const targets: string[] = [];
  const suffix = route ? `?${route}` : "";
  for (const h of remoteHosts) {
    if (!isSharedHost(h)) optIns.push(`${h}${suffix}`);
    else if (cleanUser) optIns.push(`${cleanUser}@${h}${suffix}`);
    else unboundHosts.push(h);
  }
  targets.push(...optIns, ...unboundHosts.map((h) => `${h}${suffix}`));
  for (const k of kinds) if (k.kind === "local") targets.push(displayHost(k.host, k.note));
  const singleLabelHosts = remoteHosts.filter(isSingleLabelHost);
  const identity = kind === "unknown" ? undefined : [...new Set(targets)].sort().join(",");
  return { ...extra, kind, hosts: shown, remoteHosts, optIns, unboundHosts, singleLabelHosts, provider, note, ...(identity ? { identity } : {}) };
}

/** Lower-case, unbracketed, no trailing dot: the form an opt-in list is compared against. */
export function normaliseHost(host: string): string {
  return safeDecode(host.trim().toLowerCase()).replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

function displayHost(host: string, note: string | undefined): string {
  if (note === "unix socket") return "(unix socket)";
  return normaliseHost(host);
}

function unreadable(note: string): ParsedDatabaseSetting {
  return { kind: "unknown", hosts: [], remoteHosts: [], optIns: [], unboundHosts: [], singleLabelHosts: [], note };
}

/** Unreadable, bound to `identity` (a secrets-manager reference or config) for `ignoreEnv`. */
export function injectedSetting(tool: string, identity: string, where: string): ParsedDatabaseSetting {
  return {
    ...unreadable(`secrets are injected at run time by ${tool} (${where}); aida can't see the database`),
    identity,
    injected: tool,
  };
}

/**
 * A Firebase project id (`FIREBASE_PROJECT_ID`, or `projectId` in a config JSON): `demo-*` ids
 * are emulator-only and can't reach real resources; any other id is that project.
 */
export function classifyFirebaseProject(variable: string | undefined, rawId: string): ParsedDatabaseSetting {
  const id = rawId.trim().toLowerCase();
  if (/^demo-[a-z0-9-]*$/.test(id)) {
    return { ...classifyDatabaseSetting(variable, "localhost", { bareHost: true }), hosts: ["(Firebase emulator project)"], note: "demo- project (Firebase emulators only)", identity: `firebase:${id}` };
  }
  if (/^[a-z0-9-]+$/.test(id)) return classifyDatabaseSetting(variable, `${id}.firebaseapp.com`, { bareHost: true });
  return unreadable("not a Firebase project id aida can read");
}

/** A Firebase config (or service account) held as JSON in one variable. */
function classifyJsonValue(variable: string | undefined, value: string): ParsedDatabaseSetting {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const o = parsed as Record<string, unknown>;
    const id = typeof o.projectId === "string" ? o.projectId : typeof o.project_id === "string" ? o.project_id : undefined;
    if (id) return classifyFirebaseProject(variable, id);
  }
  const host = FIREBASE_HOST.exec(value)?.[1];
  if (host) return summarise([host], undefined);
  return unreadable("a JSON value aida can't read as a database setting");
}

export interface ClassifyOptions {
  /** The value is a bare host list (`PGHOST`, `DATABASE_HOST`), not a URL. */
  bareHost?: boolean;
  /** The user name a bare host is used with (`DATABASE_USERNAME` next to `DATABASE_HOST`). */
  user?: string;
}

/**
 * Classifies one database setting's value: a connection URL, a keyword connection string
 * (`host=… dbname=…`), a bare host list (`opts.bareHost`), or a SQLite/libSQL file path. Never
 * returns the value itself or any part of it except host, port, database name and (for a shared
 * host only) the user name, which says which project it is.
 */
export function classifyDatabaseSetting(variable: string | undefined, rawValue: string, opts: ClassifyOptions = {}): ParsedDatabaseSetting {
  const value = rawValue.trim();
  if (value === "" || value === UNRESOLVED) return unreadable("value comes from a variable aida couldn't resolve");

  if (isSecretReference(value)) return injectedSetting("1Password", value, "an op:// reference");

  if (opts.bareHost || variable === "PGHOST") {
    const bare = parseBareHosts(value);
    if (!bare) return unreadable("not a host name aida can read");
    return summarise(bare.hosts, opts.user, { port: bare.port });
  }

  if (isFileSetting(value)) {
    return { kind: "local", hosts: ["(local file)"], remoteHosts: [], optIns: [], unboundHosts: [], singleLabelHosts: [], note: "local database file", identity: "(local file)" };
  }

  if (value.startsWith("{") || (!value.includes("://") && FIREBASE_HOST.test(value) && !/^[a-z0-9.-]+(:\d+)?$/i.test(value))) {
    return classifyJsonValue(variable, value);
  }

  const dsn = parseKeywordDsn(value);
  if (dsn) {
    const server = (dsn.get("server") ?? dsn.get("data source"))?.replace(/^tcp:/i, "");
    const hosts = [
      ...(dsn.get("host")?.split(",") ?? []),
      ...(dsn.get("hostaddr")?.split(",") ?? []),
      ...(server ? [server.split(/[,\\]/)[0]] : []),
    ];
    // libpq with no host connects through the default unix socket.
    return summarise(
      hosts.length > 0 ? hosts : [""],
      dsn.get("user") ?? dsn.get("user id") ?? dsn.get("uid"),
      {
        port: dsn.get("port") ?? (server?.includes(",") ? server.split(",")[1] : undefined),
        database: dsn.get("dbname") ?? dsn.get("database") ?? dsn.get("initial catalog"),
      },
      routeFromOptions(dsn.get("options")) ?? (dsn.get("password") ? passwordRoute(dsn.get("password")!) : undefined),
    );
  }

  if (!value.includes("://") && /^[a-z0-9.-]+(:\d+)?$/i.test(value) && value.includes(".") && isDatabaseProviderHost(value.split(":")[0])) {
    // A provider host on its own (`myapp.firebaseapp.com`).
    return summarise([value.split(":")[0]], opts.user, { port: value.split(":")[1] });
  }

  const auth = parseAuthority(value);
  if (auth === "ambiguous") {
    return unreadable("the user name or password has an unescaped @, /, ? or # (percent-encode it), so aida can't tell where it points");
  }
  if (!auth) return unreadable("not a connection URL aida can read");

  // libpq/postgres.js: `?host=` / `?hostaddr=` override the URL's host. Both must be local: the
  // client library decides which one it uses, aida doesn't guess.
  const hosts = auth.hosts.length === 0 ? [""] : [...auth.hosts];
  let note: string | undefined;
  for (const param of HOST_OVERRIDE_PARAMS) {
    const override = auth.params.get(param);
    if (override === null) continue;
    hosts.push(...override.split(","));
    note = `host also set by the "?${param}=" parameter`;
  }
  const route = routeFromOptions(auth.params.get("options")) ?? auth.passwordRoute;
  const result = summarise(
    hosts,
    auth.user ?? opts.user,
    { port: auth.params.get("port") ?? auth.port, database: auth.database, ...(note ? { note } : {}) },
    route,
  );
  if (result.kind === "local" && auth.port === "54321" && /supabase/i.test(variable ?? "")) {
    result.note = "local Supabase (supabase start)";
  }
  return result;
}
