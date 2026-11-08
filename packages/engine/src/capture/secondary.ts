// A walkthrough's secondary devices (decision 40): when one may be captured in a plan slot, and
// when its capture on disk may be used.
//
// Order in one slot, with decision 34's reset bracketing: every secondary device first, each after
// its own reset, then a reset and the primary (its paths, then its main run) — reset → phone →
// reset → primary. The primary's main run, the one dependants and outline drift read, is then the
// last thing to touch the data. Without a reset there (no adapter, `--no-reset`, or a reset would
// erase data an earlier walkthrough in the chain left), a walkthrough that changes data doesn't
// capture its secondary devices at all: the primary would start from the secondary's end state
// and dependants would see its writes twice. A read-only one still captures them, without resets,
// on the run's own run id (it may look up data a provider made with it).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedConfig } from "../config/types.js";
import type { Walkthrough } from "../walkthrough/index.js";
import { preparationWrites } from "../states/prepare.js";
import { notCapturedReason } from "./not-captured.js";
import type { CaptureManifest, ValidationResult } from "./types.js";

/** The actions a capture counts as writes (capture/runner.ts's write guard uses the same set). */
const WRITE_ACTIONS = new Set(["click", "type", "select", "press"]);

/** True when capturing `wf` may change the app's data: a write step, `leaves`/`clears`, its own
 * `setup` steps or a `needs` setup hook. */
export function walkthroughChangesData(
  wf: Pick<Walkthrough, "steps" | "leaves" | "clears" | "setup" | "needs">,
  config: Pick<ResolvedConfig, "states">,
): boolean {
  if ((wf.leaves ?? []).length > 0 || (wf.clears ?? []).length > 0) return true;
  if ((wf.setup?.steps ?? []).length > 0) return true;
  if (preparationWrites(wf as Walkthrough, config)) return true;
  return wf.steps.some((s) => s.actions.some((a) => WRITE_ACTIONS.has(a.do)));
}

/** Where a walkthrough sits in its run, as far as resets go. */
export interface DeviceSlot {
  /** The plan resets before this walkthrough's primary run. */
  resetBefore: boolean;
  /** A reset may happen here even when the plan doesn't ask for one (`PlannedWalkthrough.resetAllowed`). */
  resetAllowed: boolean;
  /** Why no reset is allowed here, for the not-captured reason. */
  cannotResetReason?: string;
}

/** Whether to capture a secondary device in this slot: with `reset`, bracketed by resets (reset
 * before it, and again before the primary) and on its own run id; without, as-is. */
export type SecondaryCapturePlan = { capture: true; reset: boolean } | { capture: false; reason: string };

export function planSecondaryCapture(
  wf: Pick<Walkthrough, "steps" | "leaves" | "clears" | "setup" | "needs">,
  config: Pick<ResolvedConfig, "states" | "database">,
  slot: DeviceSlot,
): SecondaryCapturePlan {
  const adapter = Boolean(config.database?.reset);
  const canReset = adapter && (slot.resetBefore || slot.resetAllowed);
  const writes = walkthroughChangesData(wf, config);
  if (canReset && (writes || slot.resetBefore)) return { capture: true, reset: true };
  if (!writes) return { capture: true, reset: false };
  const why = !adapter
    ? "no database adapter with reset() is configured"
    : (slot.cannotResetReason ?? "the capture plan doesn't allow a reset before this walkthrough");
  return { capture: false, reason: `needs a database reset between devices, and none is allowed here (${why})` };
}

/**
 * A secondary device's capture on disk, when it may be shown: `manifest.json` and
 * `validation.json` exist, the validation passed and doesn't say the device wasn't captured. A
 * failed, blocked or skipped run leaves the older manifest and frames in place, so their presence
 * alone proves nothing. Pages, procedures and render all use this.
 */
export function usableDeviceCapture(captureDir: string): { manifest: CaptureManifest; validation: ValidationResult } | undefined {
  const manifestFile = join(captureDir, "manifest.json");
  const validationFile = join(captureDir, "validation.json");
  if (!existsSync(manifestFile) || !existsSync(validationFile)) return undefined;
  try {
    const validation = JSON.parse(readFileSync(validationFile, "utf8")) as ValidationResult;
    if (validation.ok !== true || notCapturedReason(validation) !== undefined) return undefined;
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as CaptureManifest;
    return { manifest, validation };
  } catch {
    return undefined;
  }
}
