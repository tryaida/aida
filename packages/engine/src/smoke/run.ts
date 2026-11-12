// `aida test`'s core: replay walkthroughs as checks only. The same path as `aida ci`'s capture
// (ci/planned.ts): the safety gate once before the first browser opens, sign-in, data states and
// the derived capture order (decision 28), a reset before each chain, no video or voice, each
// replay classified (decision 30). No pages, no screenshot diff, no outline edits, nothing
// published. Replays land in `aida ci`'s folder (`<buildDir>/<id>/ci/capture`), which the built
// help site never reads, so the captures `aida build` publishes from are left as they are.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { computeAffected } from "../impact/index.js";
import { listWalkthroughs, type WalkthroughEntry } from "../impact/walkthroughs.js";
import { runCaptureSafetyChecks } from "../safety/index.js";
import { captureInPlannedOrder, type PlannedCiCapture } from "../ci/planned.js";
import { failureSummaryFor } from "../ci/run.js";
import type { CiCaptureResult } from "../ci/capture.js";
import { appBugBlockReason } from "../states/index.js";
import { devicesFor, stepsFor } from "../devices/index.js";
import { briefPath, loadBrief } from "../brief/consumers.js";
import type { ValidationResult } from "../capture/types.js";
import { loadWalkthroughFile, type Walkthrough } from "../walkthrough/index.js";
import { TEST_STATUSES, type StepOutcome, type TestRunResult, type TestStatus, type WalkthroughTestResult } from "./types.js";

export interface RunWalkthroughTestsOptions {
  configPath: string;
  /** Walkthrough ids or files; empty: every walkthrough. */
  walkthroughs?: string[];
  /** Stop at the first walkthrough that doesn't pass. */
  bail?: boolean;
  /** Only the walkthroughs the diff `base`...`head` touches (impact/; "can't tell" means all). */
  affected?: { base: string; head?: string; appRepo?: string };
}

/** The walkthrough ids `wanted` names (ids or walkthrough files), in the order given. */
function resolveWanted(wanted: string[], entries: WalkthroughEntry[], dir: string): string[] {
  const ids: string[] = [];
  for (const w of wanted) {
    const file = resolve(w);
    const entry = entries.find((e) => e.id === w) ?? entries.find((e) => resolve(e.file) === file);
    if (!entry) throw new Error(`no walkthrough "${w}" in ${dir}`);
    if (!ids.includes(entry.id)) ids.push(entry.id);
  }
  return ids;
}

