// `aida order [walkthroughs...]`: prints the capture order the walkthroughs' `needs`/`leaves`/
// `clears` imply (decision 28), why each one is in the run, how each need is met and where the
// database is reset. The planner skill reads this instead of keeping the order in its head.
import { loadConfig } from "../config/index.js";
import { formatPlan, loadRunWalkthroughs, planCaptureRun } from "../states/index.js";
import type { ResetPolicy } from "../states/index.js";
import type { Walkthrough } from "../walkthrough/index.js";

export interface RunOrderOptions {
  configPath: string;
  walkthroughIds: string[];
  withDeps?: boolean;
  /** Plan as `aida ci` does: reset before every walkthrough, always pull in dependencies. */
  ci?: boolean;
  noReset?: boolean;
}

export async function runOrder(opts: RunOrderOptions, json: boolean): Promise<number> {
  const fail = (message: string): number => {
    if (json) console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(`error: ${message}`);
    return 1;
  };

  let config;
  try {
    config = await loadConfig(opts.configPath);
  } catch (err) {
    return fail((err as Error).message.split("\n")[0]);
  }
  const all = loadRunWalkthroughs(config.walkthroughsDir).map((r) => r.walkthrough);
  const selected: Walkthrough[] = [];
  for (const id of opts.walkthroughIds) {
    const w = all.find((x) => x.walkthrough === id);
    if (!w) return fail(`no walkthrough "${id}" in ${config.walkthroughsDir} (or it doesn't load: run aida validate)`);
    selected.push(w);
  }

  // Only a database adapter with `reset` can reset anything: without one there's no reset to place.
  const canReset = typeof config.database?.reset === "function";
  const reset: ResetPolicy = opts.noReset || !canReset ? "none" : opts.ci ? "every" : "database-checks";
  const plan = planCaptureRun(selected.length > 0 ? selected : all, all, config, {
    withDeps: Boolean(opts.withDeps || opts.ci),
    reset,
  });

  if (json) {
    console.log(
      JSON.stringify({
        ok: plan.problems.length === 0,
        reset,
        walkthroughs: plan.walkthroughs.map((p) => ({
          walkthrough: p.id,
          reason: p.reason,
          ...(p.pulledInFor.length > 0 ? { pulledInFor: p.pulledInFor } : {}),
          needs: p.needs,
          leaves: p.walkthrough.leaves ?? [],
          clears: p.walkthrough.clears ?? [],
          resetBefore: p.resetBefore,
          ...(p.resetNote ? { resetNote: p.resetNote } : {}),
        })),
        problems: plan.problems,
      }),
    );
  } else {
    const resets = {
      none: opts.noReset && canReset ? "none (--no-reset)" : config.database ? "none (the database adapter in config has no reset)" : "none (no database adapter with reset in config)",
      every: "before every walkthrough, as aida ci does",
      "database-checks": "before walkthroughs with database checks",
    }[reset];
    console.log(`database reset: ${resets}; never inside a dependency chain`);
    console.log(formatPlan(plan, config.states));
  }
  return plan.problems.length === 0 ? 0 : 1;
}
