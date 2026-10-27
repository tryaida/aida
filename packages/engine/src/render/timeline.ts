// Port of the original pipeline's compose.mjs timeline math (lines ~36-183), generalised
// off its one app and typed. Step length = max(narration + gap, actions); intro/outro cards; chapters
// per step; `hold` (on a step, or a `hold` capture event) is respected.
import type { Walkthrough, Step } from "../walkthrough/types.js";
import { displayWalkthrough } from "../walkthrough/display.js";
import type { CaptureManifest } from "../capture/index.js";
import { routePattern } from "../capture/path-files.js";
import type {
  Box,
  CameraFrame,
  NarrationBeat,
  Point,
  Timeline,
  TimelineBlurWindow,
  TimelineCalloutWindow,
  TimelineHighlight,
  TimelineScene,
} from "./types.js";
import { timelineBrand, type ArtifactBrand } from "./brand.js";

const T = {
  fade: 0.35,
  click: 0.22,
  afterClick: 0.45,
  char: 0.075,
  scroll: 0.055,
  lead: 0.5,
  tailMin: 0.7,
  voiceDelay: 0.3,
  camera: 0.95,
};

function moveTime(a: Point, b: Point): number {
  return Math.min(0.95, Math.max(0.42, 0.42 + Math.hypot(b.x - a.x, b.y - a.y) / 2400));
}

/** Beat ids in playback order: intro, each step, outro — must match voice's narration keys. */
export function beatIds(wf: Walkthrough): string[] {
  return ["intro", ...wf.steps.map((s) => requireStepId(s)), "outro"];
}

function requireStepId(s: Step): string {
  if (!s.id) throw new Error(`step "${s.title ?? "?"}" has no id — render needs one per step`);
  return s.id;
}

function beat(narration: Record<string, NarrationBeat>, id: string): NarrationBeat {
  const b = narration[id];
  if (!b) throw new Error(`narration for "${id}" is missing — run voice first`);
  return b;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);

export interface BuildTimelineOptions {
  fps: number;
  frameSrc?: (image: string) => string;
  /** `resolveArtifactBrand(config)` — colours, font and logo for the title cards etc. */
  brand?: ArtifactBrand;
  /** Push the camera in toward each step's target (default true). */
  zoomToTarget?: boolean;
  /** Blur boxes the task's other captures resolved (M35: main run + every path), unioned per
   * screen with this one's (`blurWindowsByScreen`). */
  sharedBlur?: RouteBlur;
  /** True when a step in another of the task's captures declares blur: no app screenshot on the
   * title cards (the cards show raw frames). */
  blurDeclaredElsewhere?: boolean;
  /** A path clip (M35): its shorter title card and the facts shown on it. */
  clip?: { introMinSeconds: number; facts: string[] };
}

type Style = "minimal" | "friendly" | "bold";

/** Per-preset motion (M34). `zoom` is the push-in toward a step's target; `dy`/`d`/`gap` shape
 * the title cards' reveal; `chrome` is the browser bar above the stage (bold only). */
export const STYLE_MOTION: Record<Style, { zoom: number; dy: number; d: number; gap: number; chrome: number }> = {
  minimal: { zoom: 1.16, dy: 14, d: 0.6, gap: 0.2, chrome: 0 },
  friendly: { zoom: 1.22, dy: 22, d: 0.7, gap: 0.22, chrome: 0 },
  bold: { zoom: 1.3, dy: 40, d: 0.7, gap: 0.25, chrome: 38 },
};

/** The stage rectangle: the 16:9 screenshot area inside the 1920x1080 frame, under an optional
 * browser bar, above the caption band. */
function stageFor(chrome: number): Timeline["stage"] {
  const top = 24 + chrome;
  const h = 931.5 - chrome;
  const w = (h * 16) / 9;
  return { x: Number(((1920 - w) / 2).toFixed(2)), y: top, w: Number(w.toFixed(2)), h };
}

