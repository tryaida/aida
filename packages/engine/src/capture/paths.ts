// Capturing every way to do one task (decision 34; build-plan.md M33). Each walkthrough `paths`
// entry runs on its own — its start page and opening steps, then the main steps from `joins` on —
// through the same `runCapture` as the main run, so the write guard, the local-database check,
// masking and blur apply to it identically.
//
// Every run starts from the same data: reset → path 1 → reset → path 2 → … → reset → main. The
// main run goes last, so the walkthroughs that depend on it see the data it left (not a path's),
// and each path gets its own `{{run.id}}`. When a reset before this walkthrough isn't allowed (it
// sits inside a dependency chain, `--no-reset`, no database adapter with `reset()`), the paths
// aren't run at all: each is marked not captured with the reason, never captured on the main
// run's leftovers.
//
// After the main run, the data each path changed is compared with the main run's: a path whose
// write requests (method + route pattern, ids ignored; a server action by its id; counted per
// key) differ is flagged in the main `validation.json` as `pathDiffs`, never assumed to be the
// same. A difference doesn't fail the capture: the writer explains it in the path's `note`.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Persona, Walkthrough } from "../walkthrough/index.js";
import { newRunId, pathWalkthrough } from "../walkthrough/index.js";
import type { ResolvedConfig } from "../config/types.js";
import { resolveCaptureSettings } from "../config/types.js";
import { runCapture } from "./runner.js";
import { withFrameStabilization } from "./frame-diff.js";
import { assertLocalDatabase } from "./write-guard.js";
import { runLevelFailure } from "./failure-report.js";
import { markNotCaptured } from "./not-captured.js";
import { comparePathWrites, countFrames, pathCaptureDir, readPathCaptures, writeKeys } from "./path-files.js";
import type { CaptureManifest, FailureReport, FrameDiffSummary, ManifestStep, PathDiff, ValidationResult } from "./types.js";

export interface PathCaptureSummary {
  path: string;
  ok: boolean;
  steps: { total: number; passed: number };
  frames: number;
  durationMs: number;
  failure?: FailureReport;
  frameDiff?: FrameDiffSummary;
  warnings?: string[];
  /** Why this path wasn't run (no reset allowed before it, or the main run didn't happen). */
  skipped?: string;
}

export interface CapturePathsOptions {
  /** The walkthrough as loaded (with `paths`). */
  walkthrough: Walkthrough;
  config: ResolvedConfig;
  /** The main run's capture dir (`.build/<id>/capture`); paths go under `paths/<pathId>/`. */
  captureDir: string;
  storageStatePath?: string;
  personaFor?: (role: string) => Persona | undefined;
  /** True when the plan allows a database reset before this walkthrough (the start of its chain,
   * resets not turned off). Each path is then run after its own reset; the caller resets again
   * before the main run. */
  canReset: boolean;
  /** Why a reset isn't allowed, when `canReset` is false: becomes each path's "not captured" reason. */
  cannotResetReason?: string;
  /** Default true. False (`aida ci`): no frame stabilization against the path's previous run. */
  stabilize?: boolean;
  log?: (...args: unknown[]) => void;
}

export interface CapturePathsResult {
  paths: PathCaptureSummary[];
  /** Each passing path's manifest, by path id (the write comparison and outline drift read them). */
  manifests: Record<string, CaptureManifest>;
}

/** Why paths can't run before this walkthrough's main run, or undefined when they can. */
function cannotRunPaths(opts: Pick<CapturePathsOptions, "config" | "canReset" | "cannotResetReason">): string | undefined {
  if (!opts.config.database?.reset) {
    return "paths need a database reset before each run so they start from the main run's data; configure a database adapter with reset()";
  }
  if (!opts.canReset) {
    return `paths need a database reset before each run, and none is allowed here (${opts.cannotResetReason ?? "inside a dependency chain"})`;
  }
  return undefined;
}

/** Removes `paths/<id>/` dirs for paths the walkthrough no longer has. */
export function prunePathDirs(captureDir: string, walkthrough: Pick<Walkthrough, "paths">): void {
  const root = join(captureDir, "paths");
  if (!existsSync(root)) return;
  const keep = new Set((walkthrough.paths ?? []).map((p) => p.id));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !keep.has(entry.name)) rmSync(join(root, entry.name), { recursive: true, force: true });
  }
  if ((walkthrough.paths ?? []).length === 0) rmSync(root, { recursive: true, force: true });
}

/** The main run didn't pass: every path dir says it wasn't captured this run (never an older
 * passing path capture left looking current). */
export function markPathsNotCaptured(captureDir: string, walkthrough: Walkthrough, reason: string): PathCaptureSummary[] {
  prunePathDirs(captureDir, walkthrough);
  return (walkthrough.paths ?? []).map((path) => {
    markNotCaptured(pathCaptureDir(captureDir, path.id), { walkthrough: walkthrough.walkthrough, reason });
    return { path: path.id, ok: false, steps: { total: 0, passed: 0 }, frames: 0, durationMs: 0, skipped: reason };
  });
}

/** Captures every path of `walkthrough`, each after its own reset, before the main run; see the
 * module comment. The caller resets once more and runs the main steps afterwards. */
