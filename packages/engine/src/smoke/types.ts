// Result shapes for `aida test`: walkthroughs replayed as checks, reported like a test run.
import type { FailureCategory } from "../capture/types.js";

/**
 * One walkthrough's outcome. Every status but "passed" fails the run:
 *   - broken: the walkthrough needs fixing (a target that isn't there, a wrong value), or no
 *     capture order works for it (a need nothing leaves, a cycle)
 *   - app: a suspected app bug (decision 30), including a replay whose every step passed while
 *     the app's own origin answered a 5xx or threw a page error
 *   - environment: the app, sign-in, setup or the browser, not the walkthrough
 *   - undetermined: the evidence fits the app and the walkthrough alike; a person looks
 *   - blocked: not replayed, because a walkthrough that leaves the data it needs failed
 */
export type TestStatus = "passed" | "broken" | "app" | "environment" | "undetermined" | "blocked";

export const TEST_STATUSES: readonly TestStatus[] = ["passed", "broken", "app", "environment", "undetermined", "blocked"];

export interface StepOutcome {
  /** The step's title, else its id, else "Step <n>". */
  title: string;
  id?: string;
  status: "passed" | "failed" | "skipped";
  ms?: number;
}

export interface TestFailure {
  /** The failing step's id or title, when it failed inside a step. */
  step?: string;
  /** The action that was running ("click", "waitFor", "run" for a whole-run check). */
  action?: string;
  category?: FailureCategory;
  /** One line, redacted: the step and the first line of the error. */
  summary: string;
  /** One line on why it looks like that category, from the failure report. */
  reason?: string;
  /** What the failing step did to the app (URL, writes, screen), when known. */
  evidence?: string;
  /** The screenshot taken when it failed. */
  screenshot?: string;
  /** The trimmed failure report (failure.json). */
  report?: string;
  /** The aida-repair command, for a failure that looks like the walkthrough's or the setup's. */
  repairCommand?: string;
  /** For "blocked": the walkthroughs whose failure left this one without its data. */
  blockedBy?: string[];
}

export interface WalkthroughTestResult {
  walkthrough: string;
  status: TestStatus;
  /** Not asked for: replayed because a walkthrough that was asked for needs data it leaves. */
  dependency?: true;
  /** The walkthrough's steps on the device it was replayed as, in order. */
  steps: StepOutcome[];
  failure?: TestFailure;
  /** Notes that didn't fail it, e.g. third-party errors that were ignored. */
  warnings?: string[];
}

export interface TestRunResult {
  /** True when every walkthrough replayed passed. */
  ok: boolean;
  counts: Record<TestStatus, number>;
  walkthroughs: WalkthroughTestResult[];
  /** Asked for but not replayed because `--bail` stopped the run first. */
  notRun: string[];
  /** Set with `--affected`: the diff the walkthroughs were chosen from. */
  affected?: { base: string; head: string; all: boolean; reason?: string };
  /** Where each replay's files are: `<buildDir>/<id>/ci/capture`, shared with `aida ci`, never
   * the captures the built help site comes from. */
  captures: string;
}
