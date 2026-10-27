import type { Camera, Viewport } from "../walkthrough/index.js";
import type { PathCaptureSummary } from "./paths.js";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Transition = "cut" | "fade";

/**
 * One event in a step's playback timeline — the same vocabulary the original
 * pipeline's compose.mjs animates: frame, move, click, highlight, hold, plus the
 * per-character/per-scroll-increment frame bursts.
 */
export type CaptureEvent =
  | { type: "frame"; image: string; transition: Transition }
  | { type: "move"; to: Point }
  | { type: "click"; at: Point }
  | { type: "highlight"; box: Box }
  | { type: "clearHighlight" }
  | { type: "hold"; seconds: number }
  | { type: "scrollFrames"; images: string[] }
  | { type: "typeFrames"; images: string[]; text: string };

/** One same-origin network request a step's actions triggered. */
export interface ImpactRequest {
  method: string;
  path: string;
  /** A Next.js server action's id (the `Next-Action` request header), when the request was one. */
  action?: string;
  /**
   * True when the request is known to have saved nothing (decision 37): a server action whose
   * response revalidated nothing (no `x-action-revalidated`, or one saying nothing changed), set
   * no cookie and didn't redirect, or a GraphQL query. Path comparison ignores these.
   */
  read?: boolean;
  /** A GraphQL mutation's operation name (`mutation CreatePayment`), so two mutations posted to
   * the same endpoint compare as different saves. */
  operation?: string;
}

/** aida addition: what a step touched, for the CI impact map. */
export interface StepImpact {
  urls: string[];
  requests: ImpactRequest[];
}

/** aida addition: per-step check outcomes, mirrored into the manifest (not just validation.json). */
export interface CheckResult {
  [key: string]: unknown;
  ok: boolean;
}

/** A step's callout/blur box, resolved at capture time (M22) — `id` matches the walkthrough
 * step's `callouts`/`blur` entry it was resolved from, so pages/render can look up the label
 * (callouts only) and ordering from the walkthrough while trusting this box, which already
 * followed a `target` to wherever it actually rendered this run. Entries whose target couldn't
 * be found this run are simply absent — pages/render skip them rather than drawing a stale box. */
export interface ResolvedBox {
  id: string;
  box: Box;
}

export interface ManifestStep {
  id: string | undefined;
  camera: Camera;
  cameraBox: Box | null;
  events: CaptureEvent[];
  doc: { image: string | null; highlights: Box[]; callouts?: ResolvedBox[]; blur?: ResolvedBox[] };
  impact: StepImpact;
  checks: CheckResult[];
  /** On-screen names this step's actions found (see capture/target-names.ts), for outline drift.
   * Absent when the step names nothing, and in manifests written before M29. */
  targets?: string[];
  /**
   * What was really on screen in this step, for outline drift: the accessible name of each
   * element an action resolved (not the walkthrough's search string) and the page's h1-h3
   * headings. Redacted, sorted, deduped and capped; values containing the run id are left out so
   * the manifest stays identical across runs. Absent when nothing was seen.
   */
  seen?: string[];
}

/**
 * Same shape as the original pipeline's `capture/manifest.json` (render/compose reads this),
 * plus the `impact` and `checks` additions on each step. Deliberately holds
 * nothing time-based (no `capturedAt`/durations) — identical input must
 * produce a byte-identical manifest across runs. Wall-clock metadata lives in
 * `run.json` (see `RunInfo` in `./runner.js`) instead.
 */
export interface CaptureManifest {
  workflow: string;
  /**
   * @deprecated No longer written by the capture runner (it broke
   * byte-for-byte determinism across identical runs) — see `run.json`
   * (`RunInfo` in `./runner.js`) instead. Kept optional so code reading an
   * older manifest.json still type-checks.
   */
  capturedAt?: string;
  baseUrl: string;
  viewport: Viewport;
  deviceScaleFactor: number;
  steps: ManifestStep[];
  finalUrl?: string;
}

export interface ProblemEntry {
  url: string;
  text?: string;
  status?: number;
}

export interface StepResult {
  id: string | undefined;
  title: string | undefined;
  checks: CheckResult[];
  ok: boolean;
  ms: number;
  error?: string;
  failureFrame?: string | null;
}

export interface DatabaseCheckResult {
  name: string;
  ok: boolean;
  row?: Record<string, unknown>;
  expect?: Record<string, unknown>;
  error?: string;
}

/**
 * A walkthrough path whose writes differ from the main run's (decision 34): e.g. paying from the
 * attendee's page spreads the money across their bookings. Keys are `writeKey` strings
 * (capture/paths.ts): `POST /api/payments/:id`, or `POST action <id>` for a server action.
 */
export interface PathDiff {
  /** The path's id. */
  path: string;
  /** Every write the main run made, one key per request, sorted. */
  main: string[];
  /** Every write the path's run made, likewise. */
  pathWrites: string[];
  /** Keys whose count differs, as the path made them (`POST /api/x ×2` for more than one). */
  onlyInPath: string[];
  /** The same keys as the main run made them. */
  onlyInMain: string[];
  /** Server actions only this path called (none of them told apart as saves), when any. */
  actionsOnlyInPath?: string[];
  /** Server actions only the main run called, likewise. */
  actionsOnlyInMain?: string[];
  /** Why the path is flagged: it saves differently, calls server actions the other run doesn't
   * (read by their headers, but they may still save), leaves different data (end checks). */
  reasons: ("saves" | "actions" | "data")[];
  /** The end checks of both runs (decision 37), when they ran. */
  endChecks?: { main: PathEndChecks; path: PathEndChecks };
  /** One line: "path from-attendee saves POST /api/payments/allocate once; main path saves POST
   * /api/payments once", then "path … leaves different data: end checks fail where …". */
  message: string;
}

