// Several ways to do one task (decision 34; docs/scope.md "Walkthrough files"). A walkthrough has
// one main path (`steps`) and may list other `paths`, each with its own start page and opening
// steps, joining the main steps at the step named by `joins`. Every consumer (capture, pages,
// procedures, a future per-path clip) works from the same expansion: `pathWalkthrough`.
import type { Walkthrough, WalkthroughPath } from "./types.js";

/** Index into `wt.steps` of the main step `path` joins. Throws when it names no main step (the
 * loader rejects such a file, so this only fires for a hand-built object). */
export function joinIndex(wt: Pick<Walkthrough, "steps" | "walkthrough">, path: Pick<WalkthroughPath, "id" | "joins">): number {
  const index = wt.steps.findIndex((s) => s.id === path.joins);
  if (index === -1) throw new Error(`path "${path.id}" joins "${path.joins}", which isn't a step of ${wt.walkthrough}`);
  return index;
}

export function findPath(wt: Pick<Walkthrough, "paths">, id: string): WalkthroughPath | undefined {
  return wt.paths?.find((p) => p.id === id);
}

/** The page a path starts on. */
export function pathStartPage(path: Pick<WalkthroughPath, "start">): string {
  return path.start.page;
}

/** One path expanded into something capture can run on its own. */
export interface PathRun {
  path: WalkthroughPath;
  /**
   * The walkthrough as this path runs it: the main start (persona, viewport, baseUrl) with the
   * path's page, then the path's opening steps and the main steps from `joins` on. Keeps the
   * walkthrough's id, data, needs/leaves/clears, setup and database checks, so a path run gets
   * the same setup and the same safety gates as the main run. No `paths`, intro or outro.
   */
  walkthrough: Walkthrough;
  /** How many of `walkthrough.steps` are the path's own opening steps (the rest are shared). */
  openingSteps: number;
  /** Index into the main `steps` of the step the path joins (0-based). */
  joinIndex: number;
}

export function pathWalkthrough(wt: Walkthrough, path: WalkthroughPath): PathRun {
  const join = joinIndex(wt, path);
  // The persona is always the walkthrough's own: validate rejects a path naming another one.
  const start = { ...wt.start, page: path.start.page };
  const { paths: _paths, intro: _intro, outro: _outro, ...rest } = wt;
  return {
    path,
    walkthrough: { ...rest, start, steps: [...path.steps, ...wt.steps.slice(join)] },
    openingSteps: path.steps.length,
    joinIndex: join,
  };
}
