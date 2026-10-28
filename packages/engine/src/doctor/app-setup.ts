// `aida doctor` checks on how the app is set up for capture, each found the hard way on an
// outside app: a Next.js `output: "standalone"` build that `next start` doesn't serve, an app that
// only answers on one spelling of this machine's address, and demo data full of real-looking
// email addresses. Pure checks here; the probes they need are in ./probes.ts or run in index.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { DatabaseAdapter } from "../config/types.js";
import type { DoctorCheck, FetchResult } from "./checks.js";

const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.cjs", "next.config.ts", "next.config.mts"];
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb", "bun.lock"];

/** True when the Next.js config text sets `output` to "standalone", as a literal or inside an
 * expression (`output: isSelfHosted ? "standalone" : undefined`). */
export function setsStandaloneOutput(configText: string): boolean {
  const text = configText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return /\boutput\s*:[^,}]*["'`]standalone["'`]/.test(text);
}

/** The folder Next.js traces a standalone build from: the nearest folder at or above `appDir`
 * with a lockfile (stopping at the git root). The standalone tree mirrors `appDir`'s path from
 * there (`.next/standalone/apps/web/server.js` in a workspace). */
export function tracingRoot(appDir: string): string {
  for (let d = appDir; ; d = dirname(d)) {
    if (LOCKFILES.some((f) => existsSync(join(d, f)))) return d;
    if (existsSync(join(d, ".git")) || dirname(d) === d) return appDir;
  }
}

export interface StandaloneInfo {
  /** The Next.js config file that sets it. */
  configFile: string;
  /** `appDir`'s path inside `.next/standalone/` ("" when the app is the tracing root). */
  appPath: string;
}

/** Reads the app's Next.js config; undefined when there is none or it doesn't build standalone. */
export function findStandaloneOutput(appDir: string): StandaloneInfo | undefined {
  let names: string[];
  try {
    names = readdirSync(appDir);
  } catch {
    return undefined;
  }
  const name = NEXT_CONFIGS.find((n) => names.includes(n));
  if (!name) return undefined;
  const configFile = join(appDir, name);
  let text: string;
  try {
    text = readFileSync(configFile, "utf8");
  } catch {
    return undefined;
  }
  if (!setsStandaloneOutput(text)) return undefined;
  return { configFile, appPath: relative(tracingRoot(appDir), appDir).split(sep).join("/") };
}

/** A standalone build is served by its own `server.js`, not `next start` (which logs a warning
 * and, on some apps, hangs every page). Only a warning: the app may not build standalone in every
 * mode. */
export function checkStandaloneOutput(appDir: string | undefined, info: StandaloneInfo | undefined, baseUrl?: string): DoctorCheck | undefined {
  if (!appDir || !info) return undefined;
  const dir = info.appPath ? `.next/standalone/${info.appPath}` : ".next/standalone";
  let port = "3000";
  try {
    if (baseUrl) port = new URL(baseUrl).port || port;
  } catch {
    // keep the default
  }
  return {
    id: "next-standalone",
    label: "App start command",
    status: "warn",
    detail: `${relative(appDir, info.configFile)} builds with output: "standalone", which \`next start\` doesn't serve; start ${dir}/server.js instead`,
    fix: `cd ${appDir} && cp -r .next/static ${dir}/.next/ && cp -r public ${dir}/ && PORT=${port} HOSTNAME=localhost node ${dir}/server.js`,
  };
}

/** How long doctor waits on the other spelling of this machine's address. */
export const LOOPBACK_PROBE_TIMEOUT_MS = 5000;

/** `baseUrl` with localhost and 127.0.0.1 swapped; undefined for any other host. */
export function otherLoopback(baseUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  else if (url.hostname === "127.0.0.1") url.hostname = "localhost";
  else return undefined;
  return url.href.replace(/\/$/, baseUrl.endsWith("/") ? "/" : "");
}

/** Warns when the app answers on the other spelling of this machine's address but not at
 * `baseUrl` (some servers bind or rewrite to one name only: a Next.js standalone server started
 * with HOSTNAME=localhost, or a proxy that calls back to `localhost`). Undefined when there's
 * nothing to say. */
