import { sessionKey } from "../capture/session-key.js";
import type { ResolvedConfig } from "../config/types.js";
import { join } from "node:path";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import type { Device, Walkthrough } from "../walkthrough/index.js";
import {
  capturePaths,
  countFrames,
  comparePathRuns,
  pathsPassed,
  formatFailureLines,
  markPathsNotCaptured,
  prunePathDirs,
  recordPathDiffs,
  runCapture,
  runLevelFailure,
  withFrameStabilization,
  type PathCaptureSummary,
} from "../capture/index.js";
import { captureSafetyRefusal } from "../safety/index.js";
import { appBugBlockReason, planRunFromFiles } from "../states/index.js";
import type { PlannedRun, PlannedWalkthrough } from "../states/index.js";
import { markNotCaptured } from "../capture/not-captured.js";
import type { CaptureManifest, CaptureSummary, FailureReport, PathDiff } from "../capture/types.js";
import { resolveCaptureSettings } from "../config/types.js";
import { resetDatabase } from "../capture/reset.js";
import { recordCaptureDrift } from "../outline/index.js";
import { captureDirFor, devicesFor } from "../devices/index.js";
import { planSecondaryCapture } from "../capture/secondary.js";
import { newRunId } from "../walkthrough/index.js";
import { briefPath, loadBrief } from "../brief/consumers.js";

export interface RunCaptureOptions {
  configPath: string;
  walkthroughIds: string[];
  json: boolean;
  noReset?: boolean;
  /** Pull in walkthroughs that leave the states the selected ones need (decision 28). */
  withDeps?: boolean;
  /**
   * Capture only this device (decision 40, M43a). Default: every device the walkthrough itself
   * resolves to (`devicesFor()` — its own `devices`, else config's, else the brief's readers).
   */
  device?: Device;
}

/** Resolves which walkthrough YAML files to capture: named ids/slugs, or every file in the dir. */
function findWalkthroughs(dir: string, ids: string[]): string[] {
  const all = readdirSync(dir)
    .filter((f) => /\.(ya?ml)$/i.test(f))
    .map((f) => join(dir, f))
    .sort();
  if (ids.length === 0) return all;
  return ids.map((id) => {
    if (existsSync(id)) return id;
    const match = all.find((f) => f.endsWith(`/${id}.yaml`) || f.endsWith(`/${id}.yml`));
    if (!match) throw new Error(`no walkthrough found for "${id}" in ${dir}`);
    return match;
  });
}

/**
 * Keys the reused sign-in session file by baseUrl + persona, so two
 * walkthroughs that sign in as different hosts/people never share (or
 * clobber) one another's storage state.
 */
function storageStateKey(baseUrl: string, walkthrough: Walkthrough, config: Pick<ResolvedConfig, "signIn" | "signInHash">): string {
  return sessionKey(baseUrl, walkthrough.start?.persona, config); // persona normalised at load: always an object
}

