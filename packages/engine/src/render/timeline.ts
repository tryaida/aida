// Port of the original pipeline's compose.mjs timeline math (lines ~36-183), generalised
// off its one app and typed. Step length = max(narration + gap, actions); intro/outro cards; chapters
// per step; `hold` (on a step, or a `hold` capture event) is respected.
import type { Walkthrough, Step } from "../walkthrough/types.js";
import type { CaptureManifest } from "../capture/index.js";
import type {
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
}

/** Builds the deterministic Timeline the player renders, from a Walkthrough + its capture + narration. */
export function buildTimeline(
  wf: Walkthrough,
  manifest: CaptureManifest,
  narration: Record<string, NarrationBeat>,
  opts: BuildTimelineOptions,
): Timeline {
  const FPS = opts.fps;
  const frameSrc = opts.frameSrc ?? ((f: string) => `../capture/frames/${f}`);
  const VW = manifest.viewport.width;
  const VH = manifest.viewport.height;
  const FULL: CameraFrame = { z: 1, cx: VW / 2, cy: VH / 2 };
  const gapSeconds = wf.voice?.gapSeconds ?? 0.45;

  const tl: Timeline = {
    fps: FPS,
    viewport: { w: VW, h: VH },
    stage: { x: 132, y: 24, w: 1656, h: 931.5 },
    fade: T.fade,
    brand: timelineBrand(opts.brand, wf.product),
    intro: {
      eyebrow: wf.intro?.eyebrow ?? "How to",
      titleHtml: escapeHtml(wf.intro?.title ?? wf.title),
      subtitle: wf.intro?.subtitle ?? "",
    },
    outro: { title: wf.outro?.title ?? "", recap: wf.outro?.recap ?? [] },
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
    const introEnd = Math.max(5.5, 0.7 + d + 1.0);
    tl.audio.push({ id: "intro", file: introBeat.audioPath, t: 0.7 });
    tl.captions.push({ t0: 0.7, t1: 0.7 + d + 0.3, text: wf.intro?.caption ?? wf.intro?.say ?? "" });
    tl.stageIn = { t0: introEnd - 0.85, t1: introEnd };
    t = introEnd;
    scenes.push({ id: "intro", t0: 0, t1: introEnd });
  }

  let cursor: Point = { ...tl.cursorStart };
  let camera: CameraFrame = { ...FULL };
  let hiOpen: TimelineHighlight | null = null;
  const closeHi = (at: number) => {
    if (hiOpen) {
      hiOpen.t1 = Math.max(hiOpen.t0 + 0.4, at);
      hiOpen = null;
    }
  };

  const stepById = new Map(manifest.steps.map((s) => [s.id, s]));

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
    tl.cameras.push({ t0: stepStart, t1: stepStart + T.camera, from: { ...camera }, to: target });
    camera = target;

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
      eyebrow: `Part ${tl.chapters.indexOf(step.chapter ?? "") + 1} · ${step.chapter ?? ""}`,
      title: step.title ?? "",
    });

    t += T.lead + share(W.lead);
    for (const e of cap.events) {
      switch (e.type) {
        case "frame":
          if (e.transition === "fade") {
            tl.frames.push({ t, src: frameSrc(e.image), transition: "fade" });
            t += T.fade;
          } else {
            tl.frames.push({ t, src: frameSrc(e.image), transition: "cut" });
          }
          break;
        case "move": {
          const dur = moveTime(cursor, e.to);
          tl.moves.push({ t0: t, t1: t + dur, from: { ...cursor }, to: { ...e.to } });
          cursor = { ...e.to };
          t += dur;
          break;
        }
        case "click":
          tl.clicks.push({ t, x: e.at.x, y: e.at.y });
          t += T.click + T.afterClick;
          break;
        case "highlight":
          closeHi(t);
          hiOpen = { t0: t, t1: Infinity, box: e.box };
          tl.highlights.push(hiOpen);
          break;
        case "clearHighlight":
          closeHi(t - T.afterClick + 0.15);
          break;
        case "typeFrames":
          for (const img of e.images) {
            tl.frames.push({ t, src: frameSrc(img), transition: "cut" });
            t += T.char;
          }
          break;
        case "scrollFrames":
          for (const img of e.images) {
            tl.frames.push({ t, src: frameSrc(img), transition: "cut" });
            t += T.scroll;
          }
          break;
        case "hold":
          t += e.seconds + share(W.hold);
          break;
      }
    }
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
    if (step.blur && step.blur.length > 0) {
      const resolved: Map<string, import("../capture/types.js").Box> = new Map(
        (cap.doc.blur ?? []).map((b) => [b.id, b.box] as const),
      );
      const boxes: import("../capture/types.js").Box[] = [];
      for (const b of step.blur) {
        const box = resolved.get(b.id);
        if (box) boxes.push(box);
      }
      if (boxes.length > 0) blurWindows.push({ t0: stepStart, t1: t, boxes });
    }
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