/** `office-staff` -> `Office staff`; a phrase is kept as written. */
function readerLabel(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/\s/.test(v)) return v;
  const words = v.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function siteLabel(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/** The title cards' reveal schedule for a preset: brand row, eyebrow, title, subtitle, facts on
 * the intro; brand row, title, each recap row and the footer on the outro. */
export function cardReveals(style: Style, outroAt: number, recapRows: number, hero = false): NonNullable<Timeline["cards"]> {
  const m = STYLE_MOTION[style];
  const g = m.gap;
  const r = (id: string, t0: number, d = m.d, dy = m.dy) => ({ id, t0: Number(t0.toFixed(3)), d, dy });
  const intro = [
    ...(style === "friendly" ? [r("intro-panel", 0.05, 0.75, 30)] : []),
    r("intro-brand", 0.15),
    r("intro-eyebrow", 0.15 + g * 1.2),
    r("intro-title", 0.15 + g * 2, m.d + 0.1, m.dy * 1.4),
    r("intro-sub", 0.15 + g * 4),
    r("intro-facts", 0.15 + g * 5.6),
    ...(hero ? [r("intro-hero", 0.35, 1.0, 46)] : []),
  ];
  const o0 = outroAt + 0.35;
  const outro = [
    ...(style === "friendly" ? [r("outro-panel", outroAt + 0.2, 0.75, 30)] : []),
    r("outro-brand", o0 - 0.1),
    r("outro-title", o0, m.d, m.dy * 1.4),
    ...Array.from({ length: recapRows }, (_, i) => r(`recap-${i}`, o0 + 0.5 + i * 0.35, 0.6, Math.round(m.dy * 0.6))),
    r("outro-foot", o0 + 0.6 + recapRows * 0.35),
    ...(hero ? [r("outro-hero", o0 + 0.1, 1.0, 46)] : []),
  ];
  return { intro, outro };
}

/** A step's own `blur:` boxes as resolved this run (`cap.doc.blur`, keyed by id); an entry whose
 * target wasn't found this run has no manifest id and is skipped, never drawn stale. */
function resolvedBlur(step: Step, cap: CaptureManifest["steps"][number]): Box[] {
  if (!step.blur || step.blur.length === 0) return [];
  const resolved = new Map((cap.doc.blur ?? []).map((b) => [b.id, b.box] as const));
  const boxes: Box[] = [];
  for (const b of step.blur) {
    const box = resolved.get(b.id);
    if (box) boxes.push(box);
  }
  return boxes;
}

/** A URL as a screen key: its pathname as a route pattern, record ids as `:id`
 * (`/bookings/8f3a…/pay` -> `/bookings/:id/pay`; capture/path-files.ts `routePattern`), so the
 * main run and each path (every run with its own records) name the same screen the same way. */
function pathnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const pathname = new URL(url, "http://aida.invalid").pathname.replace(/\/+$/, "") || "/";
    return routePattern(pathname);
  } catch {
    return undefined;
  }
}

/**
 * True when two screen keys may be the same screen template: the same key, or the same depth
 * under the same first segment (`/bookings/spring-gala` and `/bookings/autumn-fair`: a record named
 * by a slug `routePattern` can't tell from a word). Used for boxes from another capture of the task,
 * whose records differ from this one's; over-blurring a sibling screen beats a leak.
 */
export function maySameScreen(a: string, b: string): boolean {
  if (a === b) return true;
  if (a === UNKNOWN_ROUTE || b === UNKNOWN_ROUTE) return false;
  const sa = a.split("/").filter(Boolean);
  const sb = b.split("/").filter(Boolean);
  return sa.length >= 2 && sa.length === sb.length && sa[0] === sb[0];
}

/** Which screens (route pathnames) each step's frames show, and which routes scroll: a step that
 * changes page belongs to both routes; with no route information a step is on `UNKNOWN_ROUTE`. */
export const UNKNOWN_ROUTE = "\u0000unknown";

