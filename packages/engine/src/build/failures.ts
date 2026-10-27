// Names each failed check in `report.json` (build-plan.md M26): which check, its first few
// problems, and the files to open — instead of only "1 check failed".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FailureReport, ValidationResult } from "../capture/types.js";
import { classifyErrorMessage } from "../capture/diagnose.js";
import { redactLine } from "../capture/redact.js";
import type { QaReport } from "../qa/run.js";
import { formatTextProblem, type WalkthroughTextProblem } from "../qa/walkthrough-text.js";
import { appBugBlockReason } from "../states/order.js";
import type { BuildFailure, BuildStageName, StageResult } from "./types.js";

/** Problems kept per check; `count` still says how many there were. */
export const MAX_PROBLEMS_PER_CHECK = 5;

export interface FailureSources {
  /** The walkthrough's YAML file. */
  file?: string;
  stages: Partial<Record<BuildStageName, StageResult>>;
  captureDir: string;
  validation?: ValidationResult;
  /** `<buildDir>/<id>/qa.json`, when the QA stage wrote one. */
  qaFile?: string;
  qaReports?: QaReport[];
  /** The capture's `failure.json`, only when this run wrote it (or, under `--skip-capture`, the
   * reused capture's own). One left in the capture dir by an earlier run is never listed or read. */
  failureFile?: string;
  /** Not captured because a walkthrough it needs data from failed (or no order works for it):
   * any possible app bug it inherits from those providers (decision 30). */
  blocked?: { appBugIn: string[] };
}

function failure(stage: BuildStageName, check: string, problems: string[], files: (string | undefined)[]): BuildFailure {
  return {
    stage,
    check,
    count: problems.length,
    problems: problems.slice(0, MAX_PROBLEMS_PER_CHECK),
    files: [...new Set(files.filter((f): f is string => Boolean(f)))],
  };
}

function captureFailures(src: FailureSources, detail: string | undefined): BuildFailure[] {
  if (src.blocked) {
    // Never ran: nothing to repair in this walkthrough; the detail names the provider.
    const app = src.blocked.appBugIn.length > 0 ? { category: "app" as const, reason: appBugBlockReason(src.blocked.appBugIn) } : {};
    return [{ ...failure("capture", "capture:blocked", [detail ?? "not captured"], [src.file]), ...app }];
  }
  // Only a failure.json this run wrote (see FailureSources.failureFile), never an older one.
  const failureJson = src.failureFile && existsSync(src.failureFile) ? src.failureFile : undefined;
  const files = [src.file, failureJson];
  const diagnosis = failureJson ? readDiagnosis(failureJson) : {};
  const v = src.validation;
  if (!v || v.ok) {
    // Capture threw before writing a result: this run's run-level failure.json classifies it;
    // without one, only the error text is left to go on.
    const byMessage = !v && detail && !diagnosis.category ? classifyErrorMessage(detail) : undefined;
    return [{ ...failure("capture", "capture", [detail ? redactLine(detail) : "capture failed"], files), ...diagnosis, ...(byMessage ?? {}) }];
  }

  const out: BuildFailure[] = [];
  const validationJson = join(src.captureDir, "validation.json");
  // Raw step and database errors can carry a URL's token, a secret or personal data: report.json
  // gets the same one-line redaction as failure.json.
  const steps = v.steps.filter((s) => !s.ok).map((s) => `step "${s.id ?? s.title ?? "?"}": ${s.error ? redactLine(s.error) : "a check failed"}`);
  if (steps.length > 0) out.push({ ...failure("capture", "capture:step", steps, [...files, validationJson]), ...diagnosis });
  const db = (v.dbChecks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.error ? redactLine(c.error) : "values didn't match"}`);
  if (db.length > 0) out.push(failure("capture", "capture:database", db, [src.file, validationJson]));
  return out.length > 0 ? out : [{ ...failure("capture", "capture", [detail ? redactLine(detail) : "capture failed"], files), ...diagnosis }];
}

/** `category`/`reason` from this run's failure.json. */
function readDiagnosis(failureJson: string): Pick<BuildFailure, "category" | "reason"> {
  try {
    const report = JSON.parse(readFileSync(failureJson, "utf8")) as Partial<FailureReport>;
    return report.category && report.reason ? { category: report.category, reason: report.reason } : {};
  } catch {
    return {};
  }
}

function qaFailures(src: FailureSources, detail: string | undefined): BuildFailure[] {
  const out: BuildFailure[] = [];
  for (const report of src.qaReports ?? []) {
    for (const c of report.checks) {
      if (c.ok) continue;
      out.push(failure("qa", c.check, c.problems.length > 0 ? c.problems : [c.details], [src.qaFile, c.file ?? report.target]));
    }
  }
  return out.length > 0 ? out : [failure("qa", "qa", [detail ?? "QA failed"], [src.qaFile, src.file])];
}

/** Every failed check for one walkthrough, in stage order. `undefined` when nothing failed. */
export function collectFailures(src: FailureSources): BuildFailure[] | undefined {
  const out: BuildFailure[] = [];
  for (const stage of ["capture", "voice", "render", "pages", "pdf", "qa"] as BuildStageName[]) {
    const result = src.stages[stage];
    if (result?.status !== "failed") continue;
    if (stage === "capture") out.push(...captureFailures(src, result.detail));
    else if (stage === "qa") out.push(...qaFailures(src, result.detail));
    else out.push(failure(stage, stage, [result.detail ?? `${stage} failed`], [src.file]));
  }
  return out.length > 0 ? out : undefined;
}

/** `aida validate`'s text checks, found at the start of a build: one failure per check. */
export function textCheckFailures(problems: WalkthroughTextProblem[], file: string): BuildFailure[] {
  const byCheck = new Map<string, WalkthroughTextProblem[]>();
  for (const p of problems) byCheck.set(p.check, [...(byCheck.get(p.check) ?? []), p]);
  return [...byCheck].map(([check, ps]) => failure("qa", check, ps.map(formatTextProblem), [file]));
}
