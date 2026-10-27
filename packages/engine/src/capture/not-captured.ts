// A walkthrough that wasn't captured this run (blocked by the plan, skipped because a provider
// failed, or its capture threw) must not leave a capture dir that looks good: an older
// `validation.json` with `ok: true` would let `aida build --skip-capture` or `--only pages`
// rebuild from a stale or half-written capture. Every entry point (`aida capture`, `build`,
// `ci`, `ci --publish`) calls `markNotCaptured` on those paths, so the dir always says what
// happened in the last run.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureReport, ValidationResult } from "./types.js";

/** `validation.json` for a capture that didn't happen: `ok: false`, no steps, and why. */
export type NotCapturedValidation = ValidationResult & { notCaptured: string };

/**
 * Writes `validation.json` with `ok: false` and the reason. With `failure` (the capture threw),
 * writes it as this run's `failure.json`; without (blocked or skipped), removes any older
 * `failure.json`, so nothing reads an earlier run's failure as this one's. `manifest.json` and
 * `frames/` are left as the last capture that finished (see `withFrameStabilization`).
 */
export function markNotCaptured(
  captureDir: string,
  opts: { walkthrough: string; reason: string; failure?: FailureReport; baseUrl?: string },
): void {
  mkdirSync(captureDir, { recursive: true });
  const validation: NotCapturedValidation = {
    workflow: opts.walkthrough,
    ranAt: new Date().toISOString(),
    baseUrl: opts.baseUrl ?? "",
    ok: false,
    steps: [],
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
    notCaptured: opts.reason,
  };
  writeFileSync(join(captureDir, "validation.json"), `${JSON.stringify(validation, null, 2)}\n`);
  const failureFile = join(captureDir, "failure.json");
  if (opts.failure) writeFileSync(failureFile, `${JSON.stringify(opts.failure, null, 2)}\n`);
  else rmSync(failureFile, { force: true });
}

/** The reason a capture dir's `validation.json` says it wasn't captured, if it does. */
export function notCapturedReason(validation: ValidationResult | undefined): string | undefined {
  const reason = (validation as Partial<NotCapturedValidation> | undefined)?.notCaptured;
  return typeof reason === "string" ? reason : undefined;
}