function stepRoutes(
  wf: Pick<Walkthrough, "start" | "steps">,
  manifest: Pick<CaptureManifest, "steps">,
): { routesOf: string[][]; scrolled: Set<string> } {
  const byId = new Map(manifest.steps.map((s) => [s.id, s]));
  let route = pathnameOf(wf.start?.page) ?? UNKNOWN_ROUTE;
  const routesOf: string[][] = [];
  const scrolled = new Set<string>();
  wf.steps.forEach((step) => {
    const m = byId.get(step.id);
    const visited = (m?.impact?.urls ?? []).map(pathnameOf).filter((p): p is string => Boolean(p));
    const before = route;
    // A step's first known route also names the screen it started on when nothing earlier did.
    const routes = new Set<string>(before === UNKNOWN_ROUTE && visited.length > 0 ? [visited[0]] : [before]);
    for (const p of visited) routes.add(p);
    route = visited.length > 0 ? visited[visited.length - 1] : before;
    routesOf.push([...routes]);
    if (m?.events.some((e) => e.type === "scrollFrames")) for (const r of routes) scrolled.add(r);
  });
  return { routesOf, scrolled };
}

/** Blur boxes per screen from one or more captures (M35: the main run and every path's), before
 * any banding: `boxes` by route, and the routes on which any capture scrolled. */
export interface RouteBlur {
  boxes: Map<string, Box[]>;
  scrolled: Set<string>;
}

/** One capture's blur boxes by route: each step's own resolved `blur:` boxes on every route its
 * frames show. Merge several with `mergeRouteBlur`. */
export function routeBlurFor(
  wf: Pick<Walkthrough, "start" | "steps">,
  manifest: Pick<CaptureManifest, "steps">,
): RouteBlur {
  const { routesOf, scrolled } = stepRoutes(wf, manifest);
  const byId = new Map(manifest.steps.map((s) => [s.id, s]));
  const boxes = new Map<string, Box[]>();
  wf.steps.forEach((step, i) => {
    const cap = byId.get(step.id);
    const own = cap ? resolvedBlur(step, cap) : [];
    if (own.length === 0) return;
    for (const r of routesOf[i] ?? [UNKNOWN_ROUTE]) boxes.set(r, [...(boxes.get(r) ?? []), ...own]);
  });
  return { boxes, scrolled };
}

export function mergeRouteBlur(...all: (RouteBlur | undefined)[]): RouteBlur {
  const boxes = new Map<string, Box[]>();
  const scrolled = new Set<string>();
  for (const rb of all) {
    if (!rb) continue;
    for (const [r, b] of rb.boxes) boxes.set(r, [...(boxes.get(r) ?? []), ...b]);
    for (const r of rb.scrolled) scrolled.add(r);
  }
  return { boxes, scrolled };
}

/**
 * Blur windows per screen, not per step (privacy fix, M34). A step's boxes are resolved on its
 * own end state, but the same screen is on show before and after it: the previous step's frames,
 * the next step's frames until the page changes, the stage sliding in under the intro and out
 * under the outro, and the same page visited again later. So every step gets the union of the
 * boxes of every step on the same route — across all visits to it (from `impact.urls`, the way
 * pages/focus.ts reads them); a step that changes page belongs to both routes, since its frames
 * before the click still show the old one. Boxes are resolved at one scroll position, so on a
 * route where any step scrolls each box becomes a full-height band at its x (content moves
 * vertically under it). With no route information everything is one screen: over-blurring beats
 * a leak. The first window reaches back to 0 and the last on to the end, so no frame of the stage
 * is uncovered.
 *
 * `shared` (M35) adds the boxes other captures of the same task resolved — the main run's and
 * every path's — so a screen blurred in one video is blurred in all of them. A box from a step
 * whose screen isn't known (in `shared`) could be on any screen, so it's applied to every step.
 */
