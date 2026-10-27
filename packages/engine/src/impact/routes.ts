// API-route discovery for `aida affected` (build-plan.md M17) — the counterpart to
// digest/build.ts's page-route walker, which deliberately skips `api/` directories (they aren't
// pages). Mirrors its conventions: App Router `route.ts` handlers and Pages Router `pages/api/**`
// files, dynamic `[param]`/`[...param]` segments, route groups ignored for API paths (groups
// don't appear in the URL for routes either, but matter even less under api/).
import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

export interface ApiRoute {
  /** URL path, e.g. "/api/teams/[id]". */
  path: string;
  /** File path relative to the scanned app root, e.g. "app/api/teams/[id]/route.ts". */
  file: string;
  dynamic: boolean;
}

const APP_API_CANDIDATES = [join("src", "app", "api"), join("app", "api")];
const PAGES_API_CANDIDATES = [join("src", "pages", "api"), join("pages", "api")];
const APP_ROUTE_FILES = ["route.ts", "route.tsx", "route.js"];

function isDynamicSegment(name: string): boolean {
  return name.startsWith("[") && name.endsWith("]");
}

function isGroupSegment(name: string): boolean {
  return name.startsWith("(") && name.endsWith(")");
}

function walkAppApiRoutes(appRoot: string, apiDir: string): ApiRoute[] {
  const routes: ApiRoute[] = [];

  function visit(current: string, segments: string[], dynamic: boolean) {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    const routeFile = APP_ROUTE_FILES.find((f) => entries.some((e) => e.isFile() && e.name === f));
    if (routeFile) {
      routes.push({
        path: "/" + ["api", ...segments].join("/"),
        file: relative(appRoot, join(current, routeFile)),
        dynamic,
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const childDir = join(current, entry.name);
      if (isGroupSegment(entry.name)) {
        visit(childDir, segments, dynamic);
        continue;
      }
      visit(childDir, [...segments, entry.name], dynamic || isDynamicSegment(entry.name));
    }
  }

  visit(apiDir, [], false);
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

function walkPagesApiRoutes(appRoot: string, apiDir: string): ApiRoute[] {
  const routes: ApiRoute[] = [];

  function visit(current: string, segments: string[], dynamic: boolean) {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, [...segments, entry.name], dynamic || isDynamicSegment(entry.name));
        continue;
      }
      if (!/\.(tsx|jsx|ts|js)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;
      const base = entry.name.replace(/\.(tsx|jsx|ts|js)$/, "");
      const fileSegments = base === "index" ? segments : [...segments, base];
      routes.push({
        path: "/" + ["api", ...fileSegments].join("/"),
        file: relative(appRoot, full),
        dynamic: dynamic || isDynamicSegment(base),
      });
    }
  }

  visit(apiDir, [], false);
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * API routes under `appRoot` (the resolved scan root a `digest`/`buildDigest` call already
 * settled on — see src/digest/build.ts). Returns `[]` when neither router's `api/` tree exists.
 */
export function listApiRoutes(appRoot: string): ApiRoute[] {
  for (const candidate of APP_API_CANDIDATES) {
    const full = join(appRoot, candidate);
    if (existsSync(full) && statSync(full).isDirectory()) return walkAppApiRoutes(appRoot, full);
  }
  for (const candidate of PAGES_API_CANDIDATES) {
    const full = join(appRoot, candidate);
    if (existsSync(full) && statSync(full).isDirectory()) return walkPagesApiRoutes(appRoot, full);
  }
  return [];
}
