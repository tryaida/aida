// The planned capture loop shared by `aida ci` (ci/run.ts) and `aida ci --publish`
// (ci/publish.ts): one capture order from the walkthroughs' needs/leaves/clears (decision 28),
// so both jobs reset, order, pull in providers and prepare `needs`/`setup` the same way.
// Kept out of ci/capture.ts so tests can still replace `captureWalkthroughForCi` on its own.
import type { ResolvedConfig } from "../config/index.js";
import type { WalkthroughEntry } from "../impact/walkthroughs.js";
import type { Device } from "../walkthrough/index.js";
import { planRunFromFiles, runIdFor } from "../states/index.js";
import { markNotCaptured } from "../capture/not-captured.js";
import { ciCaptureDirFor, devicesFor } from "../devices/index.js";
import { briefPath, loadBrief } from "../brief/consumers.js";
import { captureWalkthroughForCi } from "./capture.js";
import { planSecondaryCapture } from "../capture/secondary.js";
import { newRunId } from "../walkthrough/index.js";
import type { CiCaptureResult } from "./capture.js";

/**
 * One walkthrough's outcome in a planned CI run: captured, or blocked with the reason. A blocked
 * one names the providers whose failure blocked it (`blockedBy`, empty when the plan itself has
 * no order for it) and any possible app bug it inherits from them (`appBugIn`, decision 30).
 * `secondary` (decision 40, M43b): every device after the primary, captured when `allDevices` is
 * given — a failed one is never this walkthrough's own failure (`captured.ok` only ever reflects
 * the primary device and its paths).
 */
export type PlannedCiCapture =
  | { id: string; blocked: string; blockedBy: string[]; appBugIn: string[]; captured?: undefined }
  | {
      id: string;
      blocked?: undefined;
      captured: CiCaptureResult;
      /** Every device this walkthrough is shown on, primary first (`devicesFor()`) — set
       * whenever `allDevices` was given, even when there turned out to be only the primary. */
      devices?: Device[];
      secondary?: { device: Device; result: CiCaptureResult }[];
    };

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
  /** `recordDrift`: outline drift on each card, for the PR check only (see `CiCaptureOptions`).
   * `allDevices` (decision 40, M43b): also capture every secondary device (`devicesFor()`'s
   * result past the primary) for each walkthrough — `aida ci --publish` sets this so phone
   * screenshots stay current; the PR check (`aida ci`) never does, since its screenshot diff
   * compares the primary device alone. */
  opts: { recordDrift?: boolean; allDevices?: boolean } = {},
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
  const brief = loadBrief(briefPath(config));

  for (const item of run.plan.walkthroughs) {
    const id = item.id;
    const entry = entries.find((w) => w.id === id);
    if (!entry) continue;
    const resolved = devicesFor(item.walkthrough, config, brief);

    const blocked = run.tracker.blocked(item);
    if (blocked) {
      run.tracker.record(id, false, { appBugIn: blocked.appBugIn });
      for (const device of opts.allDevices ? resolved : resolved.slice(0, 1)) {
        markNotCaptured(ciCaptureDirFor(config.buildDir, id, device), { walkthrough: id, reason: blocked.reason });
      }
      yield { id, blocked: blocked.reason, blockedBy: blocked.providers, appBugIn: blocked.appBugIn };
      continue;
    }

    // Every other device this walkthrough is shown on (decision 40, M43b), captured *before* the
    // primary and bracketed by resets (capture/secondary.ts): reset → phone → reset → primary, so
    // the primary's main run is the one dependants see. Minus its paths (the primary's alone).
    // Never affects `run.tracker` — a phone capture failing never blocks a dependant or fails
    // this walkthrough's own result.
    let devices: Device[] | undefined;
    let secondary: { device: Device; result: CiCaptureResult }[] | undefined;
    let secondaryReset = false;
    if (opts.allDevices) {
      devices = resolved;
      const rest = devices.slice(1);
      if (rest.length > 0) {
        secondary = [];
        for (const device of rest) {
          const plan = planSecondaryCapture(item.walkthrough, config, {
            resetBefore: item.resetBefore,
            resetAllowed: Boolean(item.resetAllowed),
            cannotResetReason: item.resetNote ?? "it runs inside a dependency chain, where a reset would erase the data an earlier walkthrough left",
          });
          if (!plan.capture) {
            const captureDir = ciCaptureDirFor(config.buildDir, id, device);
            markNotCaptured(captureDir, { walkthrough: id, reason: plan.reason });
            secondary.push({ device, result: { walkthrough: item.walkthrough, captureDir, ok: false, mainOk: false, notCaptured: plan.reason } });
            continue;
          }
          if (plan.reset) secondaryReset = true;
          const result = await captureWalkthroughForCi(entry.file, config, appUrl, {
            resetBefore: plan.reset,
            // Bracketed by resets: its own run id, as paths get; read-only: the run's.
            runId: plan.reset ? newRunId() : run.runId,
            personaFor: run.personaFor,
            device,
            includePaths: false,
          });
          secondary.push({ device, result });
        }
      }
    }

    const captured = await captureWalkthroughForCi(entry.file, config, appUrl, {
      resetBefore: item.resetBefore || secondaryReset,
      runId: run.runId,
      personaFor: run.personaFor,
      ...(opts.allDevices ? { device: resolved[0] } : {}),
      ...(opts.recordDrift ? { recordDrift: true } : {}),
    });
    // Dependants wait on the main run only: a failed path doesn't take their data away.
    run.tracker.record(id, captured.mainOk ?? captured.ok, { category: captured.failure?.category });
    yield { id, captured, ...(devices ? { devices } : {}), ...(secondary ? { secondary } : {}) };
  }
}
