// Reads the settings an app may start with: its env files plus `process.env` (decisions #27).
// Shared by the app database guard (safety/database.ts) and the outbound sender check
// (safety/outbound.ts). Values are only ever held in memory to classify them; the callers report
// variable names, file names and hosts, never a value.
//
// Every value counts, whichever file it's in: frameworks disagree on precedence (in Vite
// `.env.development` beats `.env.local`; in Next.js it's the other way round), and aida's own
// `process.env` isn't the env of a separately started dev server. So nothing here decides which
// value "wins": the callers check them all.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** The env files most frameworks load. aida reads these and any other `.env.<name>` file
 * (Vite's `--mode <name>`), plus `.envrc` (direnv) and Cloudflare wrangler's `.dev.vars`
 * (`.dev.vars.<env>`); see `isAppEnvFile`. */
export const APP_ENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
] as const;

/** Templates and backups: never loaded by an app, and templates hold placeholder hosts. */
const NOT_LOADED = /\.(example|sample|template|tmpl|tpl|dist|defaults?|schema|vault|keys|bak|backup|orig|old|save|swp)$|[-_](backup|bak|old|orig|copy)$/i;

/** True for an env file an app may load: `.env`, `.envrc`, `.env.<name>[.local]`, wrangler's
 * `.dev.vars[.<env>]`, but not a template (`.env.example`) or a backup (`.env.production-backup`). */
export function isAppEnvFile(name: string): boolean {
  if (name === ".env" || name === ".envrc" || name === ".dev.vars") return true;
  return (name.startsWith(".env.") || name.startsWith(".dev.vars.")) && !NOT_LOADED.test(name);
}

/** Secrets managers whose `run` wrapper injects settings at run time, by their config files. */
const SECRET_INJECTOR_FILES: Record<string, string> = {
  "doppler.yaml": "Doppler",
  "doppler.yml": "Doppler",
  ".doppler.yaml": "Doppler",
  ".doppler.yml": "Doppler",
  ".infisical.json": "Infisical",
};

/** A secrets manager config found next to the app. `content` stays in memory (for a fingerprint). */
export interface SecretInjector {
  /** The file, relative to the app directory (`doppler.yaml`, `../../.infisical.json`). */
  label: string;
  tool: string;
  content: string;
}

/** Doppler and Infisical config files in the app directory and its parents up to the git root. */
export function findSecretInjectors(appDir: string): SecretInjector[] {
  const out: SecretInjector[] = [];
  for (const dir of appEnvDirs(appDir)) {
    for (const [name, tool] of Object.entries(SECRET_INJECTOR_FILES)) {
      const path = join(dir, name);
      try {
        if (!statSync(path).isFile()) continue;
        out.push({ label: relative(resolve(appDir), path) || name, tool, content: readFileSync(path, "utf8").replace(/\r\n?/g, "\n").trim() });
      } catch {
        // missing or unreadable
      }
    }
  }
  return out;
}

/** Words in an env file that suggest the local database address is a tunnel to a hosted one. */
const PROXY_HINTS: [RegExp, string][] = [
  [/cloud[-_]sql[-_]proxy|cloudsql-proxy/i, "cloud-sql-proxy"],
  [/\bpscale\b/i, "pscale connect"],
  [/\bssh\s+(?:-\w+\s+)*-\w*L\b/, "ssh -L"],
  [/\bfly(?:ctl)?\s+proxy\b/i, "fly proxy"],
  [/\bkubectl\s+port-forward\b/i, "kubectl port-forward"],
  [/\bstart-session\b.*PortForwarding|AWS-StartPortForwardingSession/i, "AWS SSM port forwarding"],
];

/**
 * The directories whose env files the app may load: the app directory, then each parent up to
 * and including the git repository root (a monorepo's root `.env`). Just the app directory when
 * it isn't inside a git repository.
 */
export function appEnvDirs(appDir: string): string[] {
  const start = resolve(appDir);
  const dirs: string[] = [];
  let dir = start;
  for (let i = 0; i < 20; i++) {
    dirs.push(dir);
    if (isGitRoot(dir)) return dirs;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [start];
}

/** A git work tree's root: `.git` is a repository directory (has HEAD) or a worktree/submodule
 * `.git` file. A stray empty `.git` directory doesn't count. */
function isGitRoot(dir: string): boolean {
  const git = join(dir, ".git");
  try {
    const st = statSync(git);
    return st.isFile() || (st.isDirectory() && existsSync(join(git, "HEAD")));
  } catch {
    return false;
  }
}

/**
 * Stands in for a `${VAR}` reference aida couldn't resolve. Callers check whether it landed in
 * the part they care about (a URL's host) and treat that as "couldn't read"; it never reaches output.
 */
export const UNRESOLVED = "\u0000unresolved\u0000";

/**
 * Parses one env file's text the way dotenv does: `KEY=value`, optional `export ` prefix, `#`
 * comments (whole-line, or after an unquoted value), single/double/backtick quotes (double quotes
 * expand `\n`), quoted values spanning several lines. Later duplicates win, as in dotenv.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = text.replace(/\r\n?/g, "\n");
  // Same shape as dotenv's own LINE regex (lib/main.js).
  const LINE =
    /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\n]+)?\s*(?:#.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = LINE.exec(src)) !== null) {
    const key = match[1];
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    out[key] = value;
  }
  return out;
}

/**
 * Expands `$VAR`, `${VAR}`, `${VAR:-default}` and `${VAR-default}` from `lookup`. A reference
 * that can't be resolved becomes `UNRESOLVED`, so a caller can tell "host unknown" from
 * "password unknown". `\$` stays a literal `$`.
 */
export function expandEnvValue(value: string, lookup: (name: string) => string | undefined, depth = 0): string {
  if (!value.includes("$")) return value;
  return value.replace(/(\\)?\$(?:\{([A-Za-z_][\w]*)(?:(:?-)([^}]*))?\}|([A-Za-z_][\w]*))/g, (whole, escaped, braced, op, fallback, bare) => {
    if (escaped) return whole.slice(1);
    const name = (braced ?? bare) as string;
    const found = lookup(name);
    if (found !== undefined && !(op === ":-" && found === "")) {
      return depth < 5 ? expandEnvValue(found, lookup, depth + 1) : UNRESOLVED;
    }
    if (op) return expandEnvValue(fallback ?? "", lookup, depth + 1);
    return UNRESOLVED;
  });
}

