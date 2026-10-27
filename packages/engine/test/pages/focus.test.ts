// M32 (decision 36): which frame a step's print figure shows, which boxes on it are real, when a
// screen is new to the reader, and the focus-crop geometry around the target.
import { describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep } from "../../src/capture/index.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import { CROP_REFINE, FOCUS_CROP, edgeMap, focusCrop, planStepFigures, refineCrop } from "../../src/pages/focus.js";

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
