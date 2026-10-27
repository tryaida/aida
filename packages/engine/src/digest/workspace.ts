// Monorepo workspace detection, shared by `aida digest` (build.ts) and `aida init`
// (src/init/detect.ts). A target app repo may be a pnpm/npm/yarn workspace (or a turbo/nx
// monorepo without an explicit package list) with the Next.js app living under `apps/<name>` or
// `packages/<name>` rather than at the repo root — see build-plan.md M14 (a pilot app: pnpm
// monorepo, app in `apps/web`). Read-only: never writes to the scanned repo.
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import * as YAML from "yaml";

const APP_PAGE_FILES = ["page.tsx", "page.jsx", "page.ts"];

function readJsonIfValid(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Workspace member globs from pnpm-workspace.yaml, package.json#workspaces, or (for turbo/nx,
 * which don't name members explicitly) the conventional `apps/*`/`packages/*` fallback. */
function readWorkspaceGlobs(repoRoot: string): string[] {
  const pnpmFile = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmFile)) {
    try {
      const parsed = YAML.parse(readFileSync(pnpmFile, "utf8")) as { packages?: unknown } | undefined;
      if (parsed && Array.isArray(parsed.packages)) {
        return parsed.packages.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // fall through to other signals
    }
  }

  const pkg = readJsonIfValid(join(repoRoot, "package.json"));
  const ws = pkg?.workspaces as string[] | { packages?: string[] } | undefined;
  if (Array.isArray(ws)) return ws;
  if (ws && Array.isArray(ws.packages)) return ws.packages;

  if (existsSync(join(repoRoot, "turbo.json")) || existsSync(join(repoRoot, "nx.json"))) {
    return ["apps/*", "packages/*"];
  }

  return [];
}

/** Expands one workspace glob to directories. Only a trailing `/*` wildcard is supported — the
 * common case for every package manager's workspace syntax — an exact (non-wildcard) entry is
 * treated as a single directory. */
function expandGlob(repoRoot: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized.includes("*")) {
    const full = join(repoRoot, normalized);
    return existsSync(full) && statSync(full).isDirectory() ? [full] : [];
  }
  if (!normalized.endsWith("/*")) return []; // unsupported glob shape (mid-string wildcard etc.)
  const baseDir = join(repoRoot, normalized.slice(0, -2));
  if (!existsSync(baseDir)) return [];
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => join(baseDir, e.name));
}

function hasNextDependency(dir: string): boolean {
  const pkg = readJsonIfValid(join(dir, "package.json"));
  if (!pkg) return false;
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
  return Boolean(deps?.next);
}

function appOrPagesDir(dir: string): string | undefined {
  for (const candidate of [join(dir, "src", "app"), join(dir, "app"), join(dir, "src", "pages"), join(dir, "pages")]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return undefined;
}

/**
 * Finds Next.js app directories within a workspace monorepo (`apps/*`, `packages/*`, and
 * whatever else the workspace config names), by looking for a `next` dependency plus an
 * `app/`/`src/app`/`pages/`/`src/pages` directory. Returns absolute directory paths, sorted.
 * Empty when `repoRoot` isn't a recognised workspace monorepo, or no member looks like a Next.js
 * app.
 */
export function findWorkspaceNextApps(repoRoot: string): string[] {
  const globs = readWorkspaceGlobs(repoRoot);
  if (globs.length === 0) return [];
  const dirs = new Set<string>();
  for (const glob of globs) {
    for (const dir of expandGlob(repoRoot, glob)) dirs.add(dir);
  }
  return [...dirs].filter((dir) => hasNextDependency(dir) && appOrPagesDir(dir) !== undefined).sort();
}

function countPageFilesUnder(dir: string, isAppRouter: boolean, depth = 0): number {
  if (depth > 12) return 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let count = 0;
  if (isAppRouter) {
    if (entries.some((e) => e.isFile() && APP_PAGE_FILES.includes(e.name))) count += 1;
  } else {
    for (const e of entries) {
      if (!e.isFile() || !/\.(tsx|jsx|ts|js)$/.test(e.name)) continue;
      if (/\.(test|spec)\.[tj]sx?$/.test(e.name)) continue;
      if (e.name.startsWith("_")) continue;
      count += 1;
    }
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
    if (!isAppRouter && e.name === "api") continue; // API routes aren't pages
    if (isAppRouter && e.name.startsWith("_")) continue;
    count += countPageFilesUnder(join(dir, e.name), isAppRouter, depth + 1);
  }
  return count;
}

/** A quick recursive page/route count for one app directory — cheap enough to run once per
 * workspace candidate just to report route counts in an ambiguous-apps message. */
export function countRoutesForApp(appDir: string): number {
  for (const candidate of [join(appDir, "src", "app"), join(appDir, "app")]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return countPageFilesUnder(candidate, true);
  }
  for (const candidate of [join(appDir, "src", "pages"), join(appDir, "pages")]) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return countPageFilesUnder(candidate, false);
  }
  return 0;
}

/** Workspace apps as `{ path, routeCount }`, `path` relative to `repoRoot`, sorted by path. */
export function listWorkspaceAppsWithRouteCounts(repoRoot: string): { path: string; routeCount: number }[] {
  return findWorkspaceNextApps(repoRoot).map((dir) => ({
    path: relative(repoRoot, dir),
    routeCount: countRoutesForApp(dir),
  }));
}