/** One setting the app may start with. `value` stays in memory; never print or store it. */
export interface AppEnvValue {
  /** `.env.local:DATABASE_URL`, `../../.env:DATABASE_URL` (a parent directory's file, relative
   * to the app directory) or `process.env.DATABASE_URL`. */
  source: string;
  from: "process-env" | "env-file";
  /** Env file, relative to the app directory (`.env.local`, `../../.env`), when `from` is "env-file". */
  file?: string;
  variable: string;
  value: string;
  /** Every variable from the same file (or process env), expanded: for sibling settings such as
   * `DATABASE_USERNAME` next to `DATABASE_HOST`. */
  siblings: (name: string) => string | undefined;
}

export interface AppEnv {
  /** Every non-empty value `match` accepts, from every env file and from process env. */
  values: AppEnvValue[];
  /** Env files read, relative to the app directory. */
  filesRead: string[];
  /** Tunnel or proxy tools an env file mentions (comments included): `{ file, hint }`. */
  proxyHints: { file: string; hint: string }[];
}

/**
 * Collects every variable `match` accepts from the app's env files (see `appEnvDirs`,
 * `isAppEnvFile`) and from `env`, expanded. Nothing is dropped for precedence: a file value is
 * kept even when process env or another file has the same variable. Empty values are skipped
 * (an empty value sets nothing, so it can't hide another one either).
 */
export function collectAppEnv(
  appDir: string | undefined,
  env: Record<string, string | undefined>,
  match: (name: string, value: string) => boolean,
): AppEnv {
  const files: { label: string; vars: Record<string, string> }[] = [];
  const proxyHints: { file: string; hint: string }[] = [];
  if (appDir) {
    for (const dir of appEnvDirs(appDir)) {
      let names: string[];
      try {
        names = readdirSync(dir).filter(isAppEnvFile).sort(byLoadOrder);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        try {
          if (!statSync(path).isFile()) continue;
          const label = relative(resolve(appDir), path) || name;
          const text = readFileSync(path, "utf8");
          files.push({ label, vars: parseEnvFile(text) });
          for (const [re, hint] of PROXY_HINTS) if (re.test(text)) proxyHints.push({ file: label, hint });
        } catch {
          // Unreadable file (permissions): nothing aida can check there.
        }
      }
    }
  }

  // References resolve from process env first, then the same file, then the other files (app
  // directory first, most specific file first). Only the host part matters to callers.
  const lookupFrom = (own: Record<string, string> | undefined) => (n: string): string | undefined => {
    if (env[n] !== undefined && env[n] !== "") return env[n];
    if (own && own[n] !== undefined) return own[n];
    for (const f of files) if (f.vars[n] !== undefined) return f.vars[n];
    return undefined;
  };

  const values: AppEnvValue[] = [];
  const processLookup = lookupFrom(undefined);
  const processSiblings = (n: string): string | undefined => (env[n] ? expandEnvValue(env[n]!, processLookup) : undefined);
  for (const [variable, raw] of Object.entries(env)) {
    if (raw === undefined || raw === "") continue;
    const value = expandEnvValue(raw, processLookup);
    if (!match(variable, value)) continue;
    values.push({ source: `process.env.${variable}`, from: "process-env", variable, value, siblings: processSiblings });
  }
  for (const f of files) {
    const lookup = lookupFrom(f.vars);
    const siblings = (n: string): string | undefined => (f.vars[n] ? expandEnvValue(f.vars[n], lookup) : undefined);
    for (const [variable, raw] of Object.entries(f.vars)) {
      if (raw === "") continue;
      const value = expandEnvValue(raw, lookup);
      if (!match(variable, value)) continue;
      values.push({ source: `${f.label}:${variable}`, from: "env-file", file: f.label, variable, value, siblings });
    }
  }
  return { values, filesRead: files.map((f) => f.label), proxyHints };
}

/** `.env.development.local` before `.env.development` before `.env.local` before `.env`. */
function byLoadOrder(a: string, b: string): number {
  const rank = (n: string) => (n === ".env" ? 3 : n === ".env.local" ? 2 : n === ".envrc" || n.startsWith(".dev.vars") ? 4 : n.endsWith(".local") ? 0 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
}
