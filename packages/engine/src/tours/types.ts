// The tour file the help app serves at `/tours/<id>.json` and `public/tour.js` reads (M46). Small
// and versioned: a reader's browser fetches it when a tour starts.
import type { ElementHints } from "../capture/types.js";

export type TourActionKind = "click" | "type" | "select" | "press" | "hover" | "focus" | "point";

/** How the tour knows the reader did the action: a click on the element, a `change` (or a blur
 * after typing) on a field, or the reader pressing Next. */
export type TourAdvance = "click" | "change" | "manual";

export interface TourAction {
  kind: TourActionKind;
  /** How tour.js finds the element: capture's hints (capture/hints.ts). */
  target: ElementHints;
  /** The walkthrough's demo value, shown as an example; never entered by the tour. Absent for a
   * masked or secret-looking field, and for anything redaction would change. */
  example?: string;
  advance: TourAdvance;
  /** The screen this action happens on, when it isn't the step's (an earlier action in the step
   * moved to another page). Relative to the app's base path, like `TourStep.screen`. */
  screen?: string;
}

export interface TourStep {
  /** The walkthrough step's id: what tour.js saves to resume on another page, so a tour file that
   * changed in between never resumes on the wrong step. */
  id: string;
  title: string;
  /** The step's instruction as plain text, `{{data}}` resolved (walkthrough/display.ts). */
  text: string;
  /** Screen pattern (routes/pattern.ts) the step starts on, relative to the app's base path.
   * tour.js points at an element only while the reader's path matches it. */
  screen: string;
  /** Empty for a read-and-continue step (checks only, a shown email). */
  actions: TourAction[];
}

/** The tour file's shape. tour.js refuses any other version and offers the full guide instead. */
export const TOUR_VERSION = 2;

export interface Tour {
  version: typeof TOUR_VERSION;
  id: string;
  title: string;
  /** The guide's site-relative URL on the help site, e.g. "/how-do-i/add-a-thing". */
  guideUrl: string;
  start: {
    /** App path the walkthrough starts on, relative to the app's base path. tour.js links to it
     * only when `pattern` has no `*`. */
    path: string;
    pattern: string;
  };
  steps: TourStep[];
}

export interface TourSkip {
  id: string;
  reason: string;
}

export interface BuildToursResult {
  /** Ids whose tour file this run wrote. */
  written: string[];
  /** Walkthroughs this run considered that got no tour, and why. */
  skipped: TourSkip[];
  /** Every tour on disk after this run (written now or kept from an earlier scoped build), sorted:
   * the ids to hand the help map. */
  ids: string[];
}
