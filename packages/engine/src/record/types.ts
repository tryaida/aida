import type { Target } from "../walkthrough/index.js";

/**
 * What the in-page recorder (page-script.ts) knows about an element when it sends an event: a
 * marker attribute (`data-aida-rec`) that lets Node find the very element again while it's still
 * on screen, plus enough of the element's own words to build a target from if it isn't (a click
 * that navigated away before Node could look).
 */
export interface ElementInfo {
  /** Value of the `data-aida-rec` attribute put on the element. */
  marker: string;
  tag: string;
  /** `type` attribute of an `<input>`/`<button>`. */
  type?: string;
  /** Explicit `role` attribute. */
  role?: string;
  /** Best-effort role from the tag, when there's no explicit one (`button`, `link`, `textbox`...). */
  implicitRole?: string;
  /** Best-effort accessible name: aria-label, aria-labelledby, label, alt, title, own text. */
  name?: string;
  /** A `<label>`'s own direct text, for a form control. */
  labelDirect?: string;
  /** A `<label>`'s full text, with any control it wraps removed. */
  labelFull?: string;
  placeholder?: string;
  /** The element's visible text, trimmed and capped. */
  text?: string;
  /** A CSS selector that matched only this element when it was recorded. Last resort. */
  css?: string;
  /** Markers put on the nearest named containers (dialog, group, region, form, row...), nearest
   * first, for scoping a target that matches more than one element. */
  containers?: { marker: string; role?: string; name?: string }[];
}

/** One message from the page to Node, through the `__aidaRecord` binding. */
export type PageMessage =
  | { kind: "hello" }
  | { kind: "hover"; el: ElementInfo }
  | { kind: "click"; el: ElementInfo; field: boolean }
  | { kind: "input"; el: ElementInfo; value: string; secret: boolean }
  | { kind: "select"; el: ElementInfo; option: string }
  | { kind: "point" | "expect"; el: ElementInfo }
  | { kind: "file"; el: ElementInfo }
  | { kind: "submit"; submitter?: ElementInfo }
  /** A key or chord in Playwright's names ("Enter", "Escape", "Control+k"); `el` is the field
   * it was pressed in, sent for Enter only (a global shortcut or Escape goes to whatever has focus). */
  | { kind: "key"; key: string; el?: ElementInfo }
  | { kind: "note"; text: string }
  | { kind: "step"; title?: string }
  | { kind: "undo" }
  | { kind: "finish" };

/** What Node sends back, so the toolbar can say what it just heard. */
export interface RecorderStatus {
  actions: number;
  last?: string;
  finished?: boolean;
}

/** A target worked out for a recorded element. */
export interface ResolvedTarget {
  target: Target;
  /** True when `locate()` — the same resolver capture uses — found this very element with it. */
  verified: boolean;
  /** The element's role as Playwright's accessibility tree reports it (or the page's estimate). */
  role?: string;
  /** Short words for the element, for titles and narration placeholders. */
  words: string;
}

/**
 * One thing the person did, in order, with its target worked out. `steps.ts` turns a list of
 * these into walkthrough steps; nothing in it touches a browser.
 */
export type RecordedAction =
  | { kind: "click"; at: ResolvedTarget; field: boolean }
  | { kind: "type"; at: ResolvedTarget; text: string; secret: boolean }
  | { kind: "select"; at: ResolvedTarget; option: string }
  | { kind: "point"; at: ResolvedTarget }
  | { kind: "expect"; at: ResolvedTarget }
  /** A key press: Enter in a field, Escape, Tab or a shortcut. `at` is the field, for Enter. */
  | { kind: "press"; key: string; at?: ResolvedTarget }
  /** The page moved to `path`; `byAction` when something the person did caused it. */
  | { kind: "navigate"; path: string; byAction: boolean }
  /** The person's own words for the step they just did. */
  | { kind: "note"; text: string }
  /** Start a new step here, optionally titled. */
  | { kind: "step"; title?: string }
  /** Something the recording couldn't turn into an action; kept as a comment. */
  | { kind: "todo"; text: string };
