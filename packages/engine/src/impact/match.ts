// Matches changed source files against capture manifests, via route/API path patterns
// (build-plan.md M17). A manifest's `ManifestStep.impact` (capture/impact.ts `ImpactTracker`)
// records the same-origin URLs a step navigated to and the API requests it triggered — this
// module turns a Next.js route path (possibly with `[param]`/`[...param]` segments) into a
// matcher for those recorded, *concrete* URLs/paths.
import type { DigestRoute } from "../digest/types.js";
import type { CaptureManifest, ManifestStep } from "../capture/types.js";
import type { ApiRoute } from "./routes.js";

export interface RouteMatcher {
  /** Route path as declared by the framework, e.g. "/dashboard/teams/[id]". */
  path: string;
  /** File path relative to the scanned app root. */
  file: string;
  kind: "page" | "api";
  regex: RegExp;
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

function segmentToRegexPart(segment: string): string {
  if (/^\[\.\.\..+\]$/.test(segment) || /^\[\[\.\.\..+\]\]$/.test(segment)) return ".*"; // catch-all / optional catch-all
  if (/^\[.+\]$/.test(segment)) return "[^/]+"; // dynamic segment
  return segment.replace(REGEX_SPECIAL, "\\$&");
}

/** Converts a framework route path into a regex matching a normalized (query-stripped) URL pathname. */
export function routeToRegex(routePath: string): RegExp {
  const segments = routePath.split("/").filter(Boolean);
  const body = segments.map(segmentToRegexPart).join("/");
  return new RegExp(`^/${body}/?$`);
}

export function buildMatchers(pageRoutes: DigestRoute[], apiRoutes: ApiRoute[]): RouteMatcher[] {
  return [
    ...pageRoutes.map((r) => ({ path: r.path, file: r.file, kind: "page" as const, regex: routeToRegex(r.path) })),
    ...apiRoutes.map((r) => ({ path: r.path, file: r.file, kind: "api" as const, regex: routeToRegex(r.path) })),
  ];
}

/** Strips query string/hash from a recorded URL/path, leaving just the pathname to match against route regexes. */
export function normalizeUrlPath(url: string): string {
  return url.split("?")[0]!.split("#")[0]!;
}

/** Matchers whose `file` is exactly `relFile` (the changed file, relative to the scanned app root). */
export function matchersForFile(relFile: string, matchers: RouteMatcher[]): RouteMatcher[] {
  return matchers.filter((m) => m.file === relFile);
}

export interface StepHit {
  /** 1-based step position, for a stable label when a step has no `id`. */
  stepNumber: number;
  stepId: string | undefined;
  /** How the step's recorded impact matched: the route/API path and, for an API hit, the method. */
  via: string;
}

/** Steps in `manifest` whose recorded impact (urls for a page matcher, requests for an API
 * matcher) hits `matcher`'s route pattern. */
export function findStepHits(manifest: CaptureManifest, matcher: RouteMatcher): StepHit[] {
  const hits: StepHit[] = [];
  manifest.steps.forEach((step: ManifestStep, i: number) => {
    if (matcher.kind === "page") {
      const hitUrl = step.impact?.urls?.find((u) => matcher.regex.test(normalizeUrlPath(u)));
      if (hitUrl) hits.push({ stepNumber: i + 1, stepId: step.id, via: `route ${matcher.path}` });
      return;
    }
    const hitReq = step.impact?.requests?.find((r) => matcher.regex.test(normalizeUrlPath(r.path)));
    if (hitReq) hits.push({ stepNumber: i + 1, stepId: step.id, via: `${hitReq.method} ${matcher.path}` });
  });
  return hits;
}
