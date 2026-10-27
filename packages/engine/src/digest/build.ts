// Builds a compact map of a target Next.js app repo: routes, roles, on-screen labels and sign-in
// method. See scope.md "Token efficiency, models and subagents" — this is the read-only
// counterpart to detect.ts's init-time framework detection, but scoped for agent consumption
// (digest, not config scaffolding) and covering both App Router and Pages Router.
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { DigestResult, DigestRoute } from "./types.js";
import { findWorkspaceNextApps, countRoutesForApp } from "./workspace.js";

export interface BuildDigestOptions {
  /** Route-prefix filter, e.g. "/dashboard/competitors" — scopes routes/labels/roles to that subtree. */
  area?: string;
  /** Soft cap passed through to formatDigest's text output. */
  maxLines?: number;
  /** Max on-screen labels recorded per route. */
  maxLabelsPerRoute?: number;
  /** Explicit app directory within a workspace monorepo (relative to `appRepo`, or absolute).
   * Required when `appRepo` is a monorepo with more than one Next.js app. */
  app?: string;
}

const DEFAULT_MAX_LABELS_PER_ROUTE = 8;

const APP_PAGE_FILES = ["page.tsx", "page.jsx", "page.ts"];
const APP_CANDIDATES = [join("src", "app"), "app"];
const PAGES_CANDIDATES = [join("src", "pages"), "pages"];

