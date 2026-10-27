// M32 (decision 36): which frame a step's print figure shows, which boxes on it are real, when a
// screen is new to the reader, and the focus-crop geometry around the target.
import { describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep } from "../../src/capture/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import {
  CROP_CLASSES,
  CROP_REFINE,
  FOCUS_CROP,
  FRAME_DIFF,
  appearedRegion,
  cropClassFor,
  cropClassSize,
  edgeMap,
  focusCrop,
  normaliseCropClasses,
  placeCropClass,
  planStepFigures,
  refineCrop,
  targetCovered,
  tightenCropClass,
  type GrayFrame,
} from "../../src/pages/focus.js";

const VIEWPORT = { width: 1440, height: 810 };

describe("focusCrop", () => {
  it("returns nothing when there's no target and no click point", () => {
    expect(focusCrop([], VIEWPORT)).toBeUndefined();
  });

  it("gives a small target at least the minimum size, at the preferred aspect, containing it", () => {
    const target = { x: 700, y: 400, w: 100, h: 30 };
    const crop = focusCrop([target], VIEWPORT)!;
    expect(crop.w).toBe(FOCUS_CROP.minWidth);
    expect(crop.w / crop.h).toBeCloseTo(FOCUS_CROP.aspect, 1);
    expect(crop.x).toBeLessThanOrEqual(target.x);
    expect(crop.y).toBeLessThanOrEqual(target.y);
    expect(crop.x + crop.w).toBeGreaterThanOrEqual(target.x + target.w);
    expect(crop.y + crop.h).toBeGreaterThanOrEqual(target.y + target.h);
    // Centred on the target.
    expect(crop.x + crop.w / 2).toBeCloseTo(target.x + target.w / 2, 0);
  });

  it("keeps a crop near an edge inside the frame", () => {
    const crop = focusCrop([{ x: 1380, y: 5, w: 50, h: 30 }], VIEWPORT)!;
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBe(0);
    expect(crop.x + crop.w).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it("grows to fit several targets and holds the aspect range", () => {
    const crop = focusCrop([{ x: 400, y: 300, w: 60, h: 30 }, { x: 760, y: 320, w: 60, h: 30 }], VIEWPORT)!;
    expect(crop.x).toBeLessThanOrEqual(400 - FOCUS_CROP.pad);
    expect(crop.x + crop.w).toBeGreaterThanOrEqual(820 + FOCUS_CROP.pad);
    const aspect = crop.w / crop.h;
    expect(aspect).toBeGreaterThanOrEqual(FOCUS_CROP.minAspect);
    expect(aspect).toBeLessThanOrEqual(FOCUS_CROP.maxAspect);
  });

  it("gives up (full screen) when the target spans most of the screen", () => {
    expect(focusCrop([{ x: 300, y: 300, w: 1000, h: 50 }], VIEWPORT)).toBeUndefined();
    expect(focusCrop([{ x: 500, y: 50, w: 200, h: 600 }], VIEWPORT)).toBeUndefined();
  });

  it("uses a click point as a hint when there's no highlight, leaning right of the pointer", () => {
    const crop = focusCrop([], VIEWPORT, [{ x: 500, y: 400 }])!;
    expect(crop).toBeDefined();
    expect(crop.x).toBeLessThan(500);
    expect(crop.x + crop.w / 2).toBeGreaterThan(500);
  });

  it("returns whole pixels", () => {
    const crop = focusCrop([{ x: 333.3, y: 222.2, w: 77.7, h: 31.1 }], VIEWPORT)!;
    for (const v of Object.values(crop)) expect(Number.isInteger(v)).toBe(true);
  });
});

function step(over: Partial<ManifestStep>): ManifestStep {
  return {
    id: undefined,
    camera: "full",
    cameraBox: null,
    events: [],
    doc: { image: null, highlights: [] },
    impact: { urls: [], requests: [] },
    checks: [],
    ...over,
  };
}

const BUTTON = { x: 1200, y: 100, w: 150, h: 40 };
const FIELD = { x: 400, y: 300, w: 400, h: 40 };

function wf(steps: Partial<Walkthrough["steps"][number]>[] = []): Pick<Walkthrough, "start" | "steps"> {
  return { start: { page: "/orders" }, steps: steps.map((s, i) => ({ id: `s${i}`, actions: [], ...s })) };
}

describe("planStepFigures", () => {
  const manifest: Pick<CaptureManifest, "steps"> = {
    steps: [
      step({ events: [{ type: "frame", image: "01.png", transition: "cut" }], doc: { image: "01.png", highlights: [] } }),
      // Click "New order": the highlight was drawn on 02 (hover), then the click opened a new page.
      step({
        events: [
          { type: "frame", image: "02.png", transition: "cut" },
          { type: "highlight", box: BUTTON },
          { type: "click", at: { x: 1275, y: 120 } },
          { type: "frame", image: "03.png", transition: "fade" },
        ],
        doc: { image: "03.png", highlights: [BUTTON] },
        impact: { urls: ["/orders/new?from=list"], requests: [] },
      }),
      // On the new page: a field highlighted then filled, no navigation.
      step({
        events: [
          { type: "frame", image: "04.png", transition: "cut" },
          { type: "highlight", box: FIELD },
          { type: "click", at: { x: 600, y: 320 } },
          { type: "frame", image: "05.png", transition: "cut" },
        ],
        doc: { image: "05.png", highlights: [FIELD] },
      }),
      // Typed into a field with no highlight: the click point is the only hint.
      step({
        events: [
          { type: "frame", image: "06.png", transition: "cut" },
          { type: "click", at: { x: 500, y: 500 } },
          { type: "frame", image: "07.png", transition: "cut" },
        ],
        doc: { image: "07.png", highlights: [] },
      }),
    ],
  };

  it("shows the frame a target was highlighted on when the click then opened another page", () => {
    const plans = planStepFigures(wf([{}, {}, {}, {}]), manifest);
    expect(plans[1]).toMatchObject({ step: 2, frame: "02.png", targets: [BUTTON], docOverlays: false, newScreen: false });
  });

  it("marks the first step and the first step on a new route as new screens", () => {
    const plans = planStepFigures(wf([{}, {}, {}, {}]), manifest);
    expect(plans.map((p) => p.newScreen)).toEqual([true, false, true, false]);
  });

  it("keeps doc.image and its highlights for a step that stays on one page", () => {
    const plans = planStepFigures(wf([{}, {}, {}, {}]), manifest);
    expect(plans[2]).toMatchObject({ frame: "05.png", targets: [FIELD], points: [], docOverlays: true });
  });

  it("falls back to the last click point when a same-page step has no highlight", () => {
    const plans = planStepFigures(wf([{}, {}, {}, {}]), manifest);
    expect(plans[3]).toMatchObject({ frame: "07.png", targets: [], points: [{ x: 500, y: 500 }] });
  });

  it("never swaps frames for a step with blur boxes: keeps doc.image and drops the stale ring", () => {
    const plans = planStepFigures(wf([{}, { blur: [{ id: "b", box: { x: 0, y: 0, w: 10, h: 10 } }] }, {}, {}]), manifest);
    expect(plans[1]).toMatchObject({ frame: "03.png", targets: [], docOverlays: true });
  });

  // Review (privacy): the earlier frame can show what another step blurred — its blur boxes are
  // resolved on that step's own doc.image only, so nothing would cover it on the swapped frame.
  it("never swaps frames when any step in the walkthrough has blur boxes", () => {
    const plans = planStepFigures(wf([{ blur: [{ id: "b", box: { x: 0, y: 0, w: 10, h: 10 } }] }, {}, {}, {}]), manifest);
    expect(plans[1]).toMatchObject({ frame: "03.png", targets: [], docOverlays: true });
  });

  it("treats a query-string-only change as the same screen", () => {
    const m: Pick<CaptureManifest, "steps"> = {
      steps: [
        step({ events: [{ type: "frame", image: "01.png", transition: "cut" }], doc: { image: "01.png", highlights: [] } }),
        step({
          events: [{ type: "frame", image: "02.png", transition: "cut" }, { type: "highlight", box: BUTTON }, { type: "frame", image: "03.png", transition: "cut" }],
          doc: { image: "03.png", highlights: [BUTTON] },
          impact: { urls: ["/orders?status=open"], requests: [] },
        }),
      ],
    };
    const plans = planStepFigures(wf([{}, {}]), m);
    expect(plans[1]).toMatchObject({ frame: "03.png", targets: [BUTTON], newScreen: false });
  });

  it("skips steps with no image", () => {
    const m: Pick<CaptureManifest, "steps"> = { steps: [step({}), step({ doc: { image: "01.png", highlights: [] } })] };
    const plans = planStepFigures(wf([{}, {}]), m);
    expect(plans.map((p) => p.step)).toEqual([2]);
    expect(plans[0].newScreen).toBe(true);
  });
});

/** A synthetic screen: white, with filled rectangles (sidebar, panels, text-like stripes). */
function screen(w: number, h: number, rects: { x: number; y: number; w: number; h: number; v: number }[]) {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (const r of rects) {
    for (let y = r.y; y < Math.min(h, r.y + r.h); y++) {
      for (let x = r.x; x < Math.min(w, r.x + r.w); x++) {
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = r.v;
      }
    }
  }
  return edgeMap(data, w, h);
}

/** Text-like content: lines of dark text (solid stripes) filling a box. */
function textBlock(x: number, y: number, w: number, h: number) {
  const out: { x: number; y: number; w: number; h: number; v: number }[] = [];
  for (let yy = y; yy < y + h; yy += 12) out.push({ x, y: yy, w, h: 7, v: 40 });
  return out;
}

describe("refineCrop", () => {
  const TARGET = { x: 420, y: 300, w: 200, h: 40 };

  it("cuts off a sliver of a dark sidebar at the crop's edge", () => {
    const m = screen(1440, 810, [{ x: 0, y: 0, w: 240, h: 810, v: 20 }, ...textBlock(300, 150, 600, 400)]);
    const crop = refineCrop(m, { x: 200, y: 140, w: 700, h: 430 }, [TARGET]);
    expect(crop.x).toBeGreaterThanOrEqual(240);
    expect(crop.x).toBeLessThanOrEqual(TARGET.x - FOCUS_CROP.pad - CROP_REFINE.margin);
  });

  it("moves an edge that slices a neighbouring column of text onto the gutter beside it", () => {
    // Content column 300..900, a gap, then a second column 960..1300 the planned crop cuts into.
    const m = screen(1440, 810, [...textBlock(300, 150, 600, 400), ...textBlock(960, 150, 340, 400)]);
    const crop = refineCrop(m, { x: 280, y: 140, w: 740, h: 430 }, [TARGET]);
    const right = crop.x + crop.w;
    expect(right).toBeGreaterThan(895);
    expect(right).toBeLessThan(962);
  });

  it("always keeps the target and its margin inside", () => {
    const m = screen(1440, 810, textBlock(0, 0, 1440, 810));
    const crop = refineCrop(m, { x: 300, y: 200, w: 560, h: 350 }, [TARGET]);
    expect(crop.x).toBeLessThanOrEqual(TARGET.x - FOCUS_CROP.pad);
    expect(crop.y).toBeLessThanOrEqual(TARGET.y - FOCUS_CROP.pad);
    expect(crop.x + crop.w).toBeGreaterThanOrEqual(TARGET.x + TARGET.w + FOCUS_CROP.pad);
    expect(crop.y + crop.h).toBeGreaterThanOrEqual(TARGET.y + TARGET.h + FOCUS_CROP.pad);
  });

  it("tightens a crop around a target in an empty area and centres it", () => {
    const button = { x: 1000, y: 600, w: 120, h: 40 };
    const m = screen(1440, 810, [{ ...button, v: 60 }]);
    const planned = focusCrop([button], { width: 1440, height: 810 })!;
    const crop = refineCrop(m, planned, [button]);
    expect(crop.w).toBeLessThan(planned.w);
    const off = Math.abs(button.x + button.w / 2 - (crop.x + crop.w / 2));
    expect(off).toBeLessThan(crop.w * 0.2);
  });
});

// ---- M36: a click that opens a dialog over its target ------------------------------------------

/** A grey-level frame (one px per CSS px): a light screen with filled rectangles. */
function gray(w: number, h: number, rects: { x: number; y: number; w: number; h: number; v: number }[], base = 245): GrayFrame {
  const lum = new Uint8Array(w * h).fill(base);
  for (const r of rects) {
    for (let y = r.y; y < Math.min(h, r.y + r.h); y++) for (let x = r.x; x < Math.min(w, r.x + r.w); x++) lum[y * w + x] = r.v;
  }
  return { width: w, height: h, lum };
}

describe("covered targets and what appeared (M36)", () => {
  const W = 1440, H = 810;
  const button = { x: 1200, y: 100, w: 150, h: 40 };
  const dialog = { x: 470, y: 150, w: 500, h: 420 };
  // Before: a list page with the button. After: the page dimmed by a backdrop, a white dialog on top.
  const screenRects = [{ x: 0, y: 0, w: 240, h: H, v: 40 }, ...[0, 1, 2, 3, 4].map((i) => ({ x: 300, y: 200 + i * 60, w: 800, h: 14, v: 90 }))];
  const before = gray(W, H, [...screenRects, { ...button, v: 70 }]);
  const dimmed = (r: { x: number; y: number; w: number; h: number; v: number }) => ({ ...r, v: Math.round(r.v * 0.5) });
  const after = gray(W, H, [...screenRects.map(dimmed), { ...button, v: 35 }, { ...dialog, v: 255 }, { x: 500, y: 190, w: 300, h: 16, v: 30 }, { x: 500, y: 480, w: 440, h: 40, v: 60 }], 122);

  it("tells a covered target from one still on screen", () => {
    expect(targetCovered(before, after, button)).toBe(true);
    // A field whose value changed (text typed into part of it) is still there.
    const field = { x: 300, y: 600, w: 600, h: 40 };
    const typed = gray(W, H, [...screenRects, { ...field, v: 250 }, { x: 310, y: 612, w: 120, h: 14, v: 30 }]);
    const empty = gray(W, H, [...screenRects, { ...field, v: 250 }]);
    expect(targetCovered(empty, typed, field)).toBe(false);
  });

  it("finds the dialog that appeared, not the dimmed backdrop", () => {
    const box = appearedRegion(before, after)!;
    expect(box).toBeDefined();
    expect(box.x).toBeGreaterThanOrEqual(dialog.x - FRAME_DIFF.cell);
    expect(box.y).toBeGreaterThanOrEqual(dialog.y - FRAME_DIFF.cell);
    expect(box.x + box.w).toBeLessThanOrEqual(dialog.x + dialog.w + FRAME_DIFF.cell);
    expect(box.y + box.h).toBeLessThanOrEqual(dialog.y + dialog.h + FRAME_DIFF.cell);
    expect(box.w).toBeGreaterThan(dialog.w * 0.6);
  });

  it("finds nothing compact when a whole new page came up", () => {
    // Same light background, a different layout: a header bar and rows all down the page.
    const other = gray(W, H, [{ x: 0, y: 0, w: W, h: 80, v: 30 }, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 100, y: 130 + i * 80, w: 1200, h: 22, v: 120 }))]);
    expect(appearedRegion(before, other)).toBeUndefined();
    // A whole new dark page isn't taken for a dimmed backdrop either.
    const dark = gray(W, H, [{ x: 0, y: 0, w: W, h: 80, v: 30 }, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: 100, y: 120 + i * 80, w: 1200, h: 30, v: 200 }))], 60);
    expect(appearedRegion(before, dark)).toBeUndefined();
  });

  const manifest: Pick<CaptureManifest, "steps"> = {
    steps: [
      step({ events: [{ type: "frame", image: "01.png", transition: "cut" }], doc: { image: "01.png", highlights: [] } }),
      // Click "New order": highlighted on the hover frame, then a dialog opened on the same page.
      step({
        events: [
          { type: "move", to: { x: 1275, y: 120 } },
          { type: "frame", image: "02.png", transition: "cut" },
          { type: "highlight", box: button },
          { type: "click", at: { x: 1275, y: 120 } },
          { type: "clearHighlight" },
          { type: "frame", image: "03.png", transition: "fade" },
        ],
        doc: { image: "03.png", highlights: [] },
      }),
      // Inside the dialog: a field highlighted, then typed into (still on screen after).
      step({
        events: [
          { type: "frame", image: "03.png", transition: "cut" },
          { type: "highlight", box: { x: 500, y: 480, w: 440, h: 40 } },
          { type: "click", at: { x: 720, y: 500 } },
          { type: "clearHighlight" },
          { type: "frame", image: "04.png", transition: "cut" },
        ],
        doc: { image: "04.png", highlights: [] },
      }),
    ],
  };
  const typedInDialog = gray(W, H, [...screenRects.map(dimmed), { ...button, v: 35 }, { ...dialog, v: 255 }, { x: 500, y: 190, w: 300, h: 16, v: 30 }, { x: 500, y: 480, w: 440, h: 40, v: 60 }, { x: 510, y: 492, w: 90, h: 14, v: 230 }], 122);
  const frames = (f: string): GrayFrame | undefined => ({ "01.png": before, "02.png": before, "03.png": after, "04.png": typedInDialog })[f];

  it("shows the frame before the click, ringed, when a dialog covers the target and nothing is blurred", () => {
    const plans = planStepFigures(wf([{}, {}, {}]), manifest, { frames });
    expect(plans[1]).toMatchObject({ frame: "02.png", targets: [button], docOverlays: false });
    // The dialog is a screen the reader hasn't seen yet: shown in full.
    expect(plans[2].newScreen).toBe(true);
    // A target that's still on the after-frame is ringed there.
    expect(plans[2]).toMatchObject({ frame: "04.png", targets: [{ x: 500, y: 480, w: 440, h: 40 }], docOverlays: true });
  });

  it("with blur anywhere, never shows the earlier frame: rings the dialog that appeared instead", () => {
    const plans = planStepFigures(wf([{}, {}, { blur: [{ id: "b", box: { x: 0, y: 0, w: 10, h: 10 } }] }]), manifest, { frames });
    expect(plans[1].frame).toBe("03.png");
    expect(plans[1].docOverlays).toBe(true);
    expect(plans[1].appeared).toBe(true);
    const ring = plans[1].targets[0];
    expect(ring.x).toBeGreaterThanOrEqual(dialog.x - FRAME_DIFF.cell);
    expect(ring.x + ring.w).toBeLessThanOrEqual(dialog.x + dialog.w + FRAME_DIFF.cell);
    // Never the old button position on the after-frame.
    expect(plans[1].targets).not.toContainEqual(button);
    // A path's caller passing anyBlur gets the same.
    expect(planStepFigures(wf([{}, {}, {}]), manifest, { frames, anyBlur: true })[1].frame).toBe("03.png");
  });

  // Card bug (M36 trial): a same-page step whose target is still on the after-frame used to get
  // no ring, and its crop was centred on the last click (an option in a list that had closed).
  it("rings a same-page target still on screen, not the last click's point", () => {
    const field = { x: 360, y: 265, w: 480, h: 40 };
    const m: Pick<CaptureManifest, "steps"> = {
      steps: [
        step({
          events: [
            { type: "frame", image: "a.png", transition: "cut" },
            { type: "highlight", box: field },
            { type: "click", at: { x: 600, y: 285 } },
            { type: "clearHighlight" },
            { type: "frame", image: "b.png", transition: "fade" },
            { type: "click", at: { x: 600, y: 527 } },
            { type: "frame", image: "c.png", transition: "fade" },
          ],
          doc: { image: "c.png", highlights: [] },
        }),
      ],
    };
    const plain = gray(W, H, [{ ...field, v: 250 }]);
    const picked = gray(W, H, [{ ...field, v: 250 }, { x: 370, y: 277, w: 140, h: 14, v: 30 }]);
    const plans = planStepFigures(wf([{}]), m, { frames: (f) => (f === "c.png" ? picked : plain) });
    expect(plans[0]).toMatchObject({ frame: "c.png", targets: [field], points: [] });
    const crop = placeCropClass(undefined, 0, plans[0].targets, plans[0].points, VIEWPORT)!;
    const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
    expect(Math.abs(cx - (field.x + field.w / 2))).toBeLessThan(2);
    expect(Math.abs(cy - (field.y + field.h / 2))).toBeLessThan(2);
  });
});