/** Runs `aida capture`, writing `.build/<id>/capture/{manifest,run,validation}.json` per walkthrough. */
export async function runCaptureCommand(opts: RunCaptureOptions): Promise<number> {
  const config = await loadConfig(opts.configPath);
  const files = findWalkthroughs(config.walkthroughsDir, opts.walkthroughIds);

  // Run-level safety gate (decisions #27): once per command, before any browser opens. A refusal
  // stops the whole run; it isn't one walkthrough's failure.
  const refusal = await captureSafetyRefusal(config);
  if (refusal) {
    if (opts.json) console.log(JSON.stringify({ ok: false, error: refusal.error, database: refusal.database, walkthroughs: [] }));
    else console.error(refusal.error);
    return 1;
  }

  // Capture order from the walkthroughs' needs/leaves/clears (decision 28): providers first, a
  // reset only at the start of a dependency chain, dependants skipped when a provider fails. A
  // walkthrough no order works for (a need nothing provides, a cycle) is reported as blocked and
  // the rest still run; the command exits non-zero at the end, as `aida ci` does.
  const run = planRunFromFiles(config, files, {
    withDeps: opts.withDeps,
    reset: opts.noReset ? "none" : "database-checks",
  });
  const problems = run.plan.problems.map((p) => p.message);
  if (problems.length > 0 && !opts.json) for (const p of problems) console.error(`error: ${p}`);

  const summaries: CaptureSummary[] = [];
  let ok = problems.length === 0;
  // Which devices each walkthrough captures (decision 40): `--device` pins it to one; otherwise
  // the walkthrough's own resolution (its `devices`, else config's, else the brief's readers).
  // The primary is always the walkthrough's own first device, `--device` or not.
  const brief = loadBrief(briefPath(config));

  for (const item of run.plan.walkthroughs) {
    const walkthrough: Walkthrough = item.walkthrough;
    const resolved = devicesFor(walkthrough, config, brief);
    const primary = resolved[0];
    const devices = opts.device ? [opts.device] : resolved;
    const showDevice = devices.length > 1 || devices[0] !== "desktop";
    // Secondary devices first, each bracketed by resets, then the primary (capture/secondary.ts):
    // reset → phone → reset → primary, so the primary's main run is the one dependants see.
    const order = [...devices.filter((d) => d !== primary), ...devices.filter((d) => d === primary)];
    let secondaryReset = false;
    const itemSummaries: CaptureSummary[] = [];
    for (const device of order) {
      const outDir = captureDirFor(config.buildDir, walkthrough.walkthrough, device);
      const isPrimary = device === primary;
      let summary: CaptureSummary;
      if (isPrimary) {
        summary = await captureOneDevice(walkthrough, device, outDir, config, run, item, opts, true, {
          reset: Boolean(item.resetBefore) || secondaryReset,
          runId: run.runId,
        });
      } else {
        const plan = run.tracker.blocked(item)
          ? undefined
          : planSecondaryCapture(walkthrough, config, {
              resetBefore: Boolean(item.resetBefore),
              resetAllowed: !opts.noReset && Boolean(item.resetAllowed),
              cannotResetReason: opts.noReset ? "--no-reset was given" : item.resetNote,
            });
        if (plan && !plan.capture) {
          markNotCaptured(outDir, { walkthrough: item.id, reason: plan.reason });
          summary = { walkthrough: item.id, ok: false, steps: { total: 0, passed: 0 }, frames: 0, durationMs: 0, skipped: plan.reason };
        } else {
          // Bracketed by resets: its own run id, as paths get; read-only: the run's, to find
          // what providers made with it.
          if (plan?.reset) secondaryReset = true;
          summary = await captureOneDevice(walkthrough, device, outDir, config, run, item, opts, false, {
            reset: Boolean(plan?.reset),
            runId: plan?.reset ? newRunId() : run.runId,
          });
        }
        summary.secondary = true;
      }
      if (showDevice) summary.device = device;
      itemSummaries.push(summary);
      // Only the primary decides the exit code; a secondary failure is a warning (as `aida build`).
      if (isPrimary && !summary.ok) ok = false;
    }
    // Reported primary first, as before.
    summaries.push(...itemSummaries.filter((s) => !s.secondary), ...itemSummaries.filter((s) => s.secondary));
  }

  printSummaries(summaries, opts.json, problems);
  return ok ? 0 : 1;
}

/**
 * Captures one walkthrough on one device (decision 40, M43a) — the primary device (`includePaths`
 * true) runs its other ways in (decision 34) first, exactly as every device capture always has;
 * a secondary device replays the same main steps on its own, into its own `outDir`. `main` says
 * whether to reset right before the main run and which run id it uses (the caller decides both).
 */
