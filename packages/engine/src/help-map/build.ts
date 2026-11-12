// Builds public/help-map.json from the published procedures (the same list procedures.json holds),
// so a walkthrough that failed capture or QA can never be offered as help for a screen
// (scope.md "Truthfulness").
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripMarkdown } from "../index-search/index.js";
import type { Procedure } from "../procedures/index.js";
import { matchRoutePattern, normalizePathname, routePatternFor, routeToPattern } from "../routes/pattern.js";
import { displayWalkthrough, resolveDisplayText, type Walkthrough } from "../walkthrough/index.js";
import type { HelpMap, HelpMapGuide } from "./types.js";

export interface BuildHelpMapOptions {
  /** The published procedures (`runIndexStage(...).procedures`). */
  procedures: Procedure[];
  /** The app's own routes in framework form ("/polls/[id]/edit", "/users/:id") or as patterns,
   * relative to `basePath`; the most specific match names each screen. A route with no literal
   * segment ("/[[...slug]]", "/[locale]/[[...slug]]") is ignored: it would claim every screen.
   * Without a matching route, id-like segments and the walkthrough's own demo values become `*`. */
  knownRoutes?: string[];
  /** Ids of guides that have an in-app tour file. */
  tourIds?: string[];
  /** Walkthroughs by any subset, for their `summary` and their demo `data`; ones not listed simply
   * carry neither. */
  walkthroughs?: Walkthrough[];
  /** The path part of the app's base URL ("/app" for `http://localhost:3000/app`). Capture opens
   * `baseUrl + start.page` but records the full pathname of every screen it passes, so the full
   * pathnames are made relative to it and every pattern in the map is relative to the base path
   * (the widget strips the same prefix, `data-base-path`). Screens outside it are left out. */
  basePath?: string;
  /** When set, the map is written to `<publicDir>/help-map.json`. */
  publicDir?: string;
}

export const HELP_MAP_FILE = "help-map.json";

const SUMMARY_MAX = 200;

// Paths a capture can record that aren't a screen a reader stands on: API and RPC endpoints,
// framework internals, and files (a CSV download, an image opened in the tab).
const NOT_A_SCREEN = /^\/(?:api|_next|__\w*|trpc|graphql|rpc)(?:\/|$)/i;
// Only these extensions mark a file. A dot alone doesn't: "/sites/example.com", "/u/jane.doe"
// and "/releases/v1.2" are screens.
const FILE = /\.(?:csv|tsv|xlsx?|xlsm|ods|pdf|docx?|odt|rtf|txt|ics|vcf|json|xml|zip|gz|tgz|tar|7z|rar|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|heic|mp4|webm|mov|mp3|wav|ogg|m4a|js|mjs|css|map|woff2?|ttf|otf|eot|wasm)$/i;

function isScreen(path: string, isStart: boolean): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const pathname = normalizePathname(path);
  if (NOT_A_SCREEN.test(pathname)) return false;
  // The walkthrough's own start page is a screen by definition; only a recorded path can be a
  // file the step opened.
  return isStart || !FILE.test(pathname.split("/").pop() ?? "");
}

/** "/app/" -> "/app"; "", "/" and anything unusable -> undefined (no base path). */
function cleanBasePath(basePath: string | undefined): string | undefined {
  if (!basePath) return undefined;
  const path = normalizePathname(basePath);
  return path === "/" ? undefined : path;
}

/** `path` relative to `base`, or undefined when it lies outside it. */
function underBase(path: string, base: string | undefined): string | undefined {
  if (!base) return path;
  const pathname = normalizePathname(path);
  if (pathname === base) return "/";
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : undefined;
}

/** A pattern with wildcards and no literal segment ("/**", "/*\/**", "/*") matches nearly every
 * screen, so it can't say which screen a guide belongs to. "/" is literal: it matches only "/". */
function tooBroad(pattern: string): boolean {
  const segments = pattern.split("/").filter(Boolean);
  return segments.length > 0 && segments.every((s) => s === "*" || s === "**");
}

function slugOf(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Every printable demo value in a walkthrough's `data`, resolved the way display text is
 * (a value may itself use `{{other.value}}`), lowercased and as a slug. */
function demoValues(wf: Walkthrough | undefined): Set<string> {
  const out = new Set<string>();
  const data = wf?.data;
  if (!data) return out;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = resolveDisplayText(String(value), data).trim();
      // One or two characters ("a", "en") are too likely to be a real screen segment by chance.
      if (text.length < 3) return;
      out.add(text.toLowerCase());
      const slug = slugOf(text);
      if (slug.length >= 3) out.add(slug);
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => visit(v, depth + 1));
  };
  visit(data, 0);
  return out;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The plain path with record ids and demo values as `*`. A demo value only stands for a record
 * right after a literal segment ("/teams/acme/settings": "teams" names the collection, "acme" the
 * record), so a value that happens to equal the screen name after a record stays literal.
 */
function demoPattern(path: string, demo: Set<string>): string {
  const plain = routePatternFor(path).split("/").filter(Boolean);
  if (!demo.size) return `/${plain.join("/")}`;
  const raw = normalizePathname(path).split("/").filter(Boolean);
  const out: string[] = [];
  raw.forEach((segment, i) => {
    const decoded = decodeSegment(segment).toLowerCase();
    const isDemo = demo.has(decoded) || demo.has(slugOf(decoded));
    const afterLiteral = i === 0 || (out[i - 1] !== "*" && out[i - 1] !== "**");
    out.push(plain[i] === "*" || (isDemo && afterLiteral) ? "*" : segment);
  });
  const pattern = `/${out.join("/")}`;
  return tooBroad(pattern) ? `/${plain.join("/")}` : pattern;
}

