import type { Target, Box } from "./target.js";
import type { Action } from "./action.js";

export type { Target, Highlight, Box } from "./target.js";
export type { Action } from "./action.js";

export interface Viewport {
  width: number;
  height: number;
}

export interface Persona {
  role?: string;
  name?: string;
  email?: string;
  cognitoSub?: string;
}

/** Where and as whom the walkthrough starts. The original pipeline's `environment`. */
export interface Start {
  /** Shorthand for persona.role, e.g. "office-staff". */
  signed_in_as?: string;
  /** Path to start on, e.g. "/competitors". The original pipeline's startPath. */
  page?: string;
  baseUrl?: string;
  viewport?: Viewport;
  deviceScaleFactor?: number;
  show?: string;
  notes?: string;
  /** Full persona, when signed_in_as alone isn't enough. */
  persona?: Persona;
}

export interface VerifiedAgainst {
  app?: string;
  routes?: string[];
  sources?: string[];
}

export interface VoiceConfig {
  provider?: string;
  model?: string;
  voiceId?: string;
  speed?: number;
  gapSeconds?: number;
}

export interface TitleCard {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  /** Spoken narration, written as it should sound. */
  say?: string;
  /** On-screen caption, written as it should be read. */
  caption?: string;
  recap?: string[];
}

export type Camera =
  | "full"
  | { focus: Target; zoom?: number; align?: "top" | "right" | "left" };

export interface DatabaseCheck {
  name: string;
  sql: string;
  params?: string[];
  expect: Record<string, unknown>;
}

export interface Validate {
  database?: DatabaseCheck[];
}

/**
 * A numbered callout drawn on a step's screenshot and video frames (M22). Pinned to `target`
 * (resolved to a box from the capture manifest, so it follows the element when the layout
 * moves) or, when there's no element to pin to, a fixed `box` in viewport CSS-px — the same
 * coordinate space `boxOf`/highlight boxes already use. Exactly one of `target`/`box` is set
 * (enforced by the schema). `id` is stable across edits (Studio add/reorder/delete) and is what
 * the capture manifest keys its resolved box by.
 */
export interface Callout {
  id: string;
  target?: Target;
  box?: Box;
  /** Short label text shown in the page/video legend next to the callout's number. */
  label?: string;
}

/** A box to blur (burn in, not a CSS overlay) on a step's screenshot and video frames — for
 * hiding personal data. Same target-or-box pinning as `Callout`, no label. */
export interface BlurBox {
  id: string;
  target?: Target;
  box?: Box;
}

/** One step of a walkthrough: an action plus what it says, shows and checks. */
export interface Step {
  id?: string;
  /** Groups steps into chapters, used for video chapter marks. */
  chapter?: string;
  title?: string;
  /** Spoken narration for this step. */
  say?: string;
  /** On-screen caption for this step's clip. */
  caption?: string;
  /** Markdown for the printed/site guide. The original pipeline's `doc`. */
  page_text?: string;
  /** Field names to mask in screenshots/video for this step. */
  mask?: string[];
  camera?: Camera;
  /** Seconds to hold on the step's final state, for pacing. */
  hold?: number;
  /** Numbered callouts drawn on this step's screenshot/video — see `Callout`. */
  callouts?: Callout[];
  /** Boxes blurred (burned in) on this step's screenshot/video — see `BlurBox`. */
  blur?: BlurBox[];
  /** The fully resolved action list — from `do:`, `check:` and/or `actions:`. */
  actions: Action[];
}

/**
 * Unrecorded steps run before capture starts (decision 28): the same step/action grammar as
 * `steps`, but no frames and no narration. For data this one walkthrough needs that no other
 * walkthrough leaves, e.g. a second competitor to pick from.
 */
export interface WalkthroughSetup {
  /** Role to sign in as for these steps (a separate browser session). Default: the walkthrough's own persona. */
  as?: string;
  steps: Step[];
}

/** Where another way in starts: its own page, as the walkthrough's own persona. */
export interface PathStart {
  page: string;
  /** May only repeat the walkthrough's own role (validate rejects anything else). The persona
   * itself is always the walkthrough's `start.persona`. */
  signed_in_as?: string;
}

/**
 * Another way to do the same task (decision 34): e.g. recording a payment from the attendee's page
 * instead of the booking. Its own start and opening `steps`, then the walkthrough's main steps from
 * the one named by `joins` to the end. Captured on its own from the same starting data.
 */
export interface WalkthroughPath {
  /** kebab-case, unique in the walkthrough, e.g. "from-attendee". */
  id: string;
  /** Reader-facing, e.g. "From the attendee's page". */
  title: string;
  /** One plain sentence: when to use this way. */
  when: string;
  start: PathStart;
  /** The opening steps, before the path joins the main steps. Same step schema. */
  steps: Step[];
  /** Id of the main step where this path joins the shared rest. */
  joins: string;
  /** Written by the writer when capture flags that this path saves differently (pathDiffs). */
  note?: string;
}

/** A task a user does, replayed against the real app. The single source of truth. */
export interface Walkthrough {
  /** Slug id, e.g. "add-competitor". */
  walkthrough: string;
  version?: number;
  title: string;
  summary?: string;
  product?: string;
  /** Audience/reader, e.g. "office-staff". */
  for?: string;
  /** Where the page sits in the help library, e.g. "Payments", "Getting started" or
   * "Entries / Late entries" — see placement.ts `libraryPlacement`. Default: "How do I…". */
  section?: string;
  verifiedAgainst?: VerifiedAgainst;
  start?: Start;
  /** Values steps reference as {{path}}. `run` is reserved for run-unique values (`{{run.id}}`). */
  data?: Record<string, unknown>;
  /** Named data states (kebab-case) that must hold before step 1 — see `states/order.ts`. */
  needs?: string[];
  /** States true once this walkthrough succeeds. */
  leaves?: string[];
  /** States no longer true once it has run (e.g. it removed Alex from the morning block). */
  clears?: string[];
  /** Unrecorded steps run before capture starts. */
  setup?: WalkthroughSetup;
  voice?: VoiceConfig;
  intro?: TitleCard;
  outro?: TitleCard;
  steps: Step[];
  validate?: Validate;
  /** Other ways to do this task, each sharing the main steps from its `joins` step on. */
  paths?: WalkthroughPath[];
}