const AUTH_SIGNALS: Array<{ match: RegExp; label: string }> = [
  { match: /(^|['"])next-auth(['"\/]|$)/, label: "Auth.js" },
  { match: /(^|['"])@auth\/core(['"\/]|$)/, label: "Auth.js" },
  { match: /(^|['"])@clerk\//, label: "Clerk" },
  { match: /(^|['"])@supabase\/(auth-helpers|ssr)/, label: "Supabase Auth" },
  { match: /(^|['"])firebase\/auth(['"\/]|$)/, label: "Firebase Auth" },
];

function findRouterRoot(appRepo: string): { kind: "nextjs-app" | "nextjs-pages"; dir: string } | undefined {
  for (const candidate of APP_CANDIDATES) {
    const full = join(appRepo, candidate);
    if (existsSync(full) && statSync(full).isDirectory()) return { kind: "nextjs-app", dir: full };
  }
  for (const candidate of PAGES_CANDIDATES) {
    const full = join(appRepo, candidate);
    if (existsSync(full) && statSync(full).isDirectory()) return { kind: "nextjs-pages", dir: full };
  }
  return undefined;
}

function isDynamicSegment(name: string): boolean {
  return name.startsWith("[") && name.endsWith("]");
}

function isGroupSegment(name: string): boolean {
  return name.startsWith("(") && name.endsWith(")");
}

/** Walks an App Router `app/` tree, collecting one DigestRoute per folder containing a page file. */
function walkAppRouter(appRepo: string, dir: string): DigestRoute[] {
  const routes: DigestRoute[] = [];

  function visit(current: string, pathSegments: string[], dynamic: boolean, group: string | undefined) {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    const pageFile = APP_PAGE_FILES.find((f) => entries.some((e) => e.isFile() && e.name === f));
    if (pageFile) {
      const routePath = "/" + pathSegments.join("/");
      routes.push({
        path: routePath === "/" ? "/" : routePath,
        file: relative(appRepo, join(current, pageFile)),
        dynamic,
        group,
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const childDir = join(current, entry.name);
      if (isGroupSegment(entry.name)) {
        visit(childDir, pathSegments, dynamic, entry.name);
        continue;
      }
      const childDynamic = dynamic || isDynamicSegment(entry.name);
      visit(childDir, [...pathSegments, entry.name], childDynamic, group);
    }
  }

  visit(dir, [], false, undefined);
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Walks a Pages Router `pages/` tree: each file directly under it (or a subfolder) is a route. */
function walkPagesRouter(appRepo: string, dir: string): DigestRoute[] {
  const routes: DigestRoute[] = [];

  function visit(current: string, pathSegments: string[], dynamic: boolean) {
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
        const childDynamic = dynamic || isDynamicSegment(entry.name);
        visit(full, [...pathSegments, entry.name], childDynamic);
        continue;
      }
      if (!/\.(tsx|jsx|ts|js)$/.test(entry.name)) continue;
      if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;
      const base = entry.name.replace(/\.(tsx|jsx|ts|js)$/, "");
      if (base === "api" || pathSegments[0] === "api") continue; // skip API routes, not pages
      const segments = base === "index" ? pathSegments : [...pathSegments, base];
      const routePath = "/" + segments.join("/");
      const fileDynamic = dynamic || isDynamicSegment(base);
      routes.push({
        path: routePath === "/" ? "/" : routePath,
        file: relative(appRepo, full),
        dynamic: fileDynamic,
      });
    }
  }

  visit(dir, [], false);
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

function listFilesRecursive(dir: string, matcher: (name: string, full: string) => boolean, maxDepth = 6): string[] {
  const out: string[] = [];
  function visit(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
      } else if (matcher(entry.name, full)) {
        out.push(full);
      }
    }
  }
  visit(dir, 0);
  return out;
}

const AUTH_PATH_PATTERN = /auth|permission|role|rbac/i;

function findAuthLikeFiles(appRepo: string): string[] {
  return listFilesRecursive(appRepo, (name, full) => {
    if (!/\.(tsx|jsx|ts|js)$/.test(name)) return false;
    if (!AUTH_PATH_PATTERN.test(full)) return false;
    return true;
  });
}

const ROLE_ENUM_PATTERN = /enum\s+\w*[Rr]ole\w*\s*\{([^}]*)\}/g;
const ROLE_UNION_LINE_PATTERN = /\b\w*[Rr]ole\w*\s*[:=]\s*((?:'[^']+'|"[^"]+")(?:\s*\|\s*(?:'[^']+'|"[^"]+"))+)/g;
const ROLE_ARRAY_PATTERN = /\b\w*[Rr]oles?\w*\s*[:=]\s*\[([^\]]*)\]/g;
const STRING_LITERAL_PATTERN = /['"]([a-zA-Z][a-zA-Z0-9_-]*)['"]/g;

function extractRoles(source: string): string[] {
  const roles = new Set<string>();

  for (const match of source.matchAll(ROLE_ENUM_PATTERN)) {
    const body = match[1];
    for (const m of body.matchAll(/(\w+)\s*(=\s*['"]?[\w-]+['"]?)?\s*,?/g)) {
      if (m[1]) roles.add(m[1]);
    }
  }

  for (const match of source.matchAll(ROLE_UNION_LINE_PATTERN)) {
    for (const lit of match[1].matchAll(STRING_LITERAL_PATTERN)) {
      roles.add(lit[1]);
    }
  }

  for (const match of source.matchAll(ROLE_ARRAY_PATTERN)) {
    for (const lit of match[1].matchAll(STRING_LITERAL_PATTERN)) {
      roles.add(lit[1]);
    }
  }

  return [...roles];
}

function detectRoles(appRepo: string): string[] {
  const files = findAuthLikeFiles(appRepo);
  const roles = new Set<string>();
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const r of extractRoles(source)) roles.add(r);
  }
  return [...roles].sort();
}

function detectSignInMethod(appRepo: string): string | undefined {
  const pkgFile = join(appRepo, "package.json");
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      if (deps["next-auth"] || deps["@auth/core"]) return "Auth.js";
      if (Object.keys(deps).some((d) => d.startsWith("@clerk/"))) return "Clerk";
      if (deps["@supabase/auth-helpers-nextjs"] || deps["@supabase/ssr"]) return "Supabase Auth";
      if (deps.firebase) return "Firebase Auth";
    } catch {
      // fall through to source scan
    }
  }

  const sourceFiles = listFilesRecursive(appRepo, (name) => /\.(tsx|jsx|ts|js)$/.test(name), 4).slice(0, 500);
  for (const file of sourceFiles) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const signal of AUTH_SIGNALS) {
      if (signal.match.test(source)) return signal.label;
    }
  }
  return undefined;
}

// Label extraction: short JSX text children, and label-ish prop values (label=, title=,
// aria-label=), plus text inside <button>/<Button> tags.
const LABEL_PROP_PATTERN = /\b(?:label|title|aria-label)\s*=\s*["']([^"']{1,40})["']/g;
const BUTTON_TAG_PATTERN = /<(?:button|Button)\b[^>]*>\s*([^<{][^<]{0,39})\s*<\/(?:button|Button)>/g;
const JSX_TEXT_CHILD_PATTERN = />\s*([A-Za-z][^<>{}\n]{1,39})\s*</g;

function looksLikeLabel(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > 40) return false;
  if (/^[{}/]/.test(trimmed)) return false;
  // Skip things that look like whole sentences (multiple clauses ending with punctuation + space)
  if (/[.!?]\s+\w/.test(trimmed)) return false;
  return true;
}

function extractLabels(source: string, cap: number): string[] {
  const labels = new Set<string>();

  for (const match of source.matchAll(LABEL_PROP_PATTERN)) {
    if (looksLikeLabel(match[1])) labels.add(match[1].trim());
    if (labels.size >= cap) return [...labels];
  }
  for (const match of source.matchAll(BUTTON_TAG_PATTERN)) {
    if (looksLikeLabel(match[1])) labels.add(match[1].trim());
    if (labels.size >= cap) return [...labels];
  }
  for (const match of source.matchAll(JSX_TEXT_CHILD_PATTERN)) {
    if (looksLikeLabel(match[1])) labels.add(match[1].trim());
    if (labels.size >= cap) return [...labels];
  }

  return [...labels].slice(0, cap);
}

/** Finds component files directly imported by `source`, one level deep, co-located in `routeDir`. */
function coLocatedImports(source: string, routeDir: string): string[] {
  const out: string[] = [];
  const importPattern = /from\s+["'](\.\/[^"']+|\.\.\/[^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const spec = match[1];
    if (!spec.startsWith("./")) continue; // only same-folder, "one level deep" co-located components
    for (const ext of [".tsx", ".jsx", ".ts", ".js"]) {
      const full = join(routeDir, spec + ext);
      if (existsSync(full)) {
        out.push(full);
        break;
      }
    }
  }
  return out;
}

function labelsForRoute(routeFile: string, appRepo: string, cap: number): string[] {
  const fullPath = join(appRepo, routeFile);
  let source: string;
  try {
    source = readFileSync(fullPath, "utf8");
  } catch {
    return [];
  }
  const routeDir = fullPath.slice(0, fullPath.length - (routeFile.split("/").pop()?.length ?? 0));
  const files = [fullPath, ...coLocatedImports(source, routeDir)];

  const labels = new Set<string>();
  for (const file of files) {
    let text = source;
    if (file !== fullPath) {
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
    }
    for (const label of extractLabels(text, cap)) {
      labels.add(label);
      if (labels.size >= cap) return [...labels];
    }
  }
  return [...labels];
}

function matchesArea(routePath: string, area?: string): boolean {
  if (!area) return true;
  const normalized = area.endsWith("/") ? area.slice(0, -1) : area;
  return routePath === normalized || routePath.startsWith(normalized + "/");
}

export function buildDigest(appRepo: string, opts: BuildDigestOptions = {}): DigestResult {
  const maxLabelsPerRoute = opts.maxLabelsPerRoute ?? DEFAULT_MAX_LABELS_PER_ROUTE;

  let scanRoot = appRepo;
  if (opts.app) {
    scanRoot = isAbsolute(opts.app) ? opts.app : join(appRepo, opts.app);
  }

  let router = findRouterRoot(scanRoot);

  // No Next.js router at the given root, and the caller didn't pin a specific app: this may be a
  // workspace monorepo (pnpm/npm/yarn workspaces, or a turbo/nx repo) with the app living under
  // apps/* or packages/* (build-plan.md M14: a pilot app in apps/web) — look there before
  // giving up.
  if (!router && !opts.app) {
    const candidates = findWorkspaceNextApps(appRepo);
    if (candidates.length === 1) {
      scanRoot = candidates[0];
      router = findRouterRoot(scanRoot);
    } else if (candidates.length > 1) {
      const apps = candidates.map((dir) => ({ path: relative(appRepo, dir), routeCount: countRoutesForApp(dir) }));
      const message = `found ${apps.length} Next.js apps in this workspace — pass --app <path> to pick one: ${apps
        .map((a) => `${a.path} (${a.routeCount} routes)`)
        .join(", ")}`;
      return {
        appRepo,
        framework: "unknown",
        routes: [],
        roles: [],
        labelsByRoute: {},
        signInMethod: undefined,
        truncated: false,
        apps,
        message,
      };
    }
  }

  let framework: DigestResult["framework"] = "unknown";
  let allRoutes: DigestRoute[] = [];
  if (router?.kind === "nextjs-app") {
    framework = "nextjs-app";
    allRoutes = walkAppRouter(scanRoot, router.dir);
  } else if (router?.kind === "nextjs-pages") {
    framework = "nextjs-pages";
    allRoutes = walkPagesRouter(scanRoot, router.dir);
  }

  const routes = allRoutes.filter((r) => matchesArea(r.path, opts.area));

  const allRoles = detectRoles(scanRoot);
  // Role detection isn't route-scoped by construction; when an area filter is given we keep the
  // full role list since roles are usually app-wide, not per-route.
  const roles = allRoles;

  const labelsByRoute: Record<string, string[]> = {};
  for (const route of routes) {
    const labels = labelsForRoute(route.file, scanRoot, maxLabelsPerRoute);
    if (labels.length > 0) labelsByRoute[route.path] = labels;
  }

  const signInMethod = detectSignInMethod(scanRoot) ?? "unknown";

  return {
    appRepo: scanRoot,
    framework,
    routes,
    roles,
    labelsByRoute,
    signInMethod,
    truncated: false,
  };
}

const DEFAULT_MAX_LINES = 200;

/** Groups a route for the over-cap summary view: its route group (e.g. "(dashboard)") when it
 * has one, else its first path segment (e.g. "/dashboard/competitors/[id]" -> "/dashboard"). */
function routeGroupKey(route: DigestRoute): string {
  if (route.group) return route.group;
  const segment = route.path.split("/").filter(Boolean)[0];
  return segment ? `/${segment}` : "/";
}

/** Renders a DigestResult as terse text, hard-capped to ~`maxLines` lines total. A large app
 * (e.g. a pilot app's apps/web, 142 routes) can blow the cap even at one line per route — rather
 * than dump a half-cut route list, fall back to counts per route group and point at `--area` for
 * detail on any one of them. */
export function formatDigest(result: DigestResult, opts: { maxLines?: number } = {}): string {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const lines: string[] = [];

  lines.push(`app: ${result.appRepo}`);
  lines.push(`framework: ${result.framework}`);

  if (result.apps && result.apps.length > 0) {
    lines.push(result.message ?? `found ${result.apps.length} Next.js apps — pass --app <path> to pick one`);
    for (const app of result.apps) lines.push(`  ${app.path} (${app.routeCount} routes)`);
    result.truncated = false;
    return lines.join("\n");
  }

  lines.push(`sign-in: ${result.signInMethod ?? "unknown"}`);
  lines.push(`roles: ${result.roles.length > 0 ? result.roles.join(", ") : "(none detected)"}`);
  lines.push("");
  lines.push(`routes (${result.routes.length}):`);

  const estimatedRouteLines = result.routes.reduce(
    (sum, r) => sum + (result.labelsByRoute[r.path]?.length ? 2 : 1),
    0,
  );

  if (lines.length + estimatedRouteLines > maxLines) {
    const counts = new Map<string, number>();
    for (const route of result.routes) {
      const key = routeGroupKey(route);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    lines.pop(); // the "routes (N):" header above is replaced by the summary line below
    lines.push(
      `routes (${result.routes.length}) — too many to list in full; summary by route group (pass --area <path> for one area's full detail):`,
    );
    const sortedGroups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [key, count] of sortedGroups) {
      if (lines.length >= maxLines) break;
      lines.push(`  ${key}: ${count} route(s)`);
    }
    result.truncated = true;
    return lines.join("\n");
  }

  for (const route of result.routes) {
    const flags = [route.dynamic ? "dynamic" : undefined, route.group ? `group:${route.group}` : undefined]
      .filter(Boolean)
      .join(" ");
    lines.push(`  ${route.path}${flags ? ` [${flags}]` : ""} -> ${route.file}`);
    const labels = result.labelsByRoute[route.path];
    if (labels && labels.length > 0) lines.push(`    labels: ${labels.join(", ")}`);
  }

  result.truncated = false;
  return lines.join("\n");
}
