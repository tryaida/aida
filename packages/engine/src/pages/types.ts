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
}