describe("crop size classes (M36)", () => {
  it("gives every class the same aspect and keeps the classes few", () => {
    const sizes = CROP_CLASSES.shares.map((_, i) => cropClassSize(i, VIEWPORT));
    for (const s of sizes) expect(s.w / s.h).toBeCloseTo(CROP_CLASSES.aspect, 1);
    expect(sizes.length).toBeLessThanOrEqual(4);
  });

  it("picks the smallest class that holds the context and the whole target", () => {
    const small = { x: 600, y: 300, w: 100, h: 30 };
    // A sparse area refined tight gets the smallest class; the usual minimum crop the next one up.
    expect(cropClassFor({ x: 0, y: 0, w: 400, h: 250 }, [small], [], VIEWPORT)).toBe(0);
    expect(cropClassFor({ x: 0, y: 0, w: 560, h: 350 }, [small], [], VIEWPORT)).toBe(1);
    expect(cropClassFor({ x: 0, y: 0, w: 700, h: 430 }, [small], [], VIEWPORT)).toBe(2);
    // Too wide for any class: the full screen reads better.
    expect(cropClassFor({ x: 0, y: 0, w: 560, h: 350 }, [{ x: 100, y: 300, w: 1100, h: 40 }], [], VIEWPORT)).toBeUndefined();
  });

  it("holds a guide to two neighbouring classes", () => {
    expect(normaliseCropClasses([0, 2, undefined, 1, 0])).toEqual([1, 2, undefined, 1, 1]);
    expect(normaliseCropClasses([0, 1, 0])).toEqual([0, 1, 0]);
  });

  it("places a class crop inside the frame with the whole target in, centred unless an edge stops it", () => {
    for (const t of [{ x: 20, y: 10, w: 80, h: 30 }, { x: 1380, y: 760, w: 50, h: 40 }, { x: 700, y: 400, w: 200, h: 40 }]) {
      const c = placeCropClass(undefined, 1, [t], [], VIEWPORT)!;
      expect(c).toMatchObject(cropClassSize(1, VIEWPORT));
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(VIEWPORT.width);
      expect(c.y + c.h).toBeLessThanOrEqual(VIEWPORT.height);
      expect(c.x).toBeLessThanOrEqual(t.x);
      expect(c.x + c.w).toBeGreaterThanOrEqual(t.x + t.w);
      expect(c.y).toBeLessThanOrEqual(t.y);
      expect(c.y + c.h).toBeGreaterThanOrEqual(t.y + t.h);
    }
  });

  it("nudges a class crop's edge off a column of text onto the gutter, staying near the target", () => {
    const t = { x: 620, y: 380, w: 160, h: 40 };
    const plain = placeCropClass(undefined, 0, [t], [], VIEWPORT)!;
    // A text column whose edge the centred crop's right side would cut through.
    const right = plain.x + plain.w;
    const m = screen(1440, 810, textBlock(right - 30, 100, 400, 600));
    const c = placeCropClass(m, 0, [t], [], VIEWPORT)!;
    expect(c.w).toBe(plain.w);
    expect(c.x + c.w).toBeLessThanOrEqual(right - 30);
    expect(Math.abs(c.x - plain.x)).toBeLessThanOrEqual(plain.w * CROP_CLASSES.drift + 4);
  });
});

