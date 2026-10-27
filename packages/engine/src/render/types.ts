// Timeline + render option/result types. The timeline is the deterministic, serializable
// intermediate the player (assets/player/*) renders frame-by-frame — it is the one thing
// both the Playwright renderer and a human opening index.html in a browser consume.

import type { Box, Point } from "../capture/index.js";
export type { Box, Point };

/** The player's pan/zoom state: `z` is zoom, `(cx, cy)` the centre in capture-viewport px. */
export interface CameraFrame {
  z: number;
  cx: number;
  cy: number;
}

export interface TimelineFrameCue {
  t: number;
  src: string;
  transition: "cut" | "fade";
}

export interface TimelineMove {
  t0: number;
  t1: number;
  from: Point;
  to: Point;
}

export interface TimelineClick {
  t: number;
  x: number;
  y: number;
}

export interface TimelineHighlight {
  t0: number;
  t1: number;
  box: Box;
}

/** One numbered, optionally-labelled callout box, active for a step's whole on-screen window
 * (M22) — unlike `TimelineHighlight`, several can be active at once (a step's `callouts:` list),
 * so they're grouped per window rather than one-at-a-time. */
export interface TimelineCalloutItem {
  box: Box;
  num: number;
  label?: string;
}

export interface TimelineCalloutWindow {
  t0: number;
  t1: number;
  items: TimelineCalloutItem[];
}

/** One blur box, active for a step's whole on-screen window. Burned into the frame the player
 * draws (CSS filter rasterised by the screenshot, same as pages/annotate.ts), never a removable
 * overlay. */
export interface TimelineBlurWindow {
  t0: number;
  t1: number;
  boxes: Box[];
}

export interface TimelineCamera {
  t0: number;
  t1: number;
  from: CameraFrame;
  to: CameraFrame;
}

export interface TimelineCaption {
  t0: number;
  t1: number;
  text: string;
}

export interface TimelineChip {
  t0: number;
  t1: number;
  num: string;
  eyebrow: string;
  title: string;
}

export interface TimelineAudioCue {
  id: string;
  file: string;
  t: number;
}

/** One playback scene (intro, a step, or outro) as a `[t0, t1)` slice of the full timeline's
 * time range. Scenes are rendered to their own segment and concatenated (docs/scope.md "Only
 * rebuild what changed": "A video re-renders only if one of its scenes changed"). `id` matches
 * `beatIds()` (intro, the step's id, or outro). */
export interface TimelineScene {
  id: string;
  t0: number;
  t1: number;
}

/** The brand the player paints title cards, the step chip, highlights and gradients with
 * (render/brand.ts's `timelineBrand`). Only `name` is required so hand-built fixtures stay valid;
 * the player falls back to a neutral look for anything missing. Never affects per-frame state
 * (state.ts) — only static styling set once at load. */
export interface TimelineBrand {
  name: string;
  /** data: URL of the logo shown on the dark intro/outro cards. */
  logoSrc?: string;
  /** True when `logoSrc` came from `logoDark` (made for dark backgrounds); otherwise the player
   * puts a light logo on a light tile if it would be too dark to read on the night canvas. */
  logoForDark?: boolean;
  colors?: { primary: string; accent: string; primaryForeground?: string };
  font?: string;
  headingFont?: string;
  /** https stylesheet the player loads (capped wait) before the first frame. */
  fontUrl?: string;
}

export interface Timeline {
  fps: number;
  viewport: { w: number; h: number };
  stage: { x: number; y: number; w: number; h: number };
  fade: number;
  brand: TimelineBrand;
  intro: { eyebrow: string; titleHtml: string; subtitle: string };
  outro: { title: string; recap: string[] };
  chapters: string[];
  frames: TimelineFrameCue[];
  moves: TimelineMove[];
  clicks: TimelineClick[];
  highlights: TimelineHighlight[];
  /** User-added numbered callouts (M22), one window per step that has any. Optional, like
   * `scenes`, so hand-built `Timeline` fixtures in tests outside render/** stay valid;
   * `buildTimeline()` always populates it. Render-side code should fall back to `[]`. */
  callouts?: TimelineCalloutWindow[];
  /** Burned-in blur boxes (M22), one window per step that has any. Same optionality as `callouts`. */
  blur?: TimelineBlurWindow[];
  cameras: TimelineCamera[];
  captions: TimelineCaption[];
  chips: TimelineChip[];
  audio: TimelineAudioCue[];
  cursorStart: Point;
  stageIn: { t0: number; t1: number };
  stageOut: { t0: number; t1: number };
  duration: number;
  previewAudio: string;
  /** Scene boundaries in playback order: intro, each step, outro. See `TimelineScene`.
   * Optional so existing hand-built `Timeline` fixtures in tests outside render/** stay valid;
   * `buildTimeline()` always populates it. Render-side code should fall back to `[]`. */
  scenes?: TimelineScene[];
}

/** Narration for one beat (intro, a step, or outro), already resolved to a file + length. */
export interface NarrationBeat {
  /** Absolute path, or a path relative to the voice dir the audio was synthesized into. */
  audioPath: string;
  durationMs: number;
}

export interface RenderQuality {
  fps: number;
  crf: number;
  preset: string;
  /** Playwright `deviceScaleFactor` against the player's fixed 1920x1080 CSS canvas — the knob
   * that gives draft its reduced output resolution (e.g. 0.5 -> 960x540) without touching
   * player layout. 1 for full quality. */
  deviceScaleFactor: number;
  /** JPEG quality (0-100) `page.screenshot()` encodes each frame at before it's piped into
   * ffmpeg (video.ts) — draft previews don't need the same fidelity a full render does, and a
   * lower quality is both a smaller buffer to pipe and (per Playwright) a little cheaper for
   * Chromium to encode. Default 95 (video.ts's long-standing value) when omitted, so existing
   * `RenderQuality` literals built by hand (tests, other callers) keep behaving exactly as
   * before. */
  screenshotQuality?: number;
}

export interface RenderOptions {
  /** Where to write `<id>/<id>.mp4` etc. */
  outDir: string;
  /** Capture dir containing manifest.json, validation.json and frames/. */
  captureDir: string;
  /** Narration beats keyed by beat id (intro, each step's id, outro). */
  narration: Record<string, NarrationBeat>;
  /** Lower fps/crf, ultrafast preset — for quick previews. Default false (full quality). */
  draft?: boolean;
  /** Override fps (otherwise draft ? 15 : 30). */
  fps?: number;
  /** Render these instants as stills instead of (or in addition to) the full video. */
  stills?: number[];
  /** Validation.json's ok must be true unless this is set. */
  force?: boolean;
  /** Re-render even if a matching .hash sidecar is found. */
  noCache?: boolean;
  /** Brand for the title cards, chip, highlights and gradients — `resolveArtifactBrand(config)`
   * (render/brand.ts). Omitted -> neutral look. */
  brand?: import("./brand.js").ArtifactBrand;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Browser pages to render scenes concurrently. Default `min(4, cpus/2)`. */
  concurrency?: number;
}

export interface RenderResult {
  id: string;
  outDir: string;
  mp4?: string;
  srt: string;
  vtt: string;
  chaptersVtt: string;
  timelineJson: string;
  stills: string[];
  durationSec: number;
  skipped: boolean;
  frames: number;
  wallTimeMs: number;
  /** Per-scene render report (docs/scope.md "Only rebuild what changed"): total scenes, how
   * many were actually rendered vs. reused from a matching cached segment. Absent when the
   * whole video was skipped (`skipped: true`) or only stills were requested. */
  scenesTotal?: number;
  scenesRendered?: number;
  scenesReused?: number;
}
