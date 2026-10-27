// `aida paths <id>` (decision 34; build-plan.md M33): finds other screens a task can start from.
// Deterministic and token-cheap: from the main run's captured writes (method + route, or a Next.js
// server action id), find every place in the app's source that makes the same call, map each call
// site to the pages that render it (the M17 import graph), and list the pages the walkthrough and
// its `paths` don't cover yet. Candidates only — the writer inspects each and asks before adding.
//
// How a write is matched to source:
//   - an API route (`POST /api/payments/[id]`): string and template literals naming that route,
//     with the method read from the call (`.post(`, `method: "POST"`; a bare `fetch(` is a GET);
//   - a tRPC call (`/api/trpc/payments.create`): `.payments.create.useMutation`/`.mutate`;
//   - a server action: `.next/server/server-reference-manifest.json` (from `next build`) names the
//     pages that use it, and, when it records the source file and export, their call sites.
//
// How a call site is matched to pages (M35): a page renders its own imports and every layout and
// template above it (screens.ts: route groups and `@slot` folders aren't URL segments; an
// intercepting route shows over the page the reader came from), following tsconfig/jsconfig
// aliases and barrel re-exports by name (source-graph.ts).
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CaptureManifest, ImpactRequest } from "../capture/types.js";
import { readPathCaptures, routePattern, writeKey } from "../capture/path-files.js";
import type { Walkthrough } from "../walkthrough/index.js";
import { buildDigest } from "../digest/index.js";
import { SourceGraph } from "./source-graph.js";
import { screensOf, type Screen } from "./screens.js";
import { listApiRoutes } from "../impact/routes.js";
import { normalizeUrlPath, routeToRegex } from "../impact/match.js";

export interface CallSite {
  /** Relative to the app root. */
  file: string;
  line: number;
  /** The line, trimmed and capped. */
  text: string;
}

export interface DiscoveredWrite {
  /** The comparable key capture uses (`POST /api/payments/:id`, `POST action <id>`). */
  key: string;
  method: string;
  /** The framework route the request hit, e.g. `/api/payments/[id]`, when one matches. */
  route?: string;
  /** That route's handler file. */
  handler?: string;
  /** Server action id. */
  action?: string;
  /** First main step that made it. */
  step?: string;
  callSites: CallSite[];
}

export interface PathCandidate {
  /** Page route, e.g. `/payments`. */
  route: string;
  /** Its page file. */
  file: string;
  /** The write key it makes. */
  write: string;
  /** `file:line` of the call site the page renders (or the page itself, for a server action
   * found only through the build manifest), plus where it renders from when that isn't the page's
   * own imports: `components/pay.tsx:4 (layout app/(dash)/layout.tsx)`. */
  via: string;
  /** The layout, template or `_app` that renders the call site, when the page itself doesn't. */
  layout?: string;
  /** A parallel route's slot (`@slot`) the page is in. */
  slot?: string;
  /** An intercepting route: the URL it opens as over `route`. */
  intercepts?: string;
  /** The page edits a record that already exists (an `/edit` route or an edit/update form): it
   * calls the same save but is rarely another way to create one, so it's listed last. */
  edits?: true;
}

export interface CoveredRoute {
  route: string;
  /** "main" or "path <id>". */
  by: string;
}

export interface DiscoverPathsResult {
  ok: true;
  walkthrough: string;
  appRoot: string;
  writes: DiscoveredWrite[];
  /** Pages that make one of the main path's writes and aren't covered yet. */
  candidates: PathCandidate[];
  /** Pages that make one of the writes and the walkthrough or a path already starts on or visits. */
  covered: CoveredRoute[];
  /** Plain-words notes, e.g. a server action that needs `next build` to be mapped. */
  notes: string[];
}

export interface DiscoverPathsOptions {
  walkthrough: Walkthrough;
  /** The walkthrough's capture dir (`.build/<id>/capture`). */
  captureDir: string;
  appRepo: string;
  /** App directory within a workspace monorepo. */
  app?: string;
  /** Cap on candidates listed (default 20). */
  limit?: number;
}

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "out", "coverage", ".turbo", ".vercel"]);
const SOURCE_EXT = /\.(tsx?|jsx?|mjs)$/;
const MAX_FILES = 5000;
const MAX_BYTES = 512 * 1024;