describe("crop class review fixes (M36)", () => {
  it("steps down a class when what the bigger one adds is blank space", () => {
    const button = { x: 1240, y: 690, w: 120, h: 40 };
    const sparse = screen(1440, 810, [{ ...button, v: 60 }, { x: 1150, y: 690, w: 70, h: 40, v: 200 }]);
    expect(tightenCropClass(sparse, 1, [button], [], VIEWPORT)).toBe(0);
    // With content all round it, the bigger class stays.
    const busy = screen(1440, 810, [...textBlock(700, 400, 740, 410), { ...button, v: 60 }]);
    expect(tightenCropClass(busy, 1, [button], [], VIEWPORT)).toBe(1);
  });

  it("moves further off-centre rather than slice a form's labels when the near positions all cut", () => {
    // A dialog's labels at 495..700; the target button at its bottom right.
    const t = { x: 804, y: 698, w: 141, h: 40 };
    // Letters: short strokes, so a column through them crosses edges on every line.
    const letters: { x: number; y: number; w: number; h: number; v: number }[] = [];
    for (let y = 100; y < 660; y += 24) for (let x = 495; x < 700; x += 4) letters.push({ x, y, w: 2, h: 9, v: 40 });
    const m = screen(1440, 810, [{ x: 470, y: 48, w: 500, h: 715, v: 250 }, ...letters, { ...t, v: 70 }]);
    const c = placeCropClass(m, 1, [t], [], VIEWPORT)!;
    // The centred crop's left edge would run down through the labels; the placed one doesn't.
    const centred = placeCropClass(undefined, 1, [t], [], VIEWPORT)!;
    expect(centred.x).toBeGreaterThan(495);
    expect(centred.x).toBeLessThan(700);
    expect(c.x <= 495 || c.x >= 700).toBe(true);
    expect(c.x + c.w).toBeGreaterThanOrEqual(t.x + t.w);
  });
});
