// Where the app runs locally, for the config `aida init` writes (`app.baseUrl`). A machine often
// has more than one app on it, so guessing http://localhost:3000 can point capture (and init's
// brand read) at a different app. Read the app's own settings first: a localhost URL in its env
// files, then a PORT, then a `-p`/`--port` in its dev or start script.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_APP_URL = "http://localhost:3000";

/** Env vars apps commonly use for their own address, most specific first. */
const URL_VARS = [
  "NEXT_PUBLIC_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "APP_URL",
  "BASE_URL",
  "SITE_URL",
  "BETTER_AUTH_URL",
  "AUTH_URL",
  "NEXTAUTH_URL",
];

/** The env files `next dev` and `next start` load, highest precedence first. Never production. */
const ENV_FILES = [".env.local", ".env.development.local", ".env.development", ".env"];

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface DetectedAppUrl {
  url: string;
  /** Where it came from, e.g. "apps/web/.env.local: NEXT_PUBLIC_BASE_URL", or "default". */
  source: string;
}

function readEnvVars(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2].trim();
    const quoted = raw.match(/^(["'`])(.*?)\1/);
    out[m[1]] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "");
  }
  return out;
}

/** The URL's origin when it's an http(s) address on this machine, else undefined. */
export function localOrigin(value: string): string | undefined {
  try {
    const u = new URL(value);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

function portFromScript(script: string | undefined): number | undefined {
  if (!script) return undefined;
  const m = script.match(/(?:^|\s)(?:-p|--port)(?:\s+|=)(\d{2,5})\b/) ?? script.match(/\bPORT=(\d{2,5})\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * The app's local address from its own settings. `dirs` are searched in order (the app's own
 * folder first, then the workspace root of a monorepo); labels in `source` are relative to
 * `labelBase` when given.
 */
export function detectAppUrl(dirs: string[], label: (dir: string) => string = (d) => d): DetectedAppUrl {
  for (const dir of dirs) {
    for (const name of ENV_FILES) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const vars = readEnvVars(file);
      for (const v of URL_VARS) {
        const origin = vars[v] ? localOrigin(vars[v]) : undefined;
        if (origin) return { url: origin, source: `${label(file)}: ${v}` };
      }
      const port = Number(vars.PORT);
      if (Number.isInteger(port) && port > 0 && port < 65536) return { url: `http://localhost:${port}`, source: `${label(file)}: PORT` };
    }
  }
  for (const dir of dirs) {
    const pkgFile = join(dir, "package.json");
    if (!existsSync(pkgFile)) continue;
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      continue;
    }
    for (const name of ["start", "dev"]) {
      const port = portFromScript(scripts[name]);
      if (port) return { url: `http://localhost:${port}`, source: `${label(pkgFile)}: scripts.${name}` };
    }
  }
  return { url: DEFAULT_APP_URL, source: "default" };
}

/**
 * Whether the page at a URL looks like this app, judged from its HTML: the brand name in the
 * title, a site-name meta tag or the manifest link's neighbourhood. Used before reading the brand
 * from "the running app", so another app on the same port is never mistaken for it. With no
 * brand name to compare, it can't tell and says yes.
 */
export function pageLooksLikeApp(html: string, brandName: string | undefined): boolean {
  if (!brandName) return true;
  const needle = brandName.trim().toLowerCase();
  if (!needle) return true;
  const head = (html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? html.slice(0, 20000)).toLowerCase();
  return head.includes(needle);
}
