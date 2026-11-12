// Types for `aida build`'s per-walkthrough, per-stage pipeline and its run report.
// See docs/scope.md "Pipeline" and "Only rebuild what changed", and docs/build-plan.md M6.
import type { FailureCategory } from "../capture/types.js";
import type { Device } from "../walkthrough/types.js";

export type BuildStageName = "capture" | "voice" | "render" | "pages" | "pdf" | "index" | "qa";

export type StageStatus = "ok" | "skipped" | "failed" | "not-selected";

export interface StageResult {
  status: StageStatus;
  skipped: boolean;
  ms: number;
  /** Short human-readable detail (error message, or a skip/ok reason). */
  detail?: string;
}

/**
 * One non-primary device's capture outcome (decision 40, M43a) — e.g. `devices: { phone: {...} }`
 * when a walkthrough's primary device is desktop. Never makes `WalkthroughBuildResult.ok` false:
 * a phone capture failure is reported here, not as a build failure, unless phone is the primary
 * device (then its outcome is `stages.capture`/`ok` instead, same as desktop always was).
 */
export interface DeviceBuildResult {
  ok: boolean;
  /** First line of the failure, when `!ok`. */
  failure?: string;
  /** Suspected owner of the failure (decision 30), when it failed. */
  category?: FailureCategory;
  /** The *render* outcome for this device's own video (M43c), separate from `ok`/`failure` above
   * (this device's *capture* outcome): a phone capture can pass while its render still fails
   * (missing narration, a crash) — also non-fatal, recorded here rather than failing the build. */
  render?: { ok: boolean; failure?: string };
  /** QA of this device's own video and captions, run apart from the walkthrough's own QA: a
   * failure here drops this device's media (never the page) and never fails `stages.qa`. */
  qa?: { ok: boolean; problems: number };
}

export interface WalkthroughBuildResult {
  walkthrough: string;
  ok: boolean;
  stages: Partial<Record<BuildStageName, StageResult>>;
  voice?: { charsBilled: number; cached: number; synthesized: number; costUsd: number };
  render?: { durationSec: number; wallTimeMs: number };
  /** A secondary phone device's own video (M43c, decision 40) — `<id>.phone.mp4` next to the
   * primary device's. Absent when there's no secondary phone, or nothing rendered this run. */
  phoneRender?: { durationSec: number; wallTimeMs: number };
  qa?: { ok: boolean; problems: number };
  /** The walkthrough's YAML file. */
  file?: string;
  /** Devices this walkthrough was captured on, primary first (decision 40); absent for a
   * desktop-only walkthrough (today's default). */
  devices?: Device[];
  /** Outcome of every device captured this run *other than* the primary (whose outcome is
   * `stages.capture`) — e.g. `{ phone: { ok: false, failure: "..." } }`. Absent when there were
   * none, or none were selected this run. */
  deviceResults?: Partial<Record<Device, DeviceBuildResult>>;
  /** Every failed check, by name, with its first problems and where to look. Absent when none failed. */
  failures?: BuildFailure[];
}

/** One failed check in `report.json`, e.g. QA's `captions:line-length` or a capture step. */
export interface BuildFailure {
  stage: BuildStageName;
  /** The check's name, e.g. "captions:line-length", "capture:step", "voice". */
  check: string;
  /** How many problems the check found; `problems` keeps only the first few. */
  count: number;
  problems: string[];
  /** Where to look: the walkthrough file, `qa.json`, `failure.json`, the offending caption file. */
  files: string[];
  /** Capture failures only: suspected owner (decision 30) and why, from `failure.json`. A
   * suspected app bug goes to a person; it's never worked around in the walkthrough. */
  category?: FailureCategory;
  reason?: string;
}

export interface BuildOptions {
  configPath: string;
  walkthroughIds: string[];
  draft?: boolean;
  only?: BuildStageName[];
  skipCapture?: boolean;
  noReset?: boolean;
  /** Pull in walkthroughs that leave the states the selected ones need (decision 28). */
  withDeps?: boolean;
  json: boolean;
  /**
   * Called as each walkthrough's stage starts and finishes (capture, voice, render, pages, qa,
   * pdf; not the run-wide index stage, and not stages skipped without running). Called
   * synchronously, before the stage's own work: narration (Kokoro) blocks the event loop for
   * minutes, so a timer or a later tick would only fire once it's over. A callback that throws
   * is ignored; it never breaks the build.
   */
  onProgress?: (e: BuildProgressEvent) => void;
}

/** One `BuildOptions.onProgress` call. */
export interface BuildProgressEvent {
  /** The walkthrough's id. */
  walkthrough: string;
  /** The walkthrough's title, for display. */
  title?: string;
  stage: BuildStageName;
  phase: "start" | "done";
  /** The stage's status, on "done" (unset when the stage threw). */
  status?: StageStatus;
  /** Wall time of the stage, on "done". */
  ms?: number;
}

export interface ModelsUsageSection {
  totals: Array<{
    model: string;
    tier: string;
    calls: number;
    input: number;
    output: number;
    cacheRead: number;
    costUsd: number;
  }>;
  totalCostUsd: number;
  totalTokens: number;
}

export interface BuildReport {
  generatedAt: string;
  configPath: string;
  draft: boolean;
  walkthroughs: WalkthroughBuildResult[];
  index?: StageResult & { searchIndexFile?: string; llmsTxtFile?: string; pageCount?: number };
  /** `models.totalCostUsd`/`totalTokens` cover only this run (see `assembleReport`'s `since`). */
  models: ModelsUsageSection;
  /** This run's total voice-synthesis cost (sum of every walkthrough's `voice.costUsd`). */
  voice: { charsBilled: number; costUsd: number };
  budget?: { usd?: number; tokens?: number; exceeded: boolean; reasons: string[] };
  ok: boolean;
  /** Why the run stopped before building anything (capture refused, a crash). Always `ok: false`. */
  error?: string;
}

export const ALL_STAGES: BuildStageName[] = ["capture", "voice", "render", "pages", "pdf", "index", "qa"];