/** The demo values minus any this guide's own screens use as a screen name: a literal segment
 * right after a record ("settings" in "/teams/acme/settings"). Such a value stays literal
 * everywhere else in the guide too ("/en/settings" is the settings screen, not a record). */
function withoutScreenNames(paths: string[], demo: Set<string>): Set<string> {
  if (!demo.size) return demo;
  const names = new Set<string>();
  for (const path of paths) {
    if (/\[[^\]]+\]|\/:[^/]+/.test(path)) continue;
    const segments = demoPattern(path, demo).split("/").filter(Boolean);
    segments.forEach((segment, i) => {
      if (i > 0 && segments[i - 1] === "*" && segment !== "*" && segment !== "**") {
        const decoded = decodeSegment(segment).toLowerCase();
        names.add(decoded).add(slugOf(decoded));
      }
    });
  }
  return names.size ? new Set([...demo].filter((v) => !names.has(v))) : demo;
}

function screenPattern(path: string, knownRoutes: string[], demo: Set<string>): string {
  // A start page can be written in framework form ("/attendees/[id]").
  if (/\[[^\]]+\]|\/:[^/]+/.test(path)) return routeToPattern(path);
  // A route with no literal segment (an optional catch-all at the root, "/[locale]/[[...slug]]")
  // would put the guide on every screen; the app's more specific routes still apply.
  const routes = knownRoutes.map(routeToPattern).filter((p) => !tooBroad(p));
  if (routes.some((p) => matchRoutePattern(p, path))) return routePatternFor(path, routes);
  return demoPattern(path, demo);
}

/** A site-relative page URL, or undefined for anything that could leave the help site. */
function siteUrl(url: string): string | undefined {
  return url.startsWith("/") && !url.startsWith("//") && !url.includes("\\") ? url : undefined;
}

function summaryOf(wf: Walkthrough | undefined): string | undefined {
  const raw = wf ? displayWalkthrough(wf).summary : undefined;
  if (!raw) return undefined;
  const text = stripMarkdown(raw).replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text;
}

function guideFor(proc: Procedure, opts: BuildHelpMapOptions, tours: Set<string>, walkthroughs: Map<string, Walkthrough>): HelpMapGuide | undefined {
  const url = siteUrl(proc.url ?? `/${proc.id}`);
  if (!url) return undefined;
  const known = opts.knownRoutes ?? [];
  const base = cleanBasePath(opts.basePath);
  // Start pages are already relative to the app's base URL (capture opens `baseUrl + page`);
  // recorded screens are full pathnames.
  const relative = (p: string | undefined, isStart: boolean): string | undefined => {
    if (!p || !isScreen(p, isStart)) return undefined;
    return isStart ? p : underBase(p, base);
  };
  const start = relative(proc.start.page, true);
  const others = [
    ...(proc.impactRoutes ?? []).map((p) => relative(p, false)),
    ...(proc.paths ?? []).map((w) => relative(w.start.page, true)),
  ].filter((p): p is string => p !== undefined);
  const demo = withoutScreenNames(start ? [start, ...others] : others, demoValues(walkthroughs.get(proc.id)));

  const starts = start ? screenPattern(start, known, demo) : undefined;
  const screens = new Set<string>();
  for (const p of others) {
    const pattern = screenPattern(p, known, demo);
    if (pattern !== starts) screens.add(pattern);
  }
  const summary = summaryOf(walkthroughs.get(proc.id));
  return {
    id: proc.id,
    title: proc.title,
    url,
    ...(proc.for ? { for: proc.for } : {}),
    ...(summary ? { summary } : {}),
    steps: proc.steps.length,
    ...(starts ? { starts } : {}),
    screens: [...screens].sort(),
    ...(tours.has(proc.id) ? { tour: true as const } : {}),
  };
}

/**
 * The help map for the published procedures, sorted by title then id. Writes
 * `<publicDir>/help-map.json` when `publicDir` is given. Deterministic: no timestamps, so an
 * unchanged site rewrites the same bytes.
 */
export function buildHelpMap(opts: BuildHelpMapOptions): HelpMap {
  const tours = new Set(opts.tourIds ?? []);
  const walkthroughs = new Map((opts.walkthroughs ?? []).map((w) => [w.walkthrough, w]));
  const seen = new Set<string>();
  const guides: HelpMapGuide[] = [];
  for (const proc of opts.procedures) {
    if (seen.has(proc.id)) continue;
    seen.add(proc.id);
    const guide = guideFor(proc, opts, tours, walkthroughs);
    if (guide) guides.push(guide);
  }
  guides.sort((a, b) => (a.title === b.title ? (a.id < b.id ? -1 : 1) : a.title.localeCompare(b.title, "en")));
  const map: HelpMap = { version: 1, guides };
  if (opts.publicDir) {
    mkdirSync(opts.publicDir, { recursive: true });
    writeFileSync(join(opts.publicDir, HELP_MAP_FILE), `${JSON.stringify(map)}\n`, "utf8");
  }
  return map;
}