/** Source files under `root` an app's UI could call from (no tests, declarations or build output). */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) return;
      // Never follow a symlink: it can point outside the app (or loop back into it).
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name));
      } else if (e.isFile() && SOURCE_EXT.test(e.name) && !/\.(test|spec)\.[tj]sx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        const full = join(dir, e.name);
        try {
          const st = lstatSync(full);
          if (st.isFile() && st.size <= MAX_BYTES) out.push(full);
        } catch {
          // unreadable: skip
        }
      }
    }
  };
  walk(root);
  return out;
}

function rel(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex for a route written as a string or template literal in source: `"/api/payments"`,
 * `` `/api/payments/${id}` ``, `` `${base}/api/payments` ``. Not a longer route sharing the prefix. */
export function literalRouteRegex(route: string): RegExp {
  const body = route
    .split("/")
    .filter(Boolean)
    .map((seg) => {
      if (/^\[\[?\.\.\..+\]\]?$/.test(seg)) return "(?:[^\"'`\\s]*)";
      if (/^\[.+\]$/.test(seg)) return "(?:\\$\\{[^}]*\\}|[^/\"'`\\s?#$]+)";
      return escapeRe(seg);
    })
    .join("/");
  return new RegExp(`(?:["'\`]|\\})/${body}/?(?=["'\`?#]|\\$\\{)`);
}

const METHOD_CALL = /\.(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(/i;
const METHOD_OPTION = /method\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i;

/** The HTTP method a call site uses, when the code says: `.post(` before the literal on the
 * line, `method: "POST"` nearby, or a bare `fetch(` (GET). Undefined when it can't tell. */
export function callSiteMethod(lines: string[], index: number, column: number): string | undefined {
  const before = lines[index].slice(0, column);
  const call = METHOD_CALL.exec(before);
  if (call) return call[1].toUpperCase();
  for (let i = index; i < Math.min(lines.length, index + 8); i++) {
    const m = METHOD_OPTION.exec(lines[i]);
    if (m) return m[1].toUpperCase();
  }
  if (/\bfetch\s*\(/.test(before)) return "GET";
  return undefined;
}

function snippet(line: string): string {
  const t = line.trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

interface SourceIndex {
  root: string;
  files: { file: string; lines: string[] }[];
}

function indexSources(root: string): SourceIndex {
  return {
    root,
    files: sourceFiles(root).map((file) => {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        // unreadable
      }
      return { file, lines: text.split("\n") };
    }),
  };
}

function apiCallSites(index: SourceIndex, route: string, method: string): CallSite[] {
  const re = literalRouteRegex(route);
  const out: CallSite[] = [];
  for (const { file, lines } of index.files) {
    // A route handler names its own path in comments and redirects; it never calls itself.
    if (/\/route\.[tj]sx?$/.test(file) && file.includes(`${sep}api${sep}`)) continue;
    lines.forEach((line, i) => {
      const m = re.exec(line);
      if (!m) return;
      const used = callSiteMethod(lines, i, m.index);
      if (used !== undefined && used !== method) return;
      out.push({ file: rel(index.root, file), line: i + 1, text: snippet(line) });
    });
  }
  return out;
}

function trpcCallSites(index: SourceIndex, procedures: string[]): CallSite[] {
  const out: CallSite[] = [];
  for (const proc of procedures) {
    const re = new RegExp(`\\.${escapeRe(proc)}\\.(?:useMutation|mutate|mutateAsync)\\b`);
    for (const { file, lines } of index.files) {
      lines.forEach((line, i) => {
        if (re.test(line)) out.push({ file: rel(index.root, file), line: i + 1, text: snippet(line) });
      });
    }
  }
  return out;
}

interface ServerActionEntry {
  workers?: Record<string, unknown>;
  filename?: string;
  exportedName?: string;
}

function readServerActions(appRoot: string): Record<string, ServerActionEntry> | undefined {
  const file = join(appRoot, ".next", "server", "server-reference-manifest.json");
  if (!existsSync(file)) return undefined;
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as { node?: Record<string, ServerActionEntry>; edge?: Record<string, ServerActionEntry> };
    return { ...(json.edge ?? {}), ...(json.node ?? {}) };
  } catch {
    return undefined;
  }
}

function moduleKey(file: string): string {
  return file.replace(/\.[tj]sx?$/, "").replace(/^src\//, "");
}

/** The screens a build-manifest worker key (`app/(shop)/payments/page`, or a layout) names. */
function screensForWorker(worker: string, screens: Screen[]): { screen: Screen; layout?: string }[] {
  const key = worker.replace(/^src\//, "");
  const page = screens.filter((s) => moduleKey(s.file) === key);
  if (page.length > 0) return page.map((screen) => ({ screen }));
  const out: { screen: Screen; layout?: string }[] = [];
  for (const screen of screens) {
    const layout = screen.wrappers.find((w) => moduleKey(w) === key);
    if (layout) out.push({ screen, layout });
  }
  return out;
}

function actionCallSites(index: SourceIndex, graph: SourceGraph, entry: ServerActionEntry): CallSite[] {
  if (!entry.filename || !entry.exportedName) return [];
  const actionFile = join(index.root, entry.filename);
  const name = new RegExp(`\\b${escapeRe(entry.exportedName)}\\b`);
  const out: CallSite[] = [];
  for (const { file, lines } of index.files) {
    if (file === actionFile) continue;
    // Files that reach the action's module and name the action outside an import line.
    if (!graph.closure(file).has(actionFile)) continue;
    lines.forEach((line, i) => {
      if (name.test(line) && !/\bimport\b/.test(line)) out.push({ file: rel(index.root, file), line: i + 1, text: snippet(line) });
    });
  }
  return out;
}

/** The first main step that made each distinct write, in capture order. */
function mainWrites(manifest: CaptureManifest): { key: string; request: ImpactRequest; step?: string }[] {
  const seen = new Map<string, { key: string; request: ImpactRequest; step?: string }>();
  for (const step of manifest.steps) {
    for (const r of step.impact?.requests ?? []) {
      const key = writeKey(r);
      if (key && !seen.has(key)) seen.set(key, { key, request: r, ...(step.id ? { step: step.id } : {}) });
    }
  }
  return [...seen.values()];
}

/** Concrete URL paths the walkthrough already covers: start pages and every page a run visited. */
function coveredUrls(walkthrough: Walkthrough, manifest: CaptureManifest, captureDir: string): { url: string; by: string }[] {
  const out: { url: string; by: string }[] = [];
  const add = (url: string | undefined, by: string) => {
    if (!url) return;
    let path = url;
    try {
      path = new URL(url, "http://x").pathname;
    } catch {
      // keep as-is
    }
    out.push({ url: normalizeUrlPath(path), by });
  };
  add(walkthrough.start?.page, "main");
  for (const step of manifest.steps) for (const u of step.impact?.urls ?? []) add(u, "main");
  for (const p of walkthrough.paths ?? []) add(p.start.page, `path ${p.id}`);
  for (const capture of readPathCaptures(captureDir, walkthrough)) {
    for (const step of capture.manifest?.steps ?? []) for (const u of step.impact?.urls ?? []) add(u, `path ${capture.pathId}`);
  }
  return out;
}

/** How specific one route segment is: static beats `[id]`, which beats `[...rest]`, which beats
 * `[[...rest]]`. */
function segmentRank(segment: string): number {
  if (segment.startsWith("[[...")) return 0;
  if (segment.startsWith("[...")) return 1;
  if (segment.startsWith("[")) return 2;
  return 3;
}

/** Positive when route `a` is more specific than `b` (both matching the same URL): compared
 * segment by segment from the left, as Next.js picks a route (`/payments/new` over
 * `/payments/[id]`). */
export function compareRouteSpecificity(a: string, b: string): number {
  const as = a.split("/").filter(Boolean);
  const bs = b.split("/").filter(Boolean);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const ra = i < as.length ? segmentRank(as[i]!) : -1;
    const rb = i < bs.length ? segmentRank(bs[i]!) : -1;
    if (ra !== rb) return ra - rb;
  }
  return 0;
}

/** The route pattern a URL opens, among `routes`: the most specific one that matches, or
 * undefined. A dynamic `/payments/[id]` never claims `/payments/new` when that's a page. */
export function bestRouteFor(url: string, routes: { pattern: string; regex: RegExp }[]): string | undefined {
  let best: string | undefined;
  for (const r of routes) {
    if (!r.regex.test(url)) continue;
    if (best === undefined || compareRouteSpecificity(r.pattern, best) > 0) best = r.pattern;
  }
  return best;
}

/** True for a page that edits an existing record: an `edit` segment in its route or page path,
 * or a call site in an edit/update form (`edit-payment-form.tsx`, `UpdatePayment.tsx`). */
export function editsExistingRecord(screen: Pick<Screen, "route" | "file">, via: string): boolean {
  if (screen.route.split("/").some((s) => /^edit$/i.test(s))) return true;
  if (screen.file.split("/").some((s) => /^edit$/i.test(s))) return true;
  const siteFile = via.split(/[\s:(]/)[0] ?? "";
  const base = siteFile.split("/").pop() ?? "";
  return /(^|[-_.])(edit|update)([-_.]|$)/i.test(base) || /^(Edit|Update)[A-Z]/.test(base);
}

interface Found {
  screen: Screen;
  via: string;
  layout?: string;
}

/** `layout`, `template` or `_app`, from a wrapper's file name. */
function wrapperKind(file: string): string {
  const base = file.split("/").pop()!.replace(/\.[^.]+$/, "");
  return base === "_app" ? "_app" : base;
}

/** See the module comment. Throws when there's no capture to start from or the app root can't be
 * settled (an ambiguous monorepo without `app`). */
export function discoverPaths(opts: DiscoverPathsOptions): DiscoverPathsResult {
  const manifestFile = join(opts.captureDir, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(`no capture for "${opts.walkthrough.walkthrough}" yet (${manifestFile}); run aida capture first`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as CaptureManifest;
  const digest = buildDigest(opts.appRepo, { app: opts.app });
  if (digest.apps && digest.apps.length > 0) throw new Error(digest.message ?? "several apps found; pass --app to pick one");
  const root = digest.appRepo;
  const screens = screensOf(root, digest.routes);
  const apiRoutes = listApiRoutes(root).map((r) => ({ ...r, regex: routeToRegex(r.path) }));
  const index = indexSources(root);
  const graph = new SourceGraph(root);
  const notes: string[] = [];
  let serverActions: Record<string, ServerActionEntry> | undefined;
  let serverActionsRead = false;

  const writes: DiscoveredWrite[] = [];
  const pagesByWrite = new Map<string, Found[]>();
  for (const { key, request, step } of mainWrites(manifest)) {
    const method = request.method.toUpperCase();
    const write: DiscoveredWrite = { key, method, ...(step ? { step } : {}), callSites: [] };
    const direct: Found[] = [];
    if (request.action) {
      write.action = request.action;
      if (!serverActionsRead) {
        serverActions = readServerActions(root);
        serverActionsRead = true;
      }
      const entry = serverActions?.[request.action];
      if (!serverActions) {
        notes.push(`server action ${request.action}: run \`next build\` in the app so .next/server/server-reference-manifest.json maps it to pages`);
      } else if (!entry) {
        notes.push(`server action ${request.action} isn't in the app's last build; rebuild the app (next build) and run this again`);
      } else {
        write.callSites = actionCallSites(index, graph, entry);
        for (const worker of Object.keys(entry.workers ?? {})) {
          for (const { screen, layout } of screensForWorker(worker, screens)) {
            direct.push({ screen, via: layout ? `${screen.file} (${wrapperKind(layout)} ${layout})` : screen.file, ...(layout ? { layout } : {}) });
          }
        }
      }
    } else {
      const pathname = normalizeUrlPath(request.path);
      const trpc = /^\/api\/trpc\/([^/]+)$/.exec(pathname);
      const api = apiRoutes.find((r) => r.regex.test(pathname));
      if (api) {
        write.route = api.path;
        write.handler = api.file;
      }
      if (trpc) {
        write.callSites = trpcCallSites(index, decodeURIComponent(trpc[1]).split(","));
      } else {
        write.callSites = apiCallSites(index, api?.path ?? routePattern(pathname).replace(/:id/g, "[id]"), method);
      }
    }
    writes.push(write);

    // Pages that render a call site: through the page's own imports first, then through the
    // layouts and templates around it (screens.ts).
    const found = [...direct];
    const throughWrappers: Found[] = [];
    const wrapperReach = new Map<string, number>();
    for (const site of write.callSites) {
      const siteFile = join(root, site.file);
      const at = `${site.file}:${site.line}`;
      for (const screen of screens) {
        if (graph.closure(join(root, screen.file)).has(siteFile)) {
          found.push({ screen, via: at });
          continue;
        }
        const layout = screen.wrappers.find((w) => graph.closure(join(root, w)).has(siteFile));
        if (layout) {
          throughWrappers.push({ screen, via: `${at} (${wrapperKind(layout)} ${layout})`, layout });
          wrapperReach.set(`${at}\u0000${layout}`, (wrapperReach.get(`${at}\u0000${layout}`) ?? 0) + 1);
        }
      }
    }
    for (const [k, n] of wrapperReach) {
      const [at, layout] = k.split("\u0000");
      if (n > 3) notes.push(`${at} is rendered by ${wrapperKind(layout)} ${layout}, on all ${n} pages under it: one path from the page readers start on is usually enough`);
    }
    pagesByWrite.set(key, [...found, ...throughWrappers]);
  }

  const covered = coveredUrls(opts.walkthrough, manifest, opts.captureDir);
  const knownRoutes = [...new Set([...digest.routes.map((r) => r.path), ...screens.map((s) => s.intercepts ?? s.route)])].map((pattern) => ({
    pattern,
    regex: routeToRegex(pattern),
  }));
  const candidates: PathCandidate[] = [];
  const coveredRoutes: CoveredRoute[] = [];
  const listed = new Set<string>();
  for (const [key, pages] of pagesByWrite) {
    for (const { screen, via, layout } of pages) {
      // One screen per route, slot and interception: a modal intercepting `/payments/new` over
      // `/bookings/[id]` is a different screen from the booking page itself.
      const screenKey = `${screen.route}\u0000${screen.intercepts ?? ""}\u0000${screen.slot ?? ""}`;
      if (listed.has(screenKey)) continue;
      listed.add(screenKey);
      // The browser's URL on an intercepted screen is the URL it intercepts, not the page under it:
      // covered only when a capture opened that URL.
      // Covered only when a visited URL opens this exact route: the most specific route matching
      // it, so a visit to `/payments/new` doesn't cover an unvisited `/payments/[id]`.
      const pattern = screen.intercepts ?? screen.route;
      const hit = covered.find((c) => bestRouteFor(c.url, knownRoutes) === pattern);
      if (hit) coveredRoutes.push({ route: screen.route, by: hit.by });
      else
        candidates.push({
          route: screen.route,
          file: screen.file,
          write: key,
          via: screen.intercepts ? `${via} (opens as ${screen.intercepts})` : via,
          ...(layout ? { layout } : {}),
          ...(screen.slot ? { slot: screen.slot } : {}),
          ...(screen.intercepts ? { intercepts: screen.intercepts } : {}),
          ...(editsExistingRecord(screen, via) ? { edits: true as const } : {}),
        });
    }
  }
  // Edit pages call the same save but rarely start the task: listed after every other candidate.
  candidates.sort((a, b) => Number(a.edits ?? false) - Number(b.edits ?? false));
  const limit = opts.limit ?? 20;
  if (candidates.length > limit) notes.push(`${candidates.length - limit} more candidate page(s) not listed (raise --limit)`);
  if (writes.length === 0) notes.push("the main path's capture made no saves, so there's no action to look for other ways to");

  return {
    ok: true,
    walkthrough: opts.walkthrough.walkthrough,
    appRoot: root,
    writes,
    candidates: candidates.slice(0, limit),
    covered: coveredRoutes,
    notes,
  };
}

/** Terse text form for agents. */
export function formatDiscoverPaths(result: DiscoverPathsResult): string {
  const lines: string[] = [`${result.walkthrough}: other ways in (app: ${result.appRoot})`];
  lines.push("saves on the main path:");
  for (const w of result.writes) {
    const where = w.route ? ` -> ${w.route}${w.handler ? ` (${w.handler})` : ""}` : "";
    lines.push(`  ${w.key}${w.step ? ` (step ${w.step})` : ""}${where}`);
    const sites = w.callSites.slice(0, 6).map((s) => `${s.file}:${s.line}`);
    if (sites.length > 0) lines.push(`    called from: ${sites.join(", ")}${w.callSites.length > 6 ? `, +${w.callSites.length - 6} more` : ""}`);
  }
  if (result.writes.length === 0) lines.push("  (none)");
  lines.push(result.candidates.length > 0 ? "candidates (not covered by the walkthrough or its paths):" : "candidates: none");
  for (const c of result.candidates) lines.push(`  ${c.route}  ${c.file}  via ${c.via}  (${c.write})${c.edits ? "  edits an existing record" : ""}`);
  if (result.covered.length > 0) lines.push(`covered: ${result.covered.map((c) => `${c.route} (${c.by})`).join(", ")}`);
  for (const n of result.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}