async function captureOneDevice(
  walkthrough: Walkthrough,
  device: Device,
  outDir: string,
  config: ResolvedConfig,
  run: PlannedRun,
  item: PlannedWalkthrough<Walkthrough>,
  opts: RunCaptureOptions,
  includePaths: boolean,
  main: { reset: boolean; runId: string },
): Promise<CaptureSummary> {
  const dependency = item.reason === "dependency" ? { dependency: true } : {};
  const blocked = run.tracker.blocked(item);
  if (blocked) {
    if (includePaths) run.tracker.record(item.id, false, { appBugIn: blocked.appBugIn });
    // Never leave an older passing capture looking current (build --skip-capture refuses it).
    markNotCaptured(outDir, { walkthrough: item.id, reason: blocked.reason });
    if (includePaths) markPathsNotCaptured(outDir, walkthrough, blocked.reason);
    const skipped = blocked.appBugIn.length > 0 ? `${blocked.reason} (${appBugBlockReason(blocked.appBugIn)})` : blocked.reason;
    return { walkthrough: item.id, ok: false, steps: { total: 0, passed: 0 }, frames: 0, durationMs: 0, skipped, ...dependency };
  }
  mkdirSync(outDir, { recursive: true });

  const baseUrl = walkthrough.start?.baseUrl ?? config.app.baseUrl;
  const storageStatePath = join(config.buildDir, ".aida-session", `storageState-${storageStateKey(baseUrl, walkthrough, config)}.json`);

  const started = Date.now();
  const log = opts.json ? undefined : (...a: unknown[]) => console.error(`[capture:${device}]`, ...a);
  try {
    // Other ways in first (decision 34; capture/paths.ts): reset → path → … → reset → main, so
    // every run starts from the same data and dependants see the main run's. Without an
    // allowed reset each path is marked not captured instead. Paths run once, for the primary
    // device only — every device replays the same main steps.
    let pathRun: Awaited<ReturnType<typeof capturePaths>> | undefined;
    if (includePaths && (walkthrough.paths ?? []).length > 0) {
      pathRun = await capturePaths({
        walkthrough,
        config,
        captureDir: outDir,
        storageStatePath,
        personaFor: run.personaFor,
        canReset: !opts.noReset && Boolean(item.resetBefore),
        cannotResetReason: opts.noReset ? "--no-reset was given" : (item.resetNote ?? "the capture plan doesn't reset before this walkthrough"),
        log,
        device,
      });
    } else if (includePaths) {
      prunePathDirs(outDir, walkthrough);
    }

    // Only reset the database for walkthroughs that actually assert
    // against it (or have paths) — and never without first proving the URL is local.
    // `reset()` is destructive; it must not run against an unverified or
    // needlessly touched database. Inside the same try/catch as the
    // capture itself, so a refusal here is reported like any other
    // per-walkthrough failure instead of crashing the whole command.
    // The plan moves a chain member's reset to the start of its chain; a secondary device run
    // before the primary adds one between them (decision 40).
    if (main.reset && config.database) {
      await resetDatabase(config);
    }

    const captureSettings = resolveCaptureSettings(config.capture);
    const stabilizeOpts = { threshold: captureSettings.frameDiffThreshold, tolerance: captureSettings.frameDiffTolerance };
    const { result, frameDiff } = await withFrameStabilization(outDir, stabilizeOpts, () =>
      runCapture({
        walkthrough,
        config,
        outDir,
        storageStatePath,
        runId: main.runId,
        personaFor: run.personaFor,
        log,
        device,
      }),
    );
    writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);
    writeFileSync(join(outDir, "run.json"), `${JSON.stringify(result.run, null, 2)}\n`);
    writeFileSync(join(outDir, "validation.json"), `${JSON.stringify(result.validation, null, 2)}\n`);
    // Dependants wait on the main run only (it ran last, so the data they see is its own): a
    // path that fails doesn't take their data away. Only the primary device's run is "the main
    // run" other walkthroughs/outline drift depend on.
    if (includePaths) run.tracker.record(item.id, result.validation.ok, { category: result.failure?.category });

    const paths: PathCaptureSummary[] | undefined = pathRun?.paths;
    const compared = pathRun ? comparePathRuns(result, pathRun) : { pathDiffs: [], pathChecks: [] };
    const pathDiffs: PathDiff[] = compared.pathDiffs;
    const pathManifests: CaptureManifest[] = Object.values(pathRun?.manifests ?? {});
    if (pathRun) recordPathDiffs(outDir, pathDiffs, compared.pathChecks);

    // Outline drift (M29): quiet without an outline file; never fails the capture. Recorded from
    // the primary device only — the card tracks one screen, not one per device.
    if (includePaths) {
      const outlineLine = recordCaptureDrift({ config, walkthrough, manifest: result.manifest, validation: result.validation, pathManifests });
      if (outlineLine) console.error(outlineLine);
    }

    const passed = result.validation.steps.filter((s) => s.ok).length;
    const frames = countFrames(result.manifest);
    return {
      walkthrough: walkthrough.walkthrough,
      // Every path is captured (decision 34): one that fails fails the walkthrough's capture.
      // One not run (no reset allowed) is reported; its page won't publish until it is.
      ok: result.validation.ok && pathsPassed(paths),
      steps: { total: result.validation.steps.length, passed },
      frames,
      durationMs: Date.now() - started,
      failure: result.failure,
      frameDiff,
      ...dependency,
      ...(result.warnings ? { warnings: result.warnings } : {}),
      ...(paths ? { paths } : {}),
      ...(pathDiffs.length > 0 ? { pathDiffs } : {}),
    };
  } catch (err) {
    // First line only, never the full Playwright call log (which can run to dozens of lines
    // and leak page state into CI output); classified like a step failure (M28).
    const failure: FailureReport = runLevelFailure(err);
    if (includePaths) run.tracker.record(item.id, false, { category: failure.category });
    // This catch is for failures before/around `runCapture` itself (db reset, config errors) —
    // `runCapture` persists its own step-failure report, but a failure here never reaches it,
    // so write failure.json here too; an agent reading the capture dir shouldn't have to know
    // which of the two failure paths produced it. validation.json says it wasn't captured, so
    // the older capture (frames moved back by withFrameStabilization) is never rebuilt from.
    markNotCaptured(outDir, { walkthrough: walkthrough.walkthrough, reason: failure.error, failure, baseUrl });
    return {
      walkthrough: walkthrough.walkthrough,
      ok: false,
      steps: { total: 0, passed: 0 },
      frames: 0,
      durationMs: Date.now() - started,
      failure,
      ...dependency,
    };
  }
}

