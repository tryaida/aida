// Framework + route detection for `aida init` (scope.md "First run: engineer":
// "It detects the framework, routes, sign-in method and existing Playwright
// tests."). Phase 1 covers Next.js App Router only — detected routes are
// written into aida.config.ts as comments, not acted on, until capture
// (src/capture) grows an auto-discovery step.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { countRoutesForApp, findWorkspaceNextApps } from "../digest/workspace.js";

export type DetectedFramework = "nextjs" | "unknown";

export interface DetectOptions {
  /** Explicit app directory within a workspace monorepo (relative to repoDir, or absolute). */
  app?: string;
}

export interface DetectResult {
  framework: DetectedFramework;
  /** Absolute path to the `app/` (or `src/app/`) directory, when found. */
  appDir?: string;
  /** Absolute path to the app's own package root (the repo, or `--app` inside a workspace) — where
   * its package.json, node_modules and env files are. Unset when several apps need `--app`. */
  appRoot?: string;
  /** Top-level route segments under `appDir`, e.g. "/dashboard", "/login". Route groups `(x)` and private folders `_x` are skipped. */
  routes: string[];
  /** True when any `@auth/*`/`next-auth`, `better-auth`, `@clerk/*`, `@supabase/*` or `firebase` dependency is present. */
  authLibrary?: string;
  /** Set instead of framework/routes when `repoDir` is a workspace monorepo with more than one
   * Next.js app and no `--app`/`opts.app` was given to pick one. */
  apps?: { path: string; routeCount: number }[];
}

function readPackageJson(repoDir: string): Record<string, unknown> | undefined {
  const file = join(repoDir, "package.json");
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function findAppDir(repoDir: string): string | undefined {
  for (const candidate of ["app", join("src", "app")]) {
    const full = join(repoDir, candidate);
    if (existsSync(full)) return full;
  }
  return undefined;
}

function routeSegments(appDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(appDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((name) => !name.startsWith("(") && !name.startsWith("_") && !name.startsWith("."));
  } catch {
    return [];
  }
  return entries.map((name) => `/${name}`).sort();
}

const AUTH_LIBRARIES: Record<string, string> = {
  "next-auth": "Auth.js (next-auth)",
  "@auth/core": "Auth.js",
  "better-auth": "better-auth",
  "@clerk/nextjs": "Clerk",
  "@supabase/auth-helpers-nextjs": "Supabase Auth",
  "@supabase/ssr": "Supabase Auth",
  firebase: "Firebase Auth",
};

function detectAuthLibrary(pkg: Record<string, unknown> | undefined): string | undefined {
  if (!pkg) return undefined;
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };
  for (const [name, label] of Object.entries(AUTH_LIBRARIES)) {
    if (deps[name]) return label;
  }
  // Any other `@auth/*` package (a framework integration or a database adapter) is Auth.js too.
  if (Object.keys(deps).some((name) => name.startsWith("@auth/"))) return "Auth.js";
  return undefined;
}

function isNextApp(dir: string, pkg: Record<string, unknown> | undefined): boolean {
  const deps = {
    ...(pkg?.dependencies as Record<string, string> | undefined),
    ...(pkg?.devDependencies as Record<string, string> | undefined),
  };
  return (
    Boolean(deps?.next) ||
    existsSync(join(dir, "next.config.js")) ||
    existsSync(join(dir, "next.config.mjs")) ||
    existsSync(join(dir, "next.config.ts"))
  );
}

/** Detects the app's framework, its App Router routes, and any recognised sign-in library.
 * Read-only — never writes to `repoDir`. `opts.app` picks a specific app directory inside a
 * workspace monorepo; without it, a monorepo with exactly one Next.js app is detected
 * automatically, and one with several returns `apps` for the caller to disambiguate with
 * `--app`. */
export function detectFramework(repoDir: string, opts: DetectOptions = {}): DetectResult {
  const scanRoot = opts.app ? (isAbsolute(opts.app) ? opts.app : join(repoDir, opts.app)) : repoDir;
  const pkg = readPackageJson(scanRoot);
  const appDir = findAppDir(scanRoot);
  const isNext = isNextApp(scanRoot, pkg);

  if ((!isNext || !appDir) && !opts.app) {
    const candidates = findWorkspaceNextApps(repoDir);
    if (candidates.length === 1) {
      return detectFramework(repoDir, { app: relative(repoDir, candidates[0]) });
    }
    if (candidates.length > 1) {
      const apps = candidates.map((dir) => ({ path: relative(repoDir, dir), routeCount: countRoutesForApp(dir) }));
      return { framework: "unknown", routes: [], authLibrary: detectAuthLibrary(readPackageJson(repoDir)), apps };
    }
  }

  if (!isNext || !appDir) {
    return { framework: "unknown", appDir, appRoot: scanRoot, routes: [], authLibrary: detectAuthLibrary(pkg) };
  }

  return {
    framework: "nextjs",
    appDir,
    appRoot: scanRoot,
    routes: routeSegments(appDir),
    authLibrary: detectAuthLibrary(pkg),
  };
}