/** Pass/fail of one run's end checks: the final step's checks and `validate.database`. */
export interface PathEndChecks {
  ok: boolean;
  failed: string[];
}

/** One path's end checks, recorded for every path that ran (passed or not). */
export interface PathCheckResult {
  path: string;
  ok: boolean;
  failed: string[];
  /** False when the path's own capture failed (a failing final step fails the path). */
  captured?: boolean;
}

/** Same shape as the original pipeline's `capture/validation.json`. */
export interface ValidationResult {
  workflow: string;
  ranAt: string;
  baseUrl: string;
  database?: string;
  ok: boolean;
  steps: StepResult[];
  dbChecks: DatabaseCheckResult[];
  problems: {
    console: ProblemEntry[];
    page: ProblemEntry[];
    server: ProblemEntry[];
  };
  /** Paths whose writes or end checks differ from this (main) run's; absent when none do
   * (decisions 34, 37). */
  pathDiffs?: PathDiff[];
  /** Every compared path's end checks (pass/fail), whether or not it was flagged (decision 37). */
  pathChecks?: PathCheckResult[];
  /** A path run's own end checks (only in `paths/<id>/validation.json`): its `ok` leaves out the
   * database checks, which are compared with the main run's instead (decision 37). */
  endChecks?: PathEndChecks;
}

/**
 * Who a capture failure probably belongs to (decision 30): the walkthrough (fix the YAML), the app
 * (a person looks at it; never worked around in the walkthrough) or the environment (the app isn't
 * running, sign-in broke, a safety check refused). Always a suspicion, worded as one.
 */
export type FailureCategory = "walkthrough" | "app" | "environment";

/** One request seen during the failing step: method, path without query, status (0: no response). */
export interface FailureRequest {
  method: string;
  path: string;
  /** Absent while the request was still waiting for an answer when the step failed. */
  status?: number;
  /** For a write still waiting when the step failed: how long it had been waiting, in seconds. */
  waitedSeconds?: number;
}

/** An action in the failing step: its position (1-based) and its `do`. */
export interface FailureActionRef {
  index: number;
  do: string;
}

/** What changed while the failing step ran: small, redacted, no query strings or bodies. */
export interface FailureChanges {
  /** Where the step started and where it failed (query and fragment dropped). */
  urlBefore: string;
  urlAfter: string;
  /** Non-GET requests during the step, in order (capped). */
  writes: FailureRequest[];
  /** 4xx/5xx responses during the step, any method (capped). */
  errorResponses: FailureRequest[];
  /** Uncaught page errors during the step: count and the first one's first line, redacted. */
  pageErrors: { count: number; first?: string };
  /** Console errors during the step, same shape. */
  consoleErrors: { count: number; first?: string };
  /**
   * The path the walkthrough opened (its start page or a `goto`), when nothing has been clicked
   * since: a different `urlAfter` path means the app redirected (e.g. a missing precondition).
   */
  expectedPath?: string;
  /** No visible text in `main` (or `body`) when the step failed (a loading placeholder isn't blank). */
  blankPage: boolean;
  /** Whether the page's visible text changed after the step's last click; absent with no click. */
  screenChanged?: boolean;
  /** The role the walkthrough signed in as. */
  signedInAs?: string;
  /**
   * The diagnosis-only reload after a save and a missed wait (never part of the walkthrough,
   * done after the failure was recorded): whether the wait's target showed up once reloaded.
   */
  reload?: { targetShown: boolean };
  failedAction?: FailureActionRef;
  lastOkAction?: FailureActionRef;
}

/** The trimmed, agent-safe report for a failed step. Never full HTML/logs. */
export interface FailureReport {
  step: string | undefined;
  action: string;
  /** Suspected owner of the failure; see `FailureCategory`. */
  category: FailureCategory;
  /** One line, plain words, "suspected" wording: why it looks like that category. */
  reason: string;
  error: string;
  url: string;
  /** What changed during the failing step. Absent for failures outside a step (sign-in, setup). */
  changes?: FailureChanges;
  /** `page.ariaSnapshot()`/`locator('body').ariaSnapshot()`, capped to ~60 lines. */
  snapshot: string;
  screenshotPath: string | null;
}

/** Frame-stabilization counts for this capture run; see capture/frame-diff.ts stabilizeFrames(). */
export interface FrameDiffSummary {
  kept: number;
  changed: number;
}

export interface CaptureSummary {
  walkthrough: string;
  ok: boolean;
  steps: { total: number; passed: number };
  frames: number;
  durationMs: number;
  failure?: FailureReport;
  frameDiff?: FrameDiffSummary;
  /** Not captured because data it needs wasn't left: "skipped: needs <state>, which <provider> didn't leave". */
  skipped?: string;
  /** Pulled into the run by `--with-deps` rather than asked for. */
  dependency?: boolean;
  /** e.g. a state it should leave whose check says it isn't true. */
  warnings?: string[];
  /** One entry per walkthrough path (decision 34), when it has any. */
  paths?: PathCaptureSummary[];
  /** Paths whose writes differ from the main run's. Never fails the capture. */
  pathDiffs?: PathDiff[];
}