function printSummaries(summaries: CaptureSummary[], json: boolean, problems: string[]): void {
  if (json) {
    console.log(JSON.stringify({ walkthroughs: summaries, ...(problems.length > 0 ? { ok: false, problems } : {}) }));
    return;
  }
  for (const s of summaries) {
    const device = s.device ? ` (${s.device})` : "";
    if (s.skipped) {
      console.log(`SKIP  ${s.walkthrough}${device}  ${s.skipped}`);
      continue;
    }
    // A secondary device's failure is a warning: the primary's page still builds (decision 40).
    const status = s.ok ? "PASS" : s.secondary ? "WARN" : "FAIL";
    const frameDiff = s.frameDiff ? `  (${s.frameDiff.kept} kept / ${s.frameDiff.changed} changed)` : "";
    console.log(
      `${status}  ${s.walkthrough}${device}  steps ${s.steps.passed}/${s.steps.total}  frames ${s.frames}${frameDiff}  ${s.durationMs}ms`,
    );
    if (!s.ok && s.failure) {
      printFailure(s.failure);
    }
    for (const w of s.warnings ?? []) console.log(`  warning: ${w}`);
    for (const p of s.paths ?? []) {
      if (p.skipped) {
        console.log(`  SKIP  path ${p.path}  ${p.skipped}`);
        continue;
      }
      console.log(`  ${p.ok ? "PASS" : "FAIL"}  path ${p.path}  steps ${p.steps.passed}/${p.steps.total}  frames ${p.frames}  ${p.durationMs}ms`);
      if (p.failure) for (const line of formatFailureLines(p.failure)) console.log(`    ${line}`);
      for (const w of p.warnings ?? []) console.log(`    warning: ${w}`);
    }
    for (const d of s.pathDiffs ?? []) console.log(`  warning: ${d.message}`);
  }
}

function printFailure(f: FailureReport): void {
  for (const line of formatFailureLines(f)) console.log(`  ${line}`);
}
