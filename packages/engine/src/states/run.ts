// Helpers shared by the commands that run a capture plan (`capture`, `build`, `ci`, `order`).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadWalkthroughFile, newRunId, personaRole } from "../walkthrough/index.js";
import type { Persona, Walkthrough } from "../walkthrough/index.js";
import { CaptureRunTracker, planCaptureRun } from "./order.js";
import type { CapturePlan, PlanConfig, PlanOptions } from "./order.js";

export interface RunWalkthrough {
  walkthrough: Walkthrough;
  file: string;
}

/**
 * Every walkthrough in `dir`, for pulling in dependencies and finding personas. A file that
 * doesn't load is left out here (it's reported when it's captured or validated, not by
 * someone else's capture); the first file with a given id wins.
 */
export function loadRunWalkthroughs(dir: string): RunWalkthrough[] {
  if (!existsSync(dir)) return [];
  const out: RunWalkthrough[] = [];
  const seen = new Set<string>();
  const files = readdirSync(dir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .sort()
    .map((f) => join(dir, f));
  for (const file of files) {
    try {
      const walkthrough = loadWalkthroughFile(file);
      if (seen.has(walkthrough.walkthrough)) continue;
      seen.add(walkthrough.walkthrough);
      out.push({ walkthrough, file });
    } catch {
      // see above
    }
  }
  return out;
}

/** Finds the persona for a role from the walkthroughs that sign in as it; `{ role }` if none does. */
export function personaLookup(walkthroughs: Walkthrough[]): (role: string) => Persona | undefined {
  return (role) => {
    const match = walkthroughs.find((w) => personaRole(w.start) === role);
    return match?.start?.persona ?? { role };
  };
}

/** The plan as plain lines: order, why each one is there, how each need is met, and resets. */
export function formatPlan(plan: CapturePlan, states?: Record<string, { description?: string }>): string {
  const lines: string[] = [];
  for (const [i, item] of plan.walkthroughs.entries()) {
    const tags: string[] = [];
    if (item.reason === "dependency") {
      tags.push(`pulled in by --with-deps: ${item.pulledInFor.map((p) => `${p.walkthrough} needs ${p.state}`).join(", ")}`);
    }
    if (item.resetBefore) tags.push("reset before");
    if (item.blocked) tags.push("blocked: won't run");
    lines.push(`${i + 1}. ${item.id}${tags.length > 0 ? `  (${tags.join("; ")})` : ""}`);
    for (const need of item.needs) {
      const how =
        need.metBy === "hook"
          ? "config setup hook"
          : need.metBy === "walkthrough"
            ? `left by ${need.providers.join(", ")}`
            : need.metBy === "check"
              ? "already in the data (config check runs first)"
              : "NOT MET";
      const description = states?.[need.state]?.description;
      lines.push(`     needs ${need.state}: ${how}${description ? `  [${description}]` : ""}`);
    }
    if (item.walkthrough.leaves?.length) lines.push(`     leaves ${item.walkthrough.leaves.join(", ")}`);
    if (item.walkthrough.clears?.length) lines.push(`     clears ${item.walkthrough.clears.join(", ")}`);
    if (item.resetNote) lines.push(`     ${item.resetNote}`);
  }
  for (const p of plan.problems) lines.push(`error: ${p.message}`);
  return lines.join("\n");
}

/** Everything a command needs to run a planned capture. */
export interface PlannedRun {
  plan: CapturePlan<Walkthrough>;
  /** The YAML file a walkthrough in the plan was loaded from. */
  fileOf: (id: string) => string;
  personaFor: (role: string) => Persona | undefined;
  /** `{{run.id}}`, shared by every walkthrough in the run. */
  runId: string;
  /** Record each outcome; ask it whether the next walkthrough must be skipped. */
  tracker: CaptureRunTracker;
}

/**
 * `{{run.id}}` for a run: `AIDA_RUN_ID` when set, else a fresh random id, except under
 * `aida ci` / `ci --publish` with a database adapter that can `reset`. CI resets the data
 * before each dependency chain, so a name made with the run id can't collide with an earlier
 * run's and uniqueness isn't needed there; a fixed "ci" keeps any screenshot that shows a run
 * value the same from one CI run to the next, instead of reporting it as changed on every PR.
 */
export function runIdFor(opts: { ci?: boolean; canReset?: boolean } = {}, env: Record<string, string | undefined> = process.env): string {
  if (env.AIDA_RUN_ID) return env.AIDA_RUN_ID;
  if (opts.ci && opts.canReset) return "ci";
  return newRunId();
}

/**
 * Loads `files` (the selected walkthroughs, in order; a file that doesn't load throws, as it
 * always has) plus every other walkthrough in `config.walkthroughsDir`, and plans the run.
 * `runId` defaults to `runIdFor()` (a fresh one unless `AIDA_RUN_ID` is set).
 */
export function planRunFromFiles(
  config: PlanConfig & { walkthroughsDir: string },
  files: string[],
  opts: PlanOptions & { runId?: string },
): PlannedRun {
  const selected = files.map((file) => ({ walkthrough: loadWalkthroughFile(file), file }));
  const others = loadRunWalkthroughs(config.walkthroughsDir).filter(
    (o) => !selected.some((s) => s.walkthrough.walkthrough === o.walkthrough.walkthrough),
  );
  const everything = [...selected, ...others];
  const files_ = new Map(everything.map((e) => [e.walkthrough.walkthrough, e.file]));
  const plan = planCaptureRun(
    selected.map((s) => s.walkthrough),
    everything.map((e) => e.walkthrough),
    config,
    opts,
  );
  return {
    plan,
    fileOf: (id) => files_.get(id)!,
    personaFor: personaLookup(everything.map((e) => e.walkthrough)),
    runId: opts.runId ?? runIdFor(),
    tracker: new CaptureRunTracker(),
  };
}