export function checkLoopback(baseUrl: string, primary: FetchResult, other: { url: string; result: FetchResult } | undefined, standalone = false): DoctorCheck | undefined {
  if (!other || "status" in primary) return undefined;
  if (!("status" in other.result) || other.result.status >= 500) return undefined;
  return {
    id: "app-address",
    label: "App address",
    status: "warn",
    detail: `the app answers at ${other.url} (${other.result.status}) but not at app.baseUrl ${baseUrl}`,
    fix: `set app.baseUrl to ${other.url} in aida.config` + (standalone ? " (a Next.js standalone server answers on the HOSTNAME it was started with)" : ""),
  };
}

/** Email domains fine for demo data: reserved for examples and testing (RFC 2606, RFC 6761). */
export function isDemoEmailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  if (!d) return true;
  if (["example.com", "example.org", "example.net"].includes(d)) return true;
  return /(^|\.)(example|test|invalid|localhost)$/.test(d) || /\.example\.(com|org|net)$/.test(d);
}

export interface EmailColumnSample {
  table: string;
  column: string;
  /** Domains seen in the sample that aren't demo domains, most common first. */
  domains: string[];
}

export interface DemoEmailSample {
  /** False when the database couldn't be read this way (not Postgres, no access). */
  ok: boolean;
  columns: EmailColumnSample[];
  error?: string;
}

/** Rows read per column. */
export const EMAIL_SAMPLE_ROWS = 500;
const MAX_COLUMNS = 25;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Samples email-like text columns through the config's database adapter, read-only: one
 * information_schema lookup, then one SELECT per column over at most EMAIL_SAMPLE_ROWS rows,
 * returning domains only (never an address). Postgres only: any other database errors on the
 * first query and is reported as not ok.
 */
export async function sampleDemoEmails(adapter: Pick<DatabaseAdapter, "query">, url: string): Promise<DemoEmailSample> {
  let columns: { table_name: string; column_name: string }[];
  try {
    columns = (await adapter.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = current_schema() and column_name ilike '%email%'
         and data_type in ('text', 'character varying', 'citext', 'USER-DEFINED')
       order by table_name, column_name limit ${MAX_COLUMNS}`,
      [],
      { url },
    )) as { table_name: string; column_name: string }[];
  } catch (err) {
    return { ok: false, columns: [], error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  }
  const out: EmailColumnSample[] = [];
  for (const { table_name: table, column_name: column } of columns) {
    let rows: { domain?: unknown; n?: unknown }[];
    try {
      rows = (await adapter.query(
        `select lower(split_part(c, '@', 2)) as domain, count(*)::int as n
         from (select ${ident(column)}::text as c from ${ident(table)} where ${ident(column)}::text like '%@%' limit ${EMAIL_SAMPLE_ROWS}) s
         group by 1 order by 2 desc`,
        [],
        { url },
      )) as { domain?: unknown; n?: unknown }[];
    } catch {
      continue; // a view or a column we can't read: skip it
    }
    const domains = rows.map((r) => String(r.domain ?? "")).filter((d) => d && !isDemoEmailDomain(d));
    if (domains.length > 0) out.push({ table, column, domains });
  }
  return { ok: true, columns: out };
}

/** Demo data should only hold example.com-style addresses: real-looking ones end up in
 * screenshots and could reach a real inbox if the app sends mail during capture. */
export function checkDemoEmails(sample: DemoEmailSample | undefined, reason?: string): DoctorCheck {
  const base = { id: "demo-emails", label: "Demo data emails" };
  if (!sample) return { ...base, status: "skip", detail: `skipped: ${reason ?? "no database adapter in aida.config"}` };
  if (!sample.ok) return { ...base, status: "skip", detail: `skipped: couldn't sample the database (${sample.error ?? "not Postgres?"})` };
  if (sample.columns.length === 0) return { ...base, status: "ok", detail: "email columns use example.com-style addresses only" };
  const domains = [...new Set(sample.columns.flatMap((c) => c.domains))];
  const where = sample.columns.slice(0, 3).map((c) => `${c.table}.${c.column}`);
  const first = sample.columns[0];
  return {
    ...base,
    status: "warn",
    detail:
      `real-looking addresses (${domains.slice(0, 3).join(", ")}${domains.length > 3 ? `, +${domains.length - 3} more` : ""}) in ` +
      `${where.join(", ")}${sample.columns.length > 3 ? ` and ${sample.columns.length - 3} more column(s)` : ""}; demo data should use example.com`,
    fix: `update ${ident(first.table)} set ${ident(first.column)} = split_part(${ident(first.column)}, '@', 1) || '@example.com' where ${ident(first.column)} like '%@%' (and the same for each column listed)`,
    data: sample,
  };
}
