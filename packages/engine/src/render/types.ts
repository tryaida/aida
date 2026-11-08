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
  /** Step number drawn in the badge on the ring (M34: matches print's ring + number badge). */
  num?: number;
}

/** One element of a title card easing in (M34): `id` is the element's DOM id, `t0`/`d` when and
 * how long, `dy` how far it rises. In the timeline so player.js and state.ts's frameSignature
 * read the same schedule (each preset has its own). */
export interface TimelineReveal {
  id: string;
  t0: number;
  d: number;
  dy: number;
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
  colors?: {
    primary: string;
    accent: string;
    primaryForeground?: string;
    background?: string;
    foreground?: string;
    /** `primary` used as text in the player (minimal's chip number, friendly's eyebrow) —
     * render/brand.ts's `timelineBrand` prefers `videoTextColors`' style-specific value (checked
     * against `paper`/`chip`, the actual surfaces) over the artifact-wide `primaryText`, which is
     * only checked against `background`. */
    primaryText?: string;
    /** Caption/chip/title colours (render/brand.ts's `videoTextColors`, decision 39): the dark
     * canvas (bold) or light one (minimal/friendly), and the text colours already verified
     * >= 4.5:1 against it, so player.css paints these rather than deriving them with
     * `color-mix()`. */
    night?: string;
    night2?: string;
    paper?: string;
    /** Friendly's caption chip background, already verified safe for `ink` on top of it. */
    chip?: string;
    ink?: string;
    ink2?: string;
    ink3?: string;
  };
  font?: string;
  headingFont?: string;
  /** https stylesheet the player loads (capped wait) before the first frame. */
  fontUrl?: string;
  /** data: URL of the logo for light backgrounds (the minimal/friendly cards). */
  logoLightSrc?: string;
  /** House style preset (theme/style.ts). Unset: `bold`. Static styling only. */
  style?: "minimal" | "friendly" | "bold";
  /** `brand.md`'s tagline, under the outro. */
  tagline?: string;
  /** The app's corner radius in px (0-24), for the caption box and frame. */
  radius?: number;
  /** The logo is a wordmark that already spells the name: the cards show it without the name. */
  logoWide?: boolean;
}

export interface Timeline {
  fps: number;
  viewport: { w: number; h: number };
  /** The output frame's pixel size (M43c). Desktop is exactly `{ w: 1920, h: 1080 }` (unset ->
   * player.js/video.ts fall back to that, so an older timeline plays exactly as before); a phone
   * walkthrough's own video is portrait `{ w: 1080, h: 1920 }` (`devices/index.ts`'s
   * `DEFAULT_PHONE_SETTINGS` reader, not `viewport` — `viewport` stays the *capture* size). */
  frame?: { w: number; h: number };
  stage: { x: number; y: number; w: number; h: number };
  /** Caption/chip band rectangle (M43c). Unset -> player.css's own fixed desktop position (its
   * long-standing `top: 970px; height: 100px`, left/width still read from `stage` as before) —
   * so an older (desktop) timeline renders pixel-identically without this field. `buildTimeline`
   * always sets it from M43c on, landscape included, with those exact numbers. */
  band?: { x: number; y: number; w: number; h: number };
  /** "mouse" (an arrow cursor, the default) or "touch" (a soft tap circle — M43c, phone videos):
   * which pointer player.js draws. Unset -> "mouse", so an older timeline is unaffected. */
  pointer?: "mouse" | "touch";
  fade: number;
  brand: TimelineBrand;
  intro: {
    eyebrow: string;
    titleHtml: string;
    subtitle: string;
    /** Who the guide is for (the walkthrough's `for:`), M34. */
    reader?: string;
    /** Short facts shown on the card, e.g. "3 steps". */
    facts?: string[];
  };
  outro: {
    title: string;
    recap: string[];
    /** "Find this guide at <site>" when `publish.siteUrl` is set (M34). */
    site?: string;
  };
  /** Title-card reveal schedules (M34). Optional for hand-built fixtures: player.js and
   * state.ts fall back to the original fixed schedule. */
  cards?: { intro: TimelineReveal[]; outro: TimelineReveal[] };
  /** Browser-chrome bar height above the stage in px (0 = plain frame), M34. */
  chrome?: number;
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
  /** Push the camera in toward each step's target (M34). Default true; steps with their own
   * `camera: { focus }` keep it. */
  zoomToTarget?: boolean;
  /** config.lang (BCP-47, e.g. "en"), for the mp4's audio/subtitle stream language tags (M42a).
   * Default "en". */
  lang?: string;
  /** Which device this render is for (M43c, decision 40) — picks the output frame (desktop:
   * 1920x1080 landscape; phone: 1080x1920 portrait), the pointer (mouse vs. a touch tap circle)
   * and whether a browser-chrome bar can show at all (never on phone). Default "desktop". */
  device?: import("../walkthrough/types.js").Device;
  /** Appended before the extension on every output file: `""` (default, today's plain
   * `<id>.mp4`) for a walkthrough's primary device; `".phone"` for a secondary phone video
   * (`<id>.phone.mp4` + `.phone.srt`/`.phone.vtt`/`.phone.chapters.vtt`/`.phone.transcript.md`). */
  fileSuffix?: string;
  /** Render each walkthrough path's short clip too (decision 34/37). Default true; the pipeline
   * sets this false for a secondary device's render — paths are captured on the primary device
   * only (pipeline.ts), so there's nothing of this device's own to clip. */
  pathClips?: boolean;
  /** Whole-walkthrough step numbers for a device-filtered walkthrough (decision 40): `numbers[i]`
   * is the 1-based position in the unfiltered walkthrough of `written.steps[i]`, `total` its step
   * count. Chips, chapters, highlight badges and transcript headings then match the page's
   * numbering. Omitted (or identity): numbered by position, exactly as before. */
  stepNumbering?: { numbers: number[]; total: number };
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
  /** One short clip per walkthrough path (M35), rendered or not (with the reason). */
  clips?: PathClipResult[];
}

/** One path's short clip (M35): `<id>.path-<pathId>.mp4` + captions next to the main video. */
export interface PathClipResult {
  pathId: string;
  mp4?: string;
  srt?: string;
  vtt?: string;
  /** `<id>.path-<pathId>.transcript.md` (M42a). */
  transcript?: string;
  timelineJson?: string;
  durationSec?: number;
  /** True when the clip was unchanged (hash matched) or not rendered (see `notRendered`). */
  skipped: boolean;
  /** Why there's no clip for this path (its capture didn't pass, no narration yet, ...). */
  notRendered?: string;
  /** The main step the path joins and where its chapter starts in the main video (seconds). */
  continueAt?: { step: number; stepId?: string; title?: string; t?: number };
}
