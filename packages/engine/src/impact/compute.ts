// `aida affected`'s core: maps a git diff to the walkthroughs it touches (build-plan.md M17;
// docs/scope.md "Only rebuild what changed" -> "Impact map"). M18 (GitHub Action/PR check) and
// M19 (change tiers) call `computeAffected` directly, so its shape stays stable — see types.ts.
//
// Route matching is by static import-graph reachability (import-graph.ts), not file equality: a
// changed file maps to every route whose page/layout/API entry transitively imports it. A file
// reachable from more than `allThreshold` of all routes (default 60%) is treated as affecting
// every walkthrough rather than trusted as per-route precision — see glob.ts's module doc for why
// a blanket `lib/`/`utils/`/`shared/`/`auth/` rule (an earlier version of this file) made almost
// every real commit say "all".
import { resolve } from "node:path";
import type { ResolvedConfig } from "../config/types.js";
import { buildDigest } from "../digest/index.js";
import { entryFilesForApiRoute, entryFilesForPageRoute } from "./entries.js";
import { getChangedFiles } from "./git.js";
import { ImportGraph } from "./import-graph.js";
import { DEFAULT_ALL_GLOBS, DEFAULT_IGNORE_GLOBS, matchesAnyGlob } from "./glob.js";
import { buildMatchers, findStepHits, type RouteMatcher } from "./match.js";
import { listApiRoutes } from "./routes.js";
import type { AffectedResult, WalkthroughAffected } from "./types.js";
import { listWalkthroughs } from "./walkthroughs.js";

export interface ComputeAffectedOptions {
  /** App repo the diff is taken against (its git history, not aida's own). */
  appRepo: string;
  /** Git ref (branch, tag, or commit) to diff `head` against. */
  base: string;
  /** Git ref to diff `base` against. Default `"HEAD"`. Set this (with `base: "<commit>^"`) to
   * evaluate one historic commit in isolation rather than everything through the current checkout. */
  head?: string;
  /** Loaded aida config — supplies `walkthroughsDir`, `buildDir`, `signIn`, and `impact.*` overrides. */
  config: ResolvedConfig;
  /** Explicit app directory within a workspace monorepo; falls back to `config.impact?.app`. */
  app?: string;
  /** Also considers uncommitted working-tree changes, for a local "what would this affect" check. */
  includeWorkingTree?: boolean;
}

const DEFAULT_ALL_THRESHOLD = 0.6;

function addReason(map: Map<string, string[]>, id: string, reason: string): void {
  const list = map.get(id);
  if (list) {
    if (!list.includes(reason)) list.push(reason);
  } else {
    map.set(id, [reason]);
  }
}

interface RouteWithClosure {
  matcher: RouteMatcher;
  closure: Set<string>;
}

/** `path === "/login"` or a sub-path of it — the sign-in screen, which every walkthrough visits
 * via the configured `signIn` adapter without that visit ever reaching a manifest (the adapter
 * runs before `ImpactTracker` is attached to the per-step capture loop — see capture/runner.ts). */
function isLoginRoute(path: string): boolean {
  return path === "/login" || path.startsWith("/login/");
}

