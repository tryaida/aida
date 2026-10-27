// Shared types for the pages module: builds a Markdown help page (+ annotated screenshots)
// from a Walkthrough and its capture output. See markers.ts for the generated/human-edit split.

export interface BuildPageOptions {
  /** Directory holding a render() output (`<videoDir>/<id>/<id>.mp4` etc.) — video/caption links are added when present. */
  videoDir?: string;
  /** Width in px to resize annotated screenshots to. Default 1280. */
  screenshotWidth?: number;
  /** config.readers — who the help site is written for; used to humanise a persona role id into
   * a reader-facing name in "Before you start" (see `readerNameForRole` in content.ts). */
  readers?: string[];
  /** config.roles — role id -> reader-facing name, tried before `readers` (see `readerNameForRole`). */
  roles?: Record<string, string | { name: string }>;
  /** Where print figures (`printFigures`) are written. Default `<captureDir>/print` — build
   * output that is never staged into the help app. */
  printDir?: string;
}

/** One generated block the rebuild found a human edit in, instead of overwriting. */
export interface PageSuggestion {
  /** The marker key, e.g. "step-3" or "good-to-know". */
  key: string;
  /** What changed, in short, for an agent or a PR comment to act on. */
  message: string;
  /** The content aida would have written, had the block not been human-edited. */
  suggested: string;
}

export interface BuildPageResult {
  id: string;
  outDir: string;
  /** `<outDir>/<id>/index.mdx` — MDX-safe Markdown with generated-block markers. */
  indexFile: string;
  /** `<outDir>/<id>/index.plain.md` — same content with aida markers stripped, for llms.txt. */
  plainFile: string;
  screenshotsDir: string;
  screenshots: string[];
  /** Every step captured and checked out ok (false if capture validation failed or is missing). */
  passed: boolean;
  /** passed && no un-pinned problems — whether this page may be published. */
  publishable: boolean;
  /** ISO timestamp from the capture validation this page was built against, if any. */
  lastChecked?: string;
  /** Clear, human-readable reasons the page isn't publishable. Empty when publishable. */
  problems: string[];
  /** Generated blocks that had human edits since the last build, left untouched. */
  suggestions: PageSuggestion[];
  /** One print figure per captured step (decision 36), for the PDFs. Absent on pages built
   * before M32 — the PDFs then fall back to the site screenshots. */
  printFigures?: PrintFigure[];
  /** Screenshots of the other ways' opening steps (decision 34), `screenshots/paths/<id>-step-NN.png`.
   * Kept apart from `screenshots`, which is the main steps only. */
  pathScreenshots?: string[];
  /** Print figures for each path's opening steps, by path id; `step` is the path's own step number. */
  pathFigures?: Record<string, PrintFigure[]>;
}

type FigureBox = { x: number; y: number; w: number; h: number };

/** A step's screenshot prepared for print: clean images (blur burned in, no dimming, no
 * highlight chrome — print draws its own ring and number over them) plus where the target is. */
export interface PrintFigure {
  /** 1-based step number. */
  step: number;
  /** Absolute path: the full screen at one pixel per CSS px. */
  full: string;
  /** Absolute path: the focus crop around the target at device scale, when there is one. */
  crop?: string;
  /** The crop's rectangle in the frame's CSS px. */
  cropBox?: FigureBox;
  /** The frame's size in CSS px (the capture viewport). */
  viewport: { width: number; height: number };
  /** Boxes to ring, in the frame's CSS px. */
  targets: FigureBox[];
  /** User callouts (M22) to pin, in the frame's CSS px, in order. */
  callouts: { box: FigureBox; label?: string }[];
  /** A screen the reader hasn't seen yet in this guide (first step, or the route changed). */
  newScreen: boolean;
}