export async function capturePaths(opts: CapturePathsOptions): Promise<CapturePathsResult> {
  const { walkthrough, config, captureDir } = opts;
  prunePathDirs(captureDir, walkthrough);
  const blocked = cannotRunPaths(opts);
  if (blocked) {
    for (const path of walkthrough.paths ?? []) opts.log?.(`path ${path.id}: not captured: ${blocked}`);
    return { paths: markPathsNotCaptured(captureDir, walkthrough, blocked), manifests: {} };
  }
  const summaries: PathCaptureSummary[] = [];
  const manifests: Record<string, CaptureManifest> = {};
  const settings = resolveCaptureSettings(config.capture);
  const stabilizeOpts = { threshold: settings.frameDiffThreshold, tolerance: settings.frameDiffTolerance };
  const baseUrl = walkthrough.start?.baseUrl ?? config.app.baseUrl;

  for (const path of walkthrough.paths ?? []) {
    const run = pathWalkthrough(walkthrough, path);
    const outDir = pathCaptureDir(captureDir, path.id);
    mkdirSync(outDir, { recursive: true });
    const started = Date.now();
    opts.log?.(`path ${path.id}: from ${path.start.page}, joining at ${path.joins}`);
    try {
      // The same gate as the main run: never reset without proving the database is local.
      const dbUrl = await config.database!.url();
      assertLocalDatabase(dbUrl);
      await config.database!.reset!();
      const capture = () =>
        runCapture({
          walkthrough: run.walkthrough,
          config,
          outDir,
          storageStatePath: opts.storageStatePath,
          // Its own run id: records its setup creates never collide with the main run's.
          runId: newRunId(),
          personaFor: opts.personaFor,
          log: opts.log,
        });
      const { result, frameDiff } =
        opts.stabilize === false ? { result: await capture(), frameDiff: undefined } : await withFrameStabilization(outDir, stabilizeOpts, capture);
      writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);
      writeFileSync(join(outDir, "run.json"), `${JSON.stringify(result.run, null, 2)}\n`);
      writeFileSync(join(outDir, "validation.json"), `${JSON.stringify(result.validation, null, 2)}\n`);
      const passed = result.validation.steps.filter((s) => s.ok).length;
      summaries.push({
        path: path.id,
        ok: result.validation.ok,
        steps: { total: result.validation.steps.length, passed },
        frames: countFrames(result.manifest),
        durationMs: Date.now() - started,
        ...(result.failure ? { failure: result.failure } : {}),
        ...(frameDiff ? { frameDiff } : {}),
        ...(result.warnings ? { warnings: result.warnings } : {}),
      });
      if (result.validation.ok) manifests[path.id] = result.manifest;
    } catch (err) {
      const failure = runLevelFailure(err);
      markNotCaptured(outDir, { walkthrough: walkthrough.walkthrough, reason: failure.error, failure, baseUrl });
      summaries.push({ path: path.id, ok: false, steps: { total: 0, passed: 0 }, frames: 0, durationMs: Date.now() - started, failure });
    }
  }
  return { paths: summaries, manifests };
}

/** After the main run: each passing path whose writes differ from the main run's. */
export function diffPaths(mainManifest: CaptureManifest, manifests: Record<string, CaptureManifest>): PathDiff[] {
  const main = writeKeys(mainManifest);
  return Object.entries(manifests)
    .map(([id, m]) => comparePathWrites(id, main, writeKeys(m)))
    .filter((d): d is PathDiff => Boolean(d));
}

/** True when no path failed (a path not run because no reset was allowed is reported, not failed). */
export function pathsPassed(paths: PathCaptureSummary[] | undefined): boolean {
  return (paths ?? []).every((p) => p.ok || p.skipped !== undefined);
}

/** Writes `pathDiffs` into the main run's `validation.json` (removed when there are none). */
export function recordPathDiffs(captureDir: string, pathDiffs: PathDiff[]): void {
  const file = join(captureDir, "validation.json");
  if (!existsSync(file)) return;
  const validation = JSON.parse(readFileSync(file, "utf8")) as ValidationResult;
  if (pathDiffs.length > 0) validation.pathDiffs = pathDiffs;
  else delete validation.pathDiffs;
  writeFileSync(file, `${JSON.stringify(validation, null, 2)}\n`);
}

/**
 * What a short clip of one path would need (decision 34: "each other path gets a short clip"; the
 * clip renderer is a follow-up): the path's opening steps as a walkthrough (main start, path
 * page, no intro/outro) and their manifest steps and frames from the path's own capture dir.
 * Only paths whose capture passed.
 */
export interface PathClipSource {
  pathId: string;
  /** `<captureDir>/paths/<pathId>` — the clip's frames are under `frames/` here. */
  captureDir: string;
  walkthrough: Walkthrough;
  manifestSteps: ManifestStep[];
  /** Frame files (relative to `captureDir/frames`) the opening steps show, in order. */
  frames: string[];
}

export function pathClipSources(walkthrough: Walkthrough, captureDir: string): PathClipSource[] {
  const out: PathClipSource[] = [];
  for (const capture of readPathCaptures(captureDir, walkthrough)) {
    if (!capture.manifest || !capture.validation?.ok) continue;
    const path = walkthrough.paths!.find((p) => p.id === capture.pathId)!;
    const run = pathWalkthrough(walkthrough, path);
    const manifestSteps = capture.manifest.steps.slice(0, run.openingSteps);
    const frames: string[] = [];
    for (const step of manifestSteps) {
      for (const e of step.events) {
        if (e.type === "frame" && !frames.includes(e.image)) frames.push(e.image);
        if (e.type === "scrollFrames" || e.type === "typeFrames") for (const img of e.images) if (!frames.includes(img)) frames.push(img);
      }
    }
    out.push({ pathId: path.id, captureDir: capture.dir, walkthrough: { ...run.walkthrough, steps: path.steps }, manifestSteps, frames });
  }
  return out;
}
