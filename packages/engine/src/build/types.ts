// Types for `aida build`'s per-walkthrough, per-stage pipeline and its run report.
// See docs/scope.md "Pipeline" and "Only rebuild what changed", and docs/build-plan.md M6.
import type { FailureCategory } from "../capture/types.js";

export type BuildStageName = "capture" | "voice" | "render" | "pages" | "pdf" | "index" | "qa";

export type StageStatus = "ok" | "skipped" | "failed" | "not-selected";

export interface StageResult {
  status: StageStatus;
  skipped: boolean;
  ms: number;
  /** Short human-readable detail (error message, or a skip/ok reason). */
  detail?: string;
}

export interface WalkthroughBuildResult {
  walkthrough: string;
  ok: boolean;
  stages: Partial<Record<BuildStageName, StageResult>>;
  voice?: { charsBilled: number; cached: number; synthesized: number; costUsd: number };
  render?: { durationSec: number; wallTimeMs: number };
  qa?: { ok: boolean; problems: number };
  /** The walkthrough's YAML file. */
  file?: string;
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
