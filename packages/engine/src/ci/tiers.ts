// Change tiers for `aida ci` (docs/scope.md "Three kinds of change"; build-plan.md M19;
// decisions #8, #22, #24). Deterministic, no model: a tier is either read straight off a
// walkthrough's capture status, or (for "new") off a plain git-diff + route-coverage check.
import { execFileSync } from "node:child_process";
import type { DigestRoute } from "../digest/types.js";
import { buildMatchers, findStepHits, type RouteMatcher } from "../impact/index.js";
import type { WalkthroughEntry } from "../impact/walkthroughs.js";
import type { FailureCategory } from "../capture/types.js";
import type { ChangeTier, NewRouteResult, WalkthroughCiStatus } from "./types.js";

/** "failed" -> broken, flagged with the repair command (none for "undetermined": it could be the
 * app's, so a person looks), or "app" when the failure looks like the app misbehaving (decision 30: reported to a person, never repaired around); everything else
 * (capture passed, whether or not the screenshot changed, including a first-time capture with no
 * baseline yet) -> cosmetic, refreshed and published on merge without asking anyone (decisions #8). */
export function tierForStatus(status: WalkthroughCiStatus, category?: FailureCategory): ChangeTier {
  if (status !== "failed") return "cosmetic";
  return category === "app" ? "app" : "broken";
}

/** Exact command to run locally in Claude Code to fix a broken walkthrough (the aida-repair
 * skill), matching what `ci/run.ts`'s `repairCommandFor` already produces — kept here too so
 * `ci/tiers.ts` is the one place that knows the shape of both commands. */
export function repairCommandFor(id: string, configPath: string): string {
  return `claude -p "load the aida-repair skill and fix the '${id}' walkthrough (--config ${configPath}); its failure report is at .build/${id}/ci/capture/failure.json"`;
}

/** Exact command to run locally in Claude Code to draft a new walkthrough for an uncovered route
 * (the aida-write skill), labelled `docs:new` per decisions #24. */
export function draftCommandFor(route: DigestRoute, configPath: string): string {
  return `claude -p "load the aida-write skill and draft a walkthrough for the new page at ${route.path} (--config ${configPath}); label the PR docs:new"`;
}

/** The optional `@claude` comment shortcut (decisions #22: only mentioned when the repo owner has
 * installed the Claude Code GitHub Action via \`aida init --ci --claude\`). */
export function claudeRepairCommentFor(id: string): string {
  return `@claude load the aida-repair skill and fix the "${id}" walkthrough`;
}

export function claudeDraftCommentFor(route: { path: string }): string {
  return `@claude load the aida-write skill and draft a walkthrough for ${route.path}, labelled docs:new`;
}

/** Files added (not just modified) between `base` and `head`, relative to `appRepo`. A separate,
 * small git call rather than extending `impact/git.ts` (owned by M17) — this is the only place in
 * `aida ci` that needs added-vs-modified, not just "changed". */
export function getAddedFiles(appRepo: string, base: string, head = "HEAD"): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["diff", "--name-status", "--diff-filter=A", `${base}...${head}`], {
      cwd: appRepo,
      encoding: "utf8",
    });
  } catch (err) {
    const message = (err as Error & { stderr?: Buffer | string }).stderr?.toString() ?? (err as Error).message;
    throw new Error(`git diff --diff-filter=A failed in ${appRepo}: ${message.trim()}`);
  }
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\t")[1])
    .filter((f): f is string => Boolean(f));
}

export interface FindNewRoutesOptions {
  appRepo: string;
  base: string;
  head?: string;
  /** Page routes at `head` (e.g. `buildDigest(scanRoot).routes`). */
  routes: DigestRoute[];
  /** Walkthroughs with their last capture manifest, if any (e.g. `listWalkthroughs(...)`). */
  walkthroughs: WalkthroughEntry[];
  configPath: string;
}

/**
 * New page routes added in this diff that no walkthrough's manifest visits — the "new" tier
 * (docs/scope.md "Three kinds of change"). A route counts as covered the moment *any*
 * walkthrough's capture manifest recorded a step whose navigated URL matches it, regardless of
 * whether that walkthrough itself was affected by this diff.
 */
export function findNewUncoveredRoutes(opts: FindNewRoutesOptions): NewRouteResult[] {
  const added = new Set(getAddedFiles(opts.appRepo, opts.base, opts.head));
  const addedRoutes = opts.routes.filter((r) => added.has(r.file));
  if (addedRoutes.length === 0) return [];

  const matchers: RouteMatcher[] = buildMatchers(addedRoutes, []);
  const covered = new Set<string>();
  for (const wt of opts.walkthroughs) {
    if (!wt.manifest) continue;
    for (const matcher of matchers) {
      if (findStepHits(wt.manifest, matcher).length > 0) covered.add(matcher.path);
    }
  }

  return addedRoutes
    .filter((r) => !covered.has(r.path))
    .map((r) => ({ path: r.path, file: r.file, draftCommand: draftCommandFor(r, opts.configPath) }));
}
