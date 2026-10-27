// Which steps `aida inspect --walkthrough <w> --after <ref>` replays (M28, M35). `ref` is a main
// step id, or `<pathId>/<stepId>` for another way in (decision 34) — the same syntax as the edit
// actions' step references (edit/paths.ts `resolveStepRef`), where a main step whose id is
// exactly `ref` wins. A path reference replays the path as capture runs it (`pathWalkthrough`):
// the path's own start page, its opening steps, then the main steps from `joins` on, so
// `<pathId>/<mainStepId>` reaches a shared step the way that path does. Kept free of Playwright
// so it can be tested on its own.
import { pathWalkthrough, type Walkthrough } from "../walkthrough/index.js";

export interface AfterTarget {
  /** The walkthrough to hand to the capture runner: the original, or the path's expansion. */
  walkthrough: Walkthrough;
  /** The step id the runner stops after (a step of `walkthrough.steps`). */
  stopAfterStep: string;
  /** Set when `ref` named a path. */
  path?: string;
}

/** Resolves `--after <ref>` against `wt`, or returns an error message naming what is valid. */
export function resolveAfterTarget(wt: Walkthrough, ref: string): AfterTarget | { error: string } {
  if (wt.steps.some((s) => s.id === ref)) return { walkthrough: wt, stopAfterStep: ref };
  const slash = ref.indexOf("/");
  if (slash === -1) {
    const ids = wt.steps.map((s) => s.id).filter(Boolean);
    const paths = (wt.paths ?? []).map((p) => p.id);
    const hint = paths.length > 0 ? `; a path's step is "<pathId>/<stepId>" (paths: ${paths.join(", ")})` : "";
    return { error: `no step "${ref}" in walkthrough ${wt.walkthrough} (steps: ${ids.join(", ") || "none with an id"})${hint}` };
  }
  const pathId = ref.slice(0, slash);
  const stepId = ref.slice(slash + 1);
  const path = wt.paths?.find((p) => p.id === pathId);
  if (!path) {
    const paths = (wt.paths ?? []).map((p) => p.id);
    return { error: `no path "${pathId}" in walkthrough ${wt.walkthrough} (paths: ${paths.join(", ") || "none"})` };
  }
  let run;
  try {
    run = pathWalkthrough(wt, path);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!run.walkthrough.steps.some((s) => s.id === stepId)) {
    const opening = path.steps.map((s) => s.id).filter(Boolean);
    const listed = `path steps: ${opening.join(", ") || "none with an id"}`;
    if (run.alone) {
      // Runs to its own end (decision 37): no main step is ever part of it.
      const main = wt.steps.some((s) => s.id === stepId);
      const why = main ? `"${stepId}" is a main step; path ${pathId} runs its own steps to its own end, so it never runs it` : `no step "${stepId}" in path ${pathId}`;
      return { error: `${why} (${listed})` };
    }
    const shared = wt.steps.slice(run.joinIndex).map((s) => s.id).filter(Boolean);
    const before = wt.steps.slice(0, run.joinIndex).some((s) => s.id === stepId);
    const why = before
      ? `"${stepId}" is a main step before the path joins at "${path.joins}", so this path never runs it`
      : `no step "${stepId}" in path ${pathId}`;
    return {
      error: `${why} (${listed}; then main steps from ${path.joins}: ${shared.join(", ")})`,
    };
  }
  return { walkthrough: run.walkthrough, stopAfterStep: stepId, path: pathId };
}
