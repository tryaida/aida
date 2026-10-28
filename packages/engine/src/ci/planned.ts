// The planned capture loop shared by `aida ci` (ci/run.ts) and `aida ci --publish`
// (ci/publish.ts): one capture order from the walkthroughs' needs/leaves/clears (decision 28),
// so both jobs reset, order, pull in providers and prepare `needs`/`setup` the same way.
// Kept out of ci/capture.ts so tests can still replace `captureWalkthroughForCi` on its own.
import { join } from "node:path";
import type { ResolvedConfig } from "../config/index.js";
import type { WalkthroughEntry } from "../impact/walkthroughs.js";
import { planRunFromFiles, runIdFor } from "../states/index.js";
import { markNotCaptured } from "../capture/not-captured.js";
import { captureWalkthroughForCi } from "./capture.js";
import type { CiCaptureResult } from "./capture.js";

/**
 * One walkthrough's outcome in a planned CI run: captured, or blocked with the reason. A blocked
 * one names the providers whose failure blocked it (`blockedBy`, empty when the plan itself has
 * no order for it) and any possible app bug it inherits from them (`appBugIn`, decision 30).
 */
export type PlannedCiCapture =
  | { id: string; blocked: string; blockedBy: string[]; appBugIn: string[]; captured?: undefined }
  | { id: string; blocked?: undefined; captured: CiCaptureResult };

/**
 * Plans `ids` plus every walkthrough that leaves data they need (CI resets the data, so nothing
 * from an earlier run is there), then captures them in order, resetting only at the start of a
 * chain. Yields one outcome per walkthrough in the run, in run order. A walkthrough no order
 * works for (a need nothing provides, a cycle), or whose provider failed earlier in this run, is
 * yielded as `blocked` and never captured; its CI capture dir is marked as not captured, so no
 * older `failure.json` or passing `validation.json` is read for it. Per-walkthrough setup/needs
 * preparation runs inside `runCapture` (capture/runner.ts) from the run id and personas passed
 * here. `{{run.id}}` is fixed ("ci") when the database adapter can reset (see `runIdFor`).
 */
export async function* captureInPlannedOrder(
  config: ResolvedConfig,
  entries: WalkthroughEntry[],
  ids: string[],
  appUrl: string | undefined,
  /** `recordDrift`: outline drift on each card, for the PR check only (see `CiCaptureOptions`). */
  opts: { recordDrift?: boolean } = {},
): AsyncGenerator<PlannedCiCapture> {
  const run = planRunFromFiles(
    config,
    ids.flatMap((id) => entries.filter((w) => w.id === id).map((w) => w.file)),
    {
      withDeps: true,
      reset: config.database ? "every" : "none",
      runId: runIdFor({ ci: true, canReset: Boolean(config.database?.reset) }),
    },
  );

  for (const item of run.plan.walkthroughs) {
    const id = item.id;
    const entry = entries.find((w) => w.id === id);
    if (!entry) continue;

    const blocked = run.tracker.blocked(item);
    if (blocked) {
      run.tracker.record(id, false, { appBugIn: blocked.appBugIn });
      markNotCaptured(join(config.buildDir, id, "ci", "capture"), { walkthrough: id, reason: blocked.reason });
      yield { id, blocked: blocked.reason, blockedBy: blocked.providers, appBugIn: blocked.appBugIn };
      continue;
    }

    const captured = await captureWalkthroughForCi(entry.file, config, appUrl, {
      resetBefore: item.resetBefore,
      runId: run.runId,
      personaFor: run.personaFor,
      ...(opts.recordDrift ? { recordDrift: true } : {}),
    });
    // Dependants wait on the main run only: a failed path doesn't take their data away.
    run.tracker.record(id, captured.mainOk ?? captured.ok, { category: captured.failure?.category });
    yield { id, captured };
  }
}
