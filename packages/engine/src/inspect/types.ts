/** Options `runInspect` needs beyond the already-open Playwright `Page` (see ./snapshot.ts and
 * ../commands/inspect.ts, which owns opening/signing in the page). */
export interface InspectScanOptions {
  /** Scopes the scan to this CSS selector or ARIA landmark role name (main, navigation, banner,
   * contentinfo, complementary, form, region, dialog) instead of the default main-landmark/open-
   * dialog scope. */
  area?: string;
  /** Hard cap on printed lines (after option/line trimming). Default 80. */
  lineCap?: number;
  /** Cap on native `<select>` options listed before "+N more". Default 15. */
  optionCap?: number;
}

/** What `--click`/`--check` did before the scan ran, reported alongside the snapshot so an
 * author (or agent) can see what actually happened without re-reading the page itself. */
export interface ClickOutcome {
  /** A `role=dialog`/`alertdialog` became visible within ~1s of the click. */
  dialogOpened: boolean;
  /** A non-GET request fired (and was aborted at the network layer — see commands/inspect.ts,
   * which blocks every non-GET request for the duration of an inspect scan) within ~1s of the
   * click. Never means a write actually happened: it never can, during inspect. */
  blockedWrite: boolean;
  /** Set when `--click`'s name looks write-shaped by name alone (e.g. contains "save"/"submit")
   * — informational only: the network-level block means a write can never actually leave the
   * browser, so this is a heads-up, not a refusal. */
  warning?: string;
  /** A custom combobox/listbox's option texts, printed once after `--click` opens it (capped at
   * 15, same cap as a native `<select>`'s options) — then the listbox is closed again with
   * Escape, same as a native `<select>` is never left open. `undefined` when the click didn't
   * open a listbox (e.g. a plain dialog opener). */
  listboxOptions?: string[];
  /** True when `listboxOptions` was capped — more options existed than were printed. */
  listboxTruncated?: boolean;
}

/** What `aida inspect` prints: one compact, redacted accessibility-tree-shaped block of text
 * (role/name/attributes, exactly as Playwright's own accessible-name/role computation sees the
 * page — see format.ts), plus the handful of facts the CLI reports alongside it. */
export interface InspectResult {
  url: string;
  area?: string;
  /** The formatted, redacted, line-capped snapshot text. */
  snapshot: string;
  lineCount: number;
  truncated: boolean;
  /** Present when `--click` was used: the last click's outcome. */
  click?: ClickOutcome;
  /** Every click's outcome, in order, when `--click` was given more than once. */
  clicks?: (ClickOutcome & { name: string })[];
  /** Present with `--walkthrough ... --after <step>`: the page this scan saw is the one that step left. */
  after?: { walkthrough: string; step: string; /** Set for `--after <pathId>/<stepId>`. */ path?: string };
}
