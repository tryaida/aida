// Captures one walkthrough for `aida ci` — no video, no voice, no frame-stabilization against
// a previous build (CI compares straight to the baseline screenshot, not to "last run"). Mirrors
// the capture step of commands/capture.ts (db-reset-before-capture, trimmed failure report) but
// kept separate so `aida ci` never pulls in capture's video/voice build stages.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ResolvedConfig } from "../config/index.js";
import { loadWalkthroughFile } from "../walkthrough/index.js";
import type { Persona, Walkthrough } from "../walkthrough/index.js";
import { runCapture, runLevelFailure } from "../capture/index.js";
import { assertLocalDatabase } from "../capture/write-guard.js";
import type { CaptureRunResult } from "../capture/runner.js";
import type { FailureReport } from "../capture/types.js";
import { markNotCaptured } from "../capture/not-captured.js";

function storageStateKey(baseUrl: string, walkthrough: Walkthrough): string {
  const persona = walkthrough.start?.persona ?? null; // normalised at load: always an object
  const hash = createHash("sha256").update(JSON.stringify({ baseUrl, persona })).digest("hex").slice(0, 16);
  return hash;
}

export interface CiCaptureResult {
  walkthrough: Walkthrough;
  captureDir: string;
  ok: boolean;
  failure?: FailureReport;
}

/** Where this walkthrough sits in a planned run (decision 28; states/order.ts). */
export interface CiCaptureOptions {
  /** Default true (CI resets before every walkthrough); false inside a dependency chain. */
  resetBefore?: boolean;
  /** `{{run.id}}`, shared by every walkthrough in the run. */
  runId?: string;
  personaFor?: (role: string) => Persona | undefined;
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
  const storageStatePath = join(config.buildDir, ".aida-session", `storageState-ci-${storageStateKey(baseUrl, walkthrough)}.json`);

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
    if (config.database && (planned.resetBefore ?? true)) {
      const dbUrl = await config.database.url();
      assertLocalDatabase(dbUrl);
      await config.database.reset?.();
    }

    const result: CaptureRunResult = await runCapture({
      walkthrough,
      config: { ...config, app: { ...config.app, baseUrl } },
      outDir: captureDir,
      storageStatePath,
      runId: planned.runId,
      personaFor: planned.personaFor,
    });
    writeFileSync(join(captureDir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);
    writeFileSync(join(captureDir, "run.json"), `${JSON.stringify(result.run, null, 2)}\n`);
    writeFileSync(join(captureDir, "validation.json"), `${JSON.stringify(result.validation, null, 2)}\n`);
    return { walkthrough, captureDir, ok: result.validation.ok, failure: result.failure };
  } catch (err) {
    const failure: FailureReport = runLevelFailure(err);
    // failure.json for this run, and validation.json saying it wasn't captured (no older passing
    // one left behind); shared with the other capture entry points.
    markNotCaptured(captureDir, { walkthrough: walkthrough.walkthrough, reason: failure.error, failure, baseUrl });
    return { walkthrough, captureDir, ok: false, failure };
  }
}