export async function computeAffected(opts: ComputeAffectedOptions): Promise<AffectedResult> {
  const head = opts.head ?? "HEAD";
  const impactConfig = opts.config.impact;
  const ignoreGlobs = [...DEFAULT_IGNORE_GLOBS, ...(impactConfig?.ignore ?? [])];
  const allGlobs = [...DEFAULT_ALL_GLOBS, ...(impactConfig?.all ?? [])];
  const allThreshold = impactConfig?.allThreshold ?? DEFAULT_ALL_THRESHOLD;

  const changedFiles = getChangedFiles(opts.appRepo, opts.base, head, { includeWorkingTree: opts.includeWorkingTree });
  const walkthroughs = listWalkthroughs(opts.config.walkthroughsDir, opts.config.buildDir);

  const reasons = new Map<string, string[]>();

  // Rule: a changed walkthrough YAML file is affected outright, regardless of route mapping.
  const walkthroughFileAbsSet = new Set(walkthroughs.map((wt) => resolve(wt.file)));
  for (const file of changedFiles) {
    const abs = resolve(opts.appRepo, file);
    for (const wt of walkthroughs) {
      if (resolve(wt.file) === abs) addReason(reasons, wt.id, `walkthrough file changed: ${file}`);
    }
  }

  // Walkthroughs with no capture/impact data yet can't be ruled out — always affected.
  for (const wt of walkthroughs) {
    if (!wt.manifest) addReason(reasons, wt.id, "no capture manifest — always affected");
  }

  let all = false;
  let globalReason: string | undefined;

  const app = opts.app ?? impactConfig?.app;
  const digest = buildDigest(opts.appRepo, { app });

  if (digest.apps && digest.apps.length > 0) {
    // Ambiguous monorepo (several Next.js apps, no --app given): can't resolve routes at all.
    all = true;
    globalReason = digest.message ?? "ambiguous monorepo — pass --app to pick one; treating every walkthrough as affected";
  } else {
    const scanRoot = digest.appRepo;
    const apiRoutes = listApiRoutes(scanRoot);
    const matchers = buildMatchers(digest.routes, apiRoutes);
    const graph = new ImportGraph(scanRoot);

    const routeClosures: RouteWithClosure[] = [
      ...digest.routes.map((route, i) => {
        const closure = new Set<string>();
        for (const entry of entryFilesForPageRoute(scanRoot, route)) for (const f of graph.closure(entry)) closure.add(f);
        return { matcher: matchers[i]!, closure };
      }),
      ...apiRoutes.map((route, i) => {
        const closure = new Set<string>();
        for (const entry of entryFilesForApiRoute(scanRoot, route)) for (const f of graph.closure(entry)) closure.add(f);
        return { matcher: matchers[digest.routes.length + i]!, closure };
      }),
    ];
    const totalRoutes = routeClosures.length;

    outer: for (const file of changedFiles) {
      if (walkthroughFileAbsSet.has(resolve(opts.appRepo, file))) continue; // already handled above
      if (matchesAnyGlob(file, ignoreGlobs)) continue;

      const allMatch = matchesAnyGlob(file, allGlobs);
      if (allMatch) {
        all = true;
        globalReason = `${file} matches an always-affects-all pattern (${allMatch})`;
        break outer;
      }

      const absFile = resolve(opts.appRepo, file);
      const matched = totalRoutes > 0 ? routeClosures.filter((rc) => rc.closure.has(absFile)) : [];

      if (matched.length === 0) {
        all = true;
        globalReason = `${file} isn't reachable from any route or API entry — treating as affecting every walkthrough`;
        break outer;
      }

      const ratio = matched.length / totalRoutes;
      if (ratio > allThreshold) {
        all = true;
        globalReason = `${file} is imported by ${matched.length}/${totalRoutes} routes (~${Math.round(ratio * 100)}%, over the ${Math.round(allThreshold * 100)}% threshold) — treating as affecting every walkthrough`;
        break outer;
      }

      for (const rc of matched) {
        if (isLoginRoute(rc.matcher.path) && opts.config.signIn) {
          for (const wt of walkthroughs) {
            if (!wt.manifest) continue;
            addReason(
              reasons,
              wt.id,
              `${file} -> ${rc.matcher.path} (sign-in page) -> every walkthrough signs in via the configured adapter, which never shows up in a manifest`,
            );
          }
          continue;
        }
        for (const wt of walkthroughs) {
          if (!wt.manifest) continue; // already marked affected above, for a clearer reason
          for (const hit of findStepHits(wt.manifest, rc.matcher)) {
            const stepLabel = hit.stepId ? `step "${hit.stepId}"` : `step ${hit.stepNumber}`;
            addReason(reasons, wt.id, `${file} -> ${rc.matcher.path} -> ${stepLabel} (${hit.via})`);
          }
        }
      }
    }
  }

  if (all) {
    const walkthroughResults: WalkthroughAffected[] = walkthroughs.map((wt) => ({
      id: wt.id,
      affected: true,
      reasons: reasons.get(wt.id)?.length ? reasons.get(wt.id)! : [globalReason ?? "all walkthroughs affected"],
    }));
    return { base: opts.base, head, changedFiles, all: true, reason: globalReason, walkthroughs: walkthroughResults };
  }

  const walkthroughResults: WalkthroughAffected[] = walkthroughs.map((wt) => {
    const wtReasons = reasons.get(wt.id) ?? [];
    return { id: wt.id, affected: wtReasons.length > 0, reasons: wtReasons };
  });

  return { base: opts.base, head, changedFiles, all: false, walkthroughs: walkthroughResults };
}