export function blurWindowsByScreen(
  wf: Pick<Walkthrough, "start" | "steps">,
  manifest: Pick<CaptureManifest, "steps"> & { viewport?: { width: number; height: number } },
  stepWindows: { t0: number; t1: number; boxes: Box[] }[],
  duration: number,
  shared?: RouteBlur,
): TimelineBlurWindow[] {
  const sharedHasBoxes = shared !== undefined && [...shared.boxes.values()].some((b) => b.length > 0);
  if (stepWindows.every((w) => w.boxes.length === 0) && !sharedHasBoxes) return [];
  const { routesOf, scrolled: ownScrolled } = stepRoutes(wf, manifest);
  const scrolledKeys = [...new Set([...ownScrolled, ...(shared?.scrolled ?? [])])];
  // A route scrolls when this capture or any other scrolled on it (or on a screen like it).
  const scrolls = (r: string) => scrolledKeys.some((k) => k === r || maySameScreen(k, r));
  const VH = manifest.viewport?.height ?? 100_000;
  const bands = (boxes: Box[]) => boxes.map((b) => ({ x: b.x, y: 0, w: b.w, h: VH }));
  const band = (r: string, boxes: Box[]) => (scrolls(r) ? bands(boxes) : boxes);
  const routeBoxes = new Map<string, Box[]>();
  stepWindows.forEach((w, i) => {
    for (const r of routesOf[i] ?? [UNKNOWN_ROUTE]) routeBoxes.set(r, [...(routeBoxes.get(r) ?? []), ...band(r, w.boxes)]);
  });
  // Other captures' boxes (their own records): matched to a screen by template, `maySameScreen`.
  const sharedEntries = [...(shared?.boxes ?? [])].filter(([r]) => r !== UNKNOWN_ROUTE);
  const sharedOn = (route: string): Box[] =>
    sharedEntries.filter(([r]) => maySameScreen(r, route)).flatMap(([r, boxes]) => (scrolls(route) || scrolls(r) ? bands(boxes) : boxes));
  // A step on a screen whose route isn't known could be showing any of them: it gets every box
  // (so with no route information at all, everything is one screen).
  const anywhere = shared?.boxes.get(UNKNOWN_ROUTE) ?? [];
  const everything = [...[...routeBoxes.values()].flat(), ...sharedEntries.flatMap(([r, b]) => band(r, b)), ...band(UNKNOWN_ROUTE, anywhere)];
  const windows: TimelineBlurWindow[] = [];
  stepWindows.forEach((w, i) => {
    const seen = new Set<string>();
    const boxes: Box[] = [];
    const routes = routesOf[i] ?? [UNKNOWN_ROUTE];
    const pool = routes.includes(UNKNOWN_ROUTE)
      ? everything
      : [...routes.flatMap((r) => routeBoxes.get(r) ?? []), ...routes.flatMap(sharedOn), ...routes.flatMap((r) => band(r, anywhere))];
    for (const b of pool) {
      const key = `${b.x},${b.y},${b.w},${b.h}`;
      if (!seen.has(key)) {
        seen.add(key);
        boxes.push(b);
      }
    }
    if (boxes.length === 0) return;
    const t0 = i === 0 ? 0 : w.t0;
    const t1 = i === stepWindows.length - 1 ? duration : w.t1;
    windows.push({ t0, t1, boxes });
  });
  return windows;
}

