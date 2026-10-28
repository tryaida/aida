// Client-side types mirroring the engine's Walkthrough/Step shape (kept minimal — the Studio UI
// only needs the fields it edits).
export interface StudioBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StudioTarget {
  role?: string;
  name?: string;
  exact?: boolean;
  label?: string;
  placeholder?: string;
  text?: string;
  css?: string;
  hasText?: string;
  within?: StudioTarget;
  innermost?: boolean;
  nth?: number;
  padUnion?: StudioTarget;
}

export interface StudioCallout {
  id: string;
  target?: StudioTarget;
  box?: StudioBox;
  label?: string;
}

export interface StudioBlur {
  id: string;
  target?: StudioTarget;
  box?: StudioBox;
}

/** Just enough of the engine's `Action` shape for the Studio to find each `highlight` target, in
 * the same order `runner.ts` emits `highlight` events (and so `StudioManifestStep.highlights`
 * boxes) — see `ScreenshotEditor`'s `highlightTargetsOf`. `highlight: true` means "the action's
 * own target"; a `Target` object means "highlight a different element". */
export interface StudioAction {
  target?: StudioTarget;
  highlight?: boolean | StudioTarget;
}

export interface StudioStep {
  id?: string;
  chapter?: string;
  title?: string;
  say?: string;
  caption?: string;
  page_text?: string;
  hold?: number;
  callouts?: StudioCallout[];
  blur?: StudioBlur[];
  actions?: StudioAction[];
}

export interface StudioWalkthrough {
  walkthrough: string;
  title: string;
  summary?: string;
  section?: string;
  steps: StudioStep[];
}

/** One step's resolved overlay boxes from the latest capture manifest (M22) — what the Studio's
 * screenshot editor actually draws against: pinned `callouts`/`blur` entries are only shown once
 * they resolve to a box here (an entry with no matching id just captured yet is a no-op, not a
 * guess), and `highlights` is what a click snaps a new callout/blur to when it lands on an
 * element aida already knows the box of. */
export interface StudioManifestStep {
  image: string | null;
  highlights: StudioBox[];
  callouts: { id: string; box: StudioBox }[];
  blur: { id: string; box: StudioBox }[];
}

export interface StudioManifest {
  viewport: { width: number; height: number };
  steps: StudioManifestStep[];
}

/** Mirrors app/studio/_lib/server.ts's CaptureStatus. */
export type CaptureStatus = "passed" | "failed" | "captured" | "not-captured";

/** Mirrors the engine's studio/health.ts `LastFailure`: who the last failure looks like (decision 30). */
export interface StudioFailure {
  category: "walkthrough" | "app" | "environment" | "undetermined";
  label: string;
  reason: string;
  step?: string;
  error: string;
}

/** Mirrors the engine's studio/health.ts `OutlineDriftItem`. */
export interface StudioDrift {
  expected: string;
  seen?: string;
  step?: string;
  source: "capture" | "writer";
  text: string;
}

export interface WalkthroughSummary {
  id: string;
  file: string;
  title: string;
  stepCount: number;
  section?: string;
  summary?: string;
  status: CaptureStatus;
  lastChecked?: string;
  failure?: StudioFailure;
  drift?: StudioDrift[];
}

/** GET /studio/api/walkthrough's response. */
export interface WalkthroughDetail {
  walkthrough: StudioWalkthrough;
  manifest?: StudioManifest;
  status: CaptureStatus;
  lastChecked?: string;
  /** The last capture's failure, when it didn't pass. */
  failure?: StudioFailure;
  /** Names on the outline card that differ from the screen. */
  drift?: StudioDrift[];
  siteUrl?: string;
  hasVideo: boolean;
}

/** GET /studio/api/page's response. `text` keeps aida's block markers (the preview uses them
 * to find each step's section); `builtAt`/`editedAt` are file mtimes in ms. */
export interface PageData {
  found: boolean;
  text?: string;
  builtAt?: number;
  editedAt?: number;
}

export interface HistoryEntry {
  at: string;
  by: "person" | "agent";
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  file?: string;
  /** On an `undo:<action>` entry: the index (oldest-first) of the entry it reverted. */
  undoOf?: number;
}