function readValidation(captureDir: string): (Partial<ValidationResult> & { notCaptured?: string }) | undefined {
  try {
    return JSON.parse(readFileSync(join(captureDir, "validation.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** The walkthrough's steps on the device it ran as, each passed, failed or not run. */
function stepOutcomes(walkthrough: Walkthrough, steps: Walkthrough["steps"], validation: ReturnType<typeof readValidation>): StepOutcome[] {
  const ran = validation && !validation.notCaptured && validation.workflow === walkthrough.walkthrough ? (validation.steps ?? []) : [];
  return steps.map((step, i) => {
    const r = ran[i];
    const title = r?.title ?? step.title ?? step.id ?? `Step ${i + 1}`;
    return {
      title,
      ...(step.id ? { id: step.id } : {}),
      status: r ? (r.ok ? "passed" : "failed") : "skipped",
      ...(r ? { ms: r.ms } : {}),
    };
  });
}

function statusFor(category: string | undefined): TestStatus {
  if (category === "app" || category === "environment" || category === "undetermined") return category;
  return "broken";
}

function capturedResult(id: string, captured: CiCaptureResult, configPath: string, steps: Walkthrough["steps"]): WalkthroughTestResult {
  const validation = readValidation(captured.captureDir);
  const outcomes = stepOutcomes(captured.walkthrough, steps, validation);
  const warnings = validation?.warnings && validation.warnings.length > 0 ? { warnings: validation.warnings } : {};
  if (captured.ok) return { walkthrough: id, status: "passed", steps: outcomes, ...warnings };

  const report = captured.failure;
  const summary = failureSummaryFor(id, configPath, report?.error ?? "the replay failed", report?.step, report);
  const reportPath = join(captured.captureDir, "failure.json");
  return {
    walkthrough: id,
    status: statusFor(report?.category),
    steps: outcomes,
    failure: {
      ...(report?.step ? { step: report.step } : {}),
      ...(report?.action ? { action: report.action } : {}),
      ...summary,
      ...(report?.screenshotPath ? { screenshot: report.screenshotPath } : {}),
      ...(existsSync(reportPath) ? { report: reportPath } : {}),
    },
    ...warnings,
  };
}

function blockedResult(outcome: Extract<PlannedCiCapture, { blocked: string }>, steps: Walkthrough["steps"]): WalkthroughTestResult {
  const skipped: StepOutcome[] = steps.map((s, i) => ({ title: s.title ?? s.id ?? `Step ${i + 1}`, ...(s.id ? { id: s.id } : {}), status: "skipped" }));
  // No order works for it at all (a need nothing leaves, a cycle): the walkthrough's to fix.
  if (outcome.blockedBy.length === 0) {
    return { walkthrough: outcome.id, status: "broken", steps: skipped, failure: { category: "walkthrough", summary: outcome.blocked } };
  }
  return {
    walkthrough: outcome.id,
    status: "blocked",
    steps: skipped,
    failure: {
      summary: outcome.blocked,
      blockedBy: outcome.blockedBy,
      ...(outcome.appBugIn.length > 0 ? { reason: appBugBlockReason(outcome.appBugIn) } : {}),
    },
  };
}

export function countStatuses(results: WalkthroughTestResult[]): Record<TestStatus, number> {
  const counts = Object.fromEntries(TEST_STATUSES.map((s) => [s, 0])) as Record<TestStatus, number>;
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/**
 * Replays the walkthroughs and returns one result per walkthrough the run replayed (the ones
 * asked for plus any that leave data they need), in run order. Throws `AppDatabaseRefusedError`
 * when the safety gate refuses, before any browser opens.
 */
export async function runWalkthroughTests(opts: RunWalkthroughTestsOptions): Promise<TestRunResult> {
  const config = await loadConfig(opts.configPath);
  const entries = listWalkthroughs(config.walkthroughsDir, config.buildDir, config);
  let ids = (opts.walkthroughs ?? []).length > 0 ? resolveWanted(opts.walkthroughs!, entries, config.walkthroughsDir) : entries.map((e) => e.id);

  let affected: TestRunResult["affected"];
  if (opts.affected) {
    const head = opts.affected.head ?? "HEAD";
    const result = await computeAffected({
      appRepo: opts.affected.appRepo ?? config.impact?.appRepo ?? process.cwd(),
      base: opts.affected.base,
      head,
      config,
      app: config.impact?.app,
    });
    affected = { base: opts.affected.base, head, all: result.all, ...(result.reason ? { reason: result.reason } : {}) };
    if (!result.all) {
      const touched = new Set(result.walkthroughs.filter((w) => w.affected).map((w) => w.id));
      ids = ids.filter((id) => touched.has(id));
    }
  }

  const captures = join(config.buildDir, "<walkthrough>", "ci");
  if (ids.length === 0) {
    return { ok: true, counts: countStatuses([]), walkthroughs: [], notRun: [], ...(affected ? { affected } : {}), captures };
  }

  // The capture safety gate (decision 27), as `aida ci` runs it: once, before the first capture.
  await runCaptureSafetyChecks(config);

  const asked = new Set(ids);
  const brief = loadBrief(briefPath(config));
  const results: WalkthroughTestResult[] = [];
  // Each walkthrough on its primary device, as `aida ci` replays it (ci/capture.ts).
  const stepsOf = (wt: Walkthrough) => stepsFor(wt, devicesFor(wt, config, brief)[0] ?? "desktop");
  for await (const outcome of captureInPlannedOrder(config, entries, ids, undefined)) {
    let result: WalkthroughTestResult;
    if (outcome.blocked !== undefined) {
      const entry = entries.find((e) => e.id === outcome.id);
      let steps: Walkthrough["steps"] = [];
      try {
        if (entry) steps = stepsOf(loadWalkthroughFile(entry.file));
      } catch {
        // listed without its steps
      }
      result = blockedResult(outcome, steps);
    } else {
      result = capturedResult(outcome.id, outcome.captured, opts.configPath, stepsOf(outcome.captured.walkthrough));
    }
    if (!asked.has(outcome.id)) result.dependency = true;
    results.push(result);
    if (opts.bail && result.status !== "passed") break;
  }

  const done = new Set(results.map((r) => r.walkthrough));
  const notRun = ids.filter((id) => !done.has(id));
  return {
    ok: results.every((r) => r.status === "passed") && notRun.length === 0,
    counts: countStatuses(results),
    walkthroughs: results,
    notRun,
    ...(affected ? { affected } : {}),
    captures,
  };
}