/** Builds the deterministic Timeline the player renders, from a Walkthrough + its capture + narration. */
export function buildTimeline(
  written: Walkthrough,
  manifest: CaptureManifest,
  narration: Record<string, NarrationBeat>,
  opts: BuildTimelineOptions,
): Timeline {
  // Captions, chips and cards show `{{data}}` filled in (M35).
  const wf = displayWalkthrough(written);
  const FPS = opts.fps;
  const frameSrc = opts.frameSrc ?? ((f: string) => `../capture/frames/${f}`);
  const VW = manifest.viewport.width;
  const VH = manifest.viewport.height;
  const FULL: CameraFrame = { z: 1, cx: VW / 2, cy: VH / 2 };
  const gapSeconds = wf.voice?.gapSeconds ?? 0.45;
  const style: Style = opts.brand?.style ?? "bold";
  const motion = STYLE_MOTION[style];
  const stepCount = wf.steps.length;
  const reader = readerLabel(wf.for);
  const site = siteLabel(opts.brand?.siteUrl);

  const tl: Timeline = {
    fps: FPS,
    viewport: { w: VW, h: VH },
    stage: stageFor(motion.chrome),
    chrome: motion.chrome,
    fade: T.fade,
    brand: timelineBrand(opts.brand, wf.product),
    intro: {
      eyebrow: wf.intro?.eyebrow ?? "How to",
      titleHtml: escapeHtml(wf.intro?.title ?? wf.title),
      subtitle: wf.intro?.subtitle ?? "",
      ...(reader ? { reader } : {}),
      facts: opts.clip?.facts ?? [`${stepCount} step${stepCount === 1 ? "" : "s"}`],
    },
    outro: { title: wf.outro?.title ?? "", recap: wf.outro?.recap ?? [], ...(site ? { site } : {}) },
    chapters: [...new Set(wf.steps.map((s) => s.chapter ?? ""))],
    frames: [],
    moves: [],
    clicks: [],
    highlights: [],
    callouts: [],
    blur: [],
    cameras: [],
    captions: [],
    chips: [],
    audio: [],
    cursorStart: { x: 900, y: 470 },
    stageIn: { t0: 0, t1: 0 },
    stageOut: { t0: 0, t1: 0 },
    duration: 0,
    previewAudio: "narration.m4a",
    scenes: [],
  };
  // Non-optional local aliases: these `Timeline` fields are optional only so hand-built fixtures
  // outside this module stay valid; `tl` above always sets them, so every push through them is safe.
  const scenes: TimelineScene[] = tl.scenes!;
  const calloutWindows: TimelineCalloutWindow[] = tl.callouts!;
  const blurWindows: TimelineBlurWindow[] = tl.blur!;

  let t = 0;

  // Intro card.
  {
    const introBeat = beat(narration, "intro");
    const d = introBeat.durationMs / 1000;
    const introEnd = Math.max(opts.clip?.introMinSeconds ?? 5.5, 0.7 + d + 1.0);
    tl.audio.push({ id: "intro", file: introBeat.audioPath, t: 0.7 });
    tl.captions.push({ t0: 0.7, t1: 0.7 + d + 0.3, text: wf.intro?.caption ?? wf.intro?.say ?? "" });
    tl.stageIn = { t0: introEnd - 0.85, t1: introEnd };
    t = introEnd;
    scenes.push({ id: "intro", t0: 0, t1: introEnd });
  }

  let cursor: Point = { ...tl.cursorStart };
  let camera: CameraFrame = { ...FULL };
  // End of the last camera move: a new one never starts before it (cameraAt reads the latest
  // move that has started, so an overlap would jump).
  let camEnd = 0;
  const pushCamera = (t0: number, d: number, to: CameraFrame) => {
    const start = Math.max(t0, camEnd);
    tl.cameras.push({ t0: start, t1: start + d, from: { ...camera }, to: { ...to } });
    camera = { ...to };
    camEnd = start + d;
  };
  /** The push-in toward a target box: the preset's zoom, less if the box wouldn't fit. */
  const zoomOn = (b: Box): CameraFrame | undefined => {
    const fit = Math.min((VW * 0.7) / Math.max(b.w, 1), (VH * 0.7) / Math.max(b.h, 1));
    const z = Math.min(motion.zoom, fit);
    if (z < 1.06) return undefined;
    return { z: Number(z.toFixed(3)), cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
  };
  const autoZoom = opts.zoomToTarget !== false;
  let hiOpen: TimelineHighlight | null = null;
  const closeHi = (at: number) => {
    if (hiOpen) {
      hiOpen.t1 = Math.max(hiOpen.t0 + 0.4, at);
      hiOpen = null;
    }
  };

  const stepById = new Map(manifest.steps.map((s) => [s.id, s]));
  // Each step's own window and its own resolved blur boxes; turned into per-screen windows once
  // every step is placed (see `blurWindowsByScreen`).
  const stepBlur: { t0: number; t1: number; boxes: import("../capture/types.js").Box[] }[] = [];

  wf.steps.forEach((step, si) => {
    const id = requireStepId(step);
    const cap = stepById.get(id);
    if (!cap) throw new Error(`capture is missing step ${id}`);
    const stepBeat = beat(narration, id);
    const d = stepBeat.durationMs / 1000;

    // Base duration of the step's actions, then spread any slack the narration needs.
    const holds = cap.events.filter((e) => e.type === "hold");
    let base = 0;
    let pos: Point = { ...cursor };
    for (const e of cap.events) {
      if (e.type === "move") {
        base += moveTime(pos, e.to);
        pos = e.to;
      } else if (e.type === "click") base += T.click + T.afterClick;
      else if (e.type === "frame" && e.transition === "fade") base += T.fade;
      else if (e.type === "typeFrames") base += e.images.length * T.char;
      else if (e.type === "scrollFrames") base += e.images.length * T.scroll;
      else if (e.type === "hold") base += e.seconds;
    }
    const need = T.voiceDelay + d + gapSeconds;
    const total = Math.max(T.lead + base + T.tailMin + (step.hold ?? 0), need);
    const slack = total - (T.lead + base + T.tailMin + (step.hold ?? 0));
    const W = { lead: 1, hold: 1.5, tail: 1.2 };
    const wsum = W.lead + W.tail + holds.length * W.hold;
    const share = (w: number) => (slack * w) / wsum;

    const stepStart = t;
    // Camera move to this step's framing.
    let target: CameraFrame = { ...FULL };
    const camSpec = step.camera;
    if (camSpec && camSpec !== "full" && cap.cameraBox) {
      const b = cap.cameraBox;
      const z = camSpec.zoom ?? 1.2;
      const align = camSpec.align ?? "";
      target = { z, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
      if (align.includes("top")) target.cy = b.y + VH / (2 * z);
      if (align.includes("right")) target.cx = VW;
      if (align.includes("left")) target.cx = 0;
      target.cx = Math.min(VW - VW / (2 * z), Math.max(VW / (2 * z), target.cx));
      target.cy = Math.min(VH - VH / (2 * z), Math.max(VH / (2 * z), target.cy));
    }
    pushCamera(stepStart, T.camera, target);
    const baseFrame: CameraFrame = { ...target };
    // Zoom to target (M34): steps framed full screen push in toward what they highlight, then
    // ease back out once the highlight clears. A step with its own `camera: { focus }` keeps it.
    const stepZooms = autoZoom && (!camSpec || camSpec === "full");
    let zoomed = false;
    let cleared = false;
    let moveStart: number | undefined;

    tl.audio.push({ id, file: stepBeat.audioPath, t: stepStart + T.voiceDelay });
    tl.captions.push({
      t0: stepStart + T.voiceDelay,
      t1: stepStart + T.voiceDelay + d + 0.3,
      text: step.caption ?? step.say ?? "",
    });
    tl.chips.push({
      t0: stepStart,
      t1: 0,
      num: String(si + 1),
      eyebrow:
        tl.chapters.length > 1
          ? `Part ${tl.chapters.indexOf(step.chapter ?? "") + 1} · ${step.chapter ?? ""}`
          : `Step ${si + 1} of ${stepCount}`,
      title: step.title ?? "",
    });

    t += T.lead + share(W.lead);
    cap.events.forEach((e) => {
      switch (e.type) {
        case "frame":
          // A new frame after the click (cut or fade): the screen changed under the push-in, so
          // pull back out to show it.
          if (zoomed && cleared) {
            pushCamera(t, 0.75, baseFrame);
            zoomed = false;
          }
          if (e.transition === "fade") {
            tl.frames.push({ t, src: frameSrc(e.image), transition: "fade" });
            t += T.fade;
          } else {
            tl.frames.push({ t, src: frameSrc(e.image), transition: "cut" });
          }
          break;
        case "move": {
          const dur = moveTime(cursor, e.to);
          moveStart = t;
          tl.moves.push({ t0: t, t1: t + dur, from: { ...cursor }, to: { ...e.to } });
          cursor = { ...e.to };
          t += dur;
          break;
        }
        case "click":
          tl.clicks.push({ t, x: e.at.x, y: e.at.y });
          t += T.click + T.afterClick;
          break;
        case "highlight": {
          // The ring (and its step badge) comes up as the pointer sets off toward the target, so
          // it's on screen long enough to read, not just for the instant before the click.
          const hiStart = moveStart !== undefined ? Math.min(moveStart, t) : t;
          closeHi(hiStart);
          hiOpen = { t0: hiStart, t1: Infinity, box: e.box, num: si + 1 };
          tl.highlights.push(hiOpen);
          // Push in as the pointer sets off toward the target, and hold through the click; the
          // next step's own camera move eases back out (or a page change does, above).
          const z = stepZooms ? zoomOn(e.box) : undefined;
          if (z) {
            pushCamera(hiStart, 0.9, z);
            zoomed = true;
            cleared = false;
          }
          moveStart = undefined;
          break;
        }
        case "clearHighlight":
          closeHi(t - T.afterClick + 0.15);
          cleared = true;
          break;
        case "typeFrames":
          for (const img of e.images) {
            tl.frames.push({ t, src: frameSrc(img), transition: "cut" });
            t += T.char;
          }
          break;
        case "scrollFrames":
          if (zoomed && cleared) {
            pushCamera(t, 0.75, baseFrame);
            zoomed = false;
          }
          for (const img of e.images) {
            tl.frames.push({ t, src: frameSrc(img), transition: "cut" });
            t += T.scroll;
          }
          break;
        case "hold":
          t += e.seconds + share(W.hold);
          break;
      }
    });
    t += T.tailMin + (step.hold ?? 0) + share(W.tail);
    closeHi(t - 0.15);
    tl.chips[tl.chips.length - 1].t1 = t;
    scenes.push({ id, t0: stepStart, t1: t });

    // Callouts/blur (M22): active for this step's whole on-screen window. Order and label text
    // come from the walkthrough's own `callouts:`/`blur:` list; the box each resolves to comes
    // from this run's manifest (`cap.doc.callouts`/`blur`), keyed by id — an entry whose target
    // wasn't found this run has no matching manifest id and is skipped, never drawn stale.
    if (step.callouts && step.callouts.length > 0) {
      const resolved: Map<string, import("../capture/types.js").Box> = new Map(
        (cap.doc.callouts ?? []).map((c) => [c.id, c.box] as const),
      );
      const items: TimelineCalloutWindow["items"] = [];
      step.callouts.forEach((c, i) => {
        const box = resolved.get(c.id);
        if (box) items.push({ box, num: i + 1, label: c.label });
      });
      if (items.length > 0) calloutWindows.push({ t0: stepStart, t1: t, items });
    }
    stepBlur.push({ t0: stepStart, t1: t, boxes: resolvedBlur(step, cap) });
  });

  // Outro card.
  const outroStart = t;
  {
    const outroBeat = beat(narration, "outro");
    const d = outroBeat.durationMs / 1000;
    tl.stageOut = { t0: t, t1: t + 0.9 };
    const at = t + 1.1;
    tl.audio.push({ id: "outro", file: outroBeat.audioPath, t: at });
    tl.captions.push({ t0: at, t1: at + d + 0.3, text: wf.outro?.caption ?? wf.outro?.say ?? "" });
    t = Math.max(at + d + 2.2, t + 0.35 + 0.5 + (wf.outro?.recap?.length ?? 0) * 0.35 + 3.5);
  }
  tl.duration = Number(t.toFixed(3));
  scenes.push({ id: "outro", t0: outroStart, t1: tl.duration });
  blurWindows.push(...blurWindowsByScreen(wf, manifest, stepBlur, tl.duration, opts.sharedBlur));
  // A screenshot of the app beside the title on the cards (minimal, bold) — only when no step
  // declares blur at all (resolved or not): the cards show raw frames, with no mosaic over them.
  const declaresBlur = Boolean(opts.blurDeclaredElsewhere) || wf.steps.some((st) => (st.blur?.length ?? 0) > 0);
  const hero = style !== "friendly" && !declaresBlur && blurWindows.length === 0 && tl.frames.length > 0;
  tl.cards = cardReveals(style, tl.stageOut.t0, tl.outro.recap.length, hero);

  // Keep captions from overlapping.
  tl.captions
    .sort((a, b) => a.t0 - b.t0)
    .forEach((c, i, all) => {
      if (all[i + 1]) c.t1 = Math.min(c.t1, all[i + 1].t0 - 0.05);
    });
  tl.highlights.forEach((h) => {
    if (!Number.isFinite(h.t1)) h.t1 = tl.stageOut.t0;
  });

  return tl;
}
