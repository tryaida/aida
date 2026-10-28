// Captures one walkthrough for `aida ci` — no video, no voice, no frame-stabilization against
// a previous build (CI compares straight to the baseline screenshot, not to "last run"). Mirrors
// the capture step of commands/capture.ts (db-reset-before-capture, trimmed failure report) but
// kept separate so `aida ci` never pulls in capture's video/voice build stages.
import { sessionKey } from "../capture/session-key.js";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "../config/index.js";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import type { Persona, Walkthrough } from "../walkthrough/index.js";
import { capturePaths, comparePathRuns, pathsPassed, prunePathDirs, recordPathDiffs, runCapture, runLevelFailure } from "../capture/index.js";
import { assertLocalDatabase } from "../capture/write-guard.js";
import type { CaptureRunResult } from "../capture/runner.js";
import type { FailureReport } from "../capture/types.js";
import { markNotCaptured } from "../capture/not-captured.js";
import { recordCaptureDriftResult, type CaptureDriftRecord } from "../outline/record.js";
import type { DriftEntry } from "../outline/schema.js";

function storageStateKey(baseUrl: string, walkthrough: Walkthrough, config: Pick<ResolvedConfig, "signIn" | "signInHash">): string {
  return sessionKey(baseUrl, walkthrough.start?.persona, config); // persona normalised at load: always an object
}

export interface CiCaptureResult {
  walkthrough: Walkthrough;
  captureDir: string;
  /** The main run and every path passed (a path that fails fails CI's capture of it). */
  ok: boolean;
  /** The main run alone passed: what dependants wait on, as in `aida capture`. Absent from older
   * callers' results (then `ok`). */
  mainOk?: boolean;
  failure?: FailureReport;
  /** Outline drift (M29) recorded on this walkthrough's outline card after a capture whose steps
   * all passed, as `aida capture` does; absent with no outline file, no card, or a failed capture. */
  outline?: { card: string; drift: DriftEntry[] };
  /** "outline: not updated: …" when the outline file couldn't be read or written. */
  outlineNote?: string;
}

/** Where this walkthrough sits in a planned run (decision 28; states/order.ts). */
export interface CiCaptureOptions {
  /** Default true (CI resets before every walkthrough); false inside a dependency chain. */
  resetBefore?: boolean;
  /** `{{run.id}}`, shared by every walkthrough in the run. */
  runId?: string;
  personaFor?: (role: string) => Persona | undefined;
  /** Record outline drift on the walkthrough's card (M29). On for the PR check (`aida ci`), off
   * for `aida ci --publish`: its bot commits to main, and an outline edit there isn't a person's. */
  recordDrift?: boolean;
}

/** Loads `file`, runs capture into `<buildDir>/<id>/ci/capture`, and returns the outcome without
 * throwing — a failed capture is a normal `aida ci` result (status "failed"), not a crash. */
export async function captureWalkthroughForCi(
  file: string,
  config: ResolvedConfig,
  appUrl: string | undefined,
  planned: CiCaptureOptions = {},
): Promise<CiCaptureResult> {
  const walkthrough = loadWalkthroughFile(file);
  const captureDir = join(config.buildDir, walkthrough.walkthrough, "ci", "capture");
  mkdirSync(captureDir, { recursive: true });

  const baseUrl = appUrl ?? walkthrough.start?.baseUrl ?? config.app.baseUrl;
  const storageStatePath = join(config.buildDir, ".aida-session", `storageState-ci-${storageStateKey(baseUrl, walkthrough, config)}.json`);

  try {
    // Unlike commands/capture.ts (local dev, where reset() can be an expensive full training-dump
    // rebuild and is worth skipping for walkthroughs that don't assert against the database),
    // `aida ci` resets before every walkthrough whenever a database adapter is configured — CI's
    // reset is expected to be a cheap, data-only reseed, and walkthroughs in the same run share
    // one database: without resetting between them, an earlier write-walkthrough's leftover rows
    // bleed into a later read-only walkthrough's screenshot (e.g. a filter/count page), which
    // shows up as a false "changed" on code that never touched it (orchestrator review of M18's
    // pilot, 2026-10-25). Except inside a dependency chain, where the reset would erase
    // the data an earlier walkthrough left for this one (decision 28).
    const ciConfig = { ...config, app: { ...config.app, baseUrl } };
    const resetAllowed = planned.resetBefore ?? true;
    // Other ways in first (decision 34; capture/paths.ts): reset → path → … → reset → main, so
    // CI's pages show them verified and dependants see the main run's data.
    let pathRun: Awaited<ReturnType<typeof capturePaths>> | undefined;
    if ((walkthrough.paths ?? []).length === 0) prunePathDirs(captureDir, walkthrough);
    else {
      pathRun = await capturePaths({
        walkthrough,
        config: ciConfig,
        captureDir,
        storageStatePath,
        personaFor: planned.personaFor,
        canReset: resetAllowed,
        cannotResetReason: "it runs inside a dependency chain, where a reset would erase the data an earlier walkthrough left",
        stabilize: false,
      });
    }

    if (config.database && resetAllowed) {
      const dbUrl = await config.database.url();
      assertLocalDatabase(dbUrl);
      await config.database.reset?.();
    }

    const result: CaptureRunResult = await runCapture({
      walkthrough,
      config: ciConfig,
      outDir: captureDir,
      storageStatePath,
      runId: planned.runId,
      personaFor: planned.personaFor,
    });
    writeFileSync(join(captureDir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);
    writeFileSync(join(captureDir, "run.json"), `${JSON.stringify(result.run, null, 2)}\n`);
    writeFileSync(join(captureDir, "validation.json"), `${JSON.stringify(result.validation, null, 2)}\n`);
    let pathFailure: FailureReport | undefined;
    if (pathRun) {
      const compared = comparePathRuns(result, pathRun);
      recordPathDiffs(captureDir, compared.pathDiffs, compared.pathChecks);
      const failed = pathRun.paths.find((p) => !p.ok && p.skipped === undefined);
      if (failed?.failure) pathFailure = { ...failed.failure, step: `path ${failed.path}: ${failed.failure.step ?? "?"}` };
    }
    // Outline drift (M29), as `aida capture` records it, in the PR check only: quiet without an
    // outline file, never fails the capture. A label may be on any passing path's screens too
    // (decision 34).
    const drift: CaptureDriftRecord = planned.recordDrift
      ? recordCaptureDriftResult({
          config,
          walkthrough,
          manifest: result.manifest,
          validation: result.validation,
          pathManifests: Object.values(pathRun?.manifests ?? {}),
        })
      : { line: null };
    const outline = drift.card ? { outline: { card: drift.card.id, drift: drift.card.drift } } : drift.line ? { outlineNote: drift.line } : {};
    const mainOk = result.validation.ok;
    return { walkthrough, captureDir, ok: mainOk && pathsPassed(pathRun?.paths), mainOk, failure: result.failure ?? pathFailure, ...outline };
  } catch (err) {
    const failure: FailureReport = runLevelFailure(err);
    // failure.json for this run, and validation.json saying it wasn't captured (no older passing
    // one left behind); shared with the other capture entry points.
    markNotCaptured(captureDir, { walkthrough: walkthrough.walkthrough, reason: failure.error, failure, baseUrl });
    return { walkthrough, captureDir, ok: false, mainOk: false, failure };
  }
}
