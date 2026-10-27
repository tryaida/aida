import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { loadConfig } from "../config/index.js";
import type { Walkthrough } from "../walkthrough/index.js";
import { formatFailureLines, runCapture, runLevelFailure, withFrameStabilization } from "../capture/index.js";
import { assertLocalDatabase } from "../capture/write-guard.js";
import { captureSafetyRefusal } from "../safety/index.js";
import { appBugBlockReason, planRunFromFiles } from "../states/index.js";
import { markNotCaptured } from "../capture/not-captured.js";
import type { CaptureManifest, CaptureSummary, FailureReport } from "../capture/types.js";
import { resolveCaptureSettings } from "../config/types.js";
import { recordCaptureDrift } from "../outline/index.js";

export interface RunCaptureOptions {
  configPath: string;
  walkthroughIds: string[];
  json: boolean;
  noReset?: boolean;
  /** Pull in walkthroughs that leave the states the selected ones need (decision 28). */
  withDeps?: boolean;
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
function storageStateKey(baseUrl: string, walkthrough: Walkthrough): string {
  const persona = walkthrough.start?.persona ?? null; // normalised at load: always an object
  const hash = createHash("sha256").update(JSON.stringify({ baseUrl, persona })).digest("hex").slice(0, 16);
  return hash;
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

  for (const item of run.plan.walkthroughs) {
    const walkthrough: Walkthrough = item.walkthrough;
    const dependency = item.reason === "dependency" ? { dependency: true } : {};
    const outDir = join(config.buildDir, walkthrough.walkthrough, "capture");
    const blocked = run.tracker.blocked(item);
    if (blocked) {
      ok = false;
      run.tracker.record(item.id, false, { appBugIn: blocked.appBugIn });
      // Never leave an older passing capture looking current (build --skip-capture refuses it).
      markNotCaptured(outDir, { walkthrough: item.id, reason: blocked.reason });
      const skipped = blocked.appBugIn.length > 0 ? `${blocked.reason} (${appBugBlockReason(blocked.appBugIn)})` : blocked.reason;
      summaries.push({ walkthrough: item.id, ok: false, steps: { total: 0, passed: 0 }, frames: 0, durationMs: 0, skipped, ...dependency });
      continue;
    }
    mkdirSync(outDir, { recursive: true });

    const baseUrl = walkthrough.start?.baseUrl ?? config.app.baseUrl;
    const storageStatePath = join(
      config.buildDir,
      ".aida-session",
      `storageState-${storageStateKey(baseUrl, walkthrough)}.json`,
    );

    const started = Date.now();
    try {
      // Only reset the database for walkthroughs that actually assert
      // against it — and never without first proving the URL is local.
      // `reset()` is destructive; it must not run against an unverified or
      // needlessly touched database. Inside the same try/catch as the
      // capture itself, so a refusal here is reported like any other
      // per-walkthrough failure instead of crashing the whole command.
      // The plan moves a chain member's reset to the start of its chain.
      if (item.resetBefore && config.database) {
        const dbUrl = await config.database.url();
        assertLocalDatabase(dbUrl);
        await config.database.reset?.();
      }

      const captureSettings = resolveCaptureSettings(config.capture);
      const stabilizeOpts = { threshold: captureSettings.frameDiffThreshold, tolerance: captureSettings.frameDiffTolerance };
      const { result, frameDiff } = await withFrameStabilization(outDir, stabilizeOpts, () =>
        runCapture({
          walkthrough,
          config,
          outDir,
          storageStatePath,
          runId: run.runId,
          personaFor: run.personaFor,
          log: opts.json ? undefined : (...a: unknown[]) => console.error("[capture]", ...a),
        }),
      );
      writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`);
      writeFileSync(join(outDir, "run.json"), `${JSON.stringify(result.run, null, 2)}\n`);
      writeFileSync(join(outDir, "validation.json"), `${JSON.stringify(result.validation, null, 2)}\n`);
      // Outline drift (M29): quiet without an outline file; never fails the capture.
      const outlineLine = recordCaptureDrift({ config, walkthrough, manifest: result.manifest, validation: result.validation });
      if (outlineLine) console.error(outlineLine);

      const passed = result.validation.steps.filter((s) => s.ok).length;
      const frames = countFrames(result.manifest);
      const summary: CaptureSummary = {
        walkthrough: walkthrough.walkthrough,
        ok: result.validation.ok,
        steps: { total: result.validation.steps.length, passed },
        frames,
        durationMs: Date.now() - started,
        failure: result.failure,
        frameDiff,
        ...dependency,
        ...(result.warnings ? { warnings: result.warnings } : {}),
      };
      summaries.push(summary);
      run.tracker.record(item.id, summary.ok, { category: result.failure?.category });
      if (!summary.ok) ok = false;
    } catch (err) {
      ok = false;
      // First line only, never the full Playwright call log (which can run to dozens of lines
      // and leak page state into CI output); classified like a step failure (M28).
      const failure: FailureReport = runLevelFailure(err);
      run.tracker.record(item.id, false, { category: failure.category });
      // This catch is for failures before/around `runCapture` itself (db reset, config errors) —
      // `runCapture` persists its own step-failure report, but a failure here never reaches it,
      // so write failure.json here too; an agent reading the capture dir shouldn't have to know
      // which of the two failure paths produced it. validation.json says it wasn't captured, so
      // the older capture (frames moved back by withFrameStabilization) is never rebuilt from.
      markNotCaptured(outDir, { walkthrough: walkthrough.walkthrough, reason: failure.error, failure, baseUrl });
      summaries.push({
        walkthrough: walkthrough.walkthrough,
        ok: false,
        steps: { total: 0, passed: 0 },
        frames: 0,
        durationMs: Date.now() - started,
        failure,
        ...dependency,
      });
    }
  }

  printSummaries(summaries, opts.json, problems);
  return ok ? 0 : 1;
}

function countFrames(manifest: CaptureManifest): number {
  const names = new Set<string>();
  for (const step of manifest.steps) {
    for (const e of step.events) {
      if (e.type === "frame") names.add(e.image);
      if (e.type === "scrollFrames" || e.type === "typeFrames") {
        for (const img of e.images) names.add(img);
      }
    }
  }
  return names.size;
}

function printSummaries(summaries: CaptureSummary[], json: boolean, problems: string[]): void {
  if (json) {
    console.log(JSON.stringify({ walkthroughs: summaries, ...(problems.length > 0 ? { ok: false, problems } : {}) }));
    return;
  }
  for (const s of summaries) {
    if (s.skipped) {
      console.log(`SKIP  ${s.walkthrough}  ${s.skipped}`);
      continue;
    }
    const status = s.ok ? "PASS" : "FAIL";
    const frameDiff = s.frameDiff ? `  (${s.frameDiff.kept} kept / ${s.frameDiff.changed} changed)` : "";
    console.log(
      `${status}  ${s.walkthrough}  steps ${s.steps.passed}/${s.steps.total}  frames ${s.frames}${frameDiff}  ${s.durationMs}ms`,
    );
    if (!s.ok && s.failure) {
      printFailure(s.failure);
    }
    for (const w of s.warnings ?? []) console.log(`  warning: ${w}`);
  }
}

function printFailure(f: FailureReport): void {
  for (const line of formatFailureLines(f)) console.log(`  ${line}`);
}
