// M36 video polish at the timeline level: the push-in is framed inside the screen with the whole
// target and some room around it, every camera move has one rhythm and lands before the click,
// the pointer comes to rest exactly where the ring is, and a menu opening in place cuts instead
// of crossfading (no ghosted double image).
import { describe, expect, it } from "vitest";
import type { CaptureManifest } from "../../src/capture/index.js";
import { cameraAt, cursorAt } from "../../src/render/state.js";
import { alignClicks, buildTimeline, IN_PLACE_CHANGE_MAX, zoomFrame } from "../../src/render/timeline.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";

const VP = { w: 1440, h: 810 };

describe("zoomFrame", () => {
  it("keeps the zoomed window inside the frame for a target near an edge", () => {
    for (const b of [{ x: 1380, y: 10, w: 50, h: 30 }, { x: 5, y: 770, w: 80, h: 36 }, { x: 700, y: 400, w: 100, h: 40 }]) {
      const z = zoomFrame(b, VP, 1.3)!;
      const halfW = VP.w / (2 * z.z), halfH = VP.h / (2 * z.z);
      expect(z.cx - halfW).toBeGreaterThanOrEqual(-1e-6);
      expect(z.cx + halfW).toBeLessThanOrEqual(VP.w + 1e-6);
      expect(z.cy - halfH).toBeGreaterThanOrEqual(-1e-6);
      expect(z.cy + halfH).toBeLessThanOrEqual(VP.h + 1e-6);
      // The whole target is in the window.
      expect(b.x).toBeGreaterThanOrEqual(z.cx - halfW - 1e-6);
      expect(b.x + b.w).toBeLessThanOrEqual(z.cx + halfW + 1e-6);
      expect(b.y).toBeGreaterThanOrEqual(z.cy - halfH - 1e-6);
      expect(b.y + b.h).toBeLessThanOrEqual(z.cy + halfH + 1e-6);
    }
  });

  it("zooms less for a big target so it fits with room around it, and not at all when it barely would", () => {
    const wide = zoomFrame({ x: 200, y: 300, w: 900, h: 60 }, VP, 1.3)!;
    const halfW = VP.w / (2 * wide.z);
    expect(halfW * 2).toBeGreaterThanOrEqual(900 + 2 * 56 - 1);
    expect(zoomFrame({ x: 100, y: 300, w: 1300, h: 60 }, VP, 1.3)).toBeUndefined();
    expect(zoomFrame({ x: 600, y: 300, w: 100, h: 30 }, VP, 1.3)!.z).toBe(1.3);
  });
});

describe("alignClicks", () => {
  it("moves a click outside its ring (and the move to it) to the ring's centre", () => {
    const box = { x: 100, y: 100, w: 200, h: 40 };
    const out = alignClicks([
      { type: "move", to: { x: 900, y: 600 } },
      { type: "highlight", box },
      { type: "click", at: { x: 900, y: 600 } },
    ]);
    expect(out[0]).toEqual({ type: "move", to: { x: 200, y: 120 } });
    expect(out[2]).toEqual({ type: "click", at: { x: 200, y: 120 } });
  });

  it("never carries a highlight over to a later action's click", () => {
    const box = { x: 100, y: 100, w: 200, h: 40 };
    const events: CaptureManifest["steps"][number]["events"] = [
      { type: "move", to: { x: 200, y: 120 } },
      { type: "highlight", box },
      { type: "click", at: { x: 200, y: 120 } },
      // A second action with no highlight of its own: an option in the list that opened.
      { type: "move", to: { x: 600, y: 500 } },
      { type: "frame", image: "h.png", transition: "cut" },
      { type: "click", at: { x: 600, y: 500 } },
      // A click with no move of its own straight after a highlight from a cleared action.
      { type: "highlight", box },
      { type: "clearHighlight" },
      { type: "click", at: { x: 900, y: 700 } },
    ];
    expect(alignClicks(events)).toEqual(events);
  });

  it("leaves a click inside its ring alone (a row highlighted, its button clicked)", () => {
    const events: CaptureManifest["steps"][number]["events"] = [
      { type: "move", to: { x: 1330, y: 390 } },
      { type: "highlight", box: { x: 340, y: 355, w: 1040, h: 70 } },
      { type: "click", at: { x: 1330, y: 390 } },
    ];
    expect(alignClicks(events)).toEqual(events);
  });
});

const BOX = { x: 1200, y: 100, w: 150, h: 40 };

function fixture(clickAt = { x: 1275, y: 120 }) {
  const wf = {
    walkthrough: "acme-order",
    title: "Add an order",
    product: "Acme",
    intro: { say: "Intro" },
    outro: { say: "Outro" },
    steps: [
      { id: "open", title: "Open Orders", say: "Open orders", camera: "full", actions: [] },
      { id: "new", title: "New order", say: "Click New order", camera: "full", actions: [] },
      { id: "pick", title: "Pick a status", say: "Pick a status", camera: "full", actions: [] },
    ],
  } as unknown as Walkthrough;
  const manifest: CaptureManifest = {
    workflow: "acme-order",
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: [
      { id: "open", camera: "full", cameraBox: null, events: [{ type: "frame", image: "1.png", transition: "cut" }], doc: { image: "1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      {
        id: "new",
        camera: "full",
        cameraBox: null,
        events: [
          { type: "move", to: clickAt },
          { type: "frame", image: "2.png", transition: "cut" },
          { type: "highlight", box: BOX },
          { type: "click", at: clickAt },
          { type: "clearHighlight" },
          { type: "frame", image: "3.png", transition: "fade" },
        ],
        doc: { image: "3.png", highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
      {
        id: "pick",
        camera: "full",
        cameraBox: null,
        events: [
          { type: "move", to: { x: 400, y: 300 } },
          { type: "frame", image: "4.png", transition: "cut" },
          { type: "click", at: { x: 400, y: 300 } },
          // A dropdown opens in place.
          { type: "frame", image: "5.png", transition: "fade" },
          { type: "click", at: { x: 400, y: 360 } },
          // ...and closes on the choice.
          { type: "frame", image: "6.png", transition: "fade" },
        ],
        doc: { image: "6.png", highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
    ],
  };
  const narration = Object.fromEntries(["intro", "open", "new", "pick", "outro"].map((id) => [id, { audioPath: `/v/${id}.wav`, durationMs: 1500 }]));
  return { wf, manifest, narration };
}

describe("camera and cursor around a click", () => {
  it("lands the push-in and rests the pointer on the target before it clicks", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const click = tl.clicks[0];
    const push = tl.cameras.find((c) => c.to.z > 1)!;
    expect(push.t1).toBeLessThanOrEqual(click.t);
    // The push-in starts as the pointer sets off — not held back by a no-op step framing.
    expect(push.t0).toBeCloseTo(tl.moves[0].t0, 5);
    // At the click, and for a moment before it, the pointer is exactly on the click point.
    for (const dt of [0, 0.1]) expect(cursorAt(tl, click.t - dt)).toEqual({ x: click.x, y: click.y });
    expect(cameraAt(tl, click.t).z).toBeCloseTo(push.to.z, 5);
  });

  it("gives every camera move the same length", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const moving = tl.cameras.filter((c) => c.t1 > c.t0 && JSON.stringify(c.from) !== JSON.stringify(c.to));
    expect(moving.length).toBeGreaterThan(1);
    for (const c of moving) expect(c.t1 - c.t0).toBeCloseTo(moving[0].t1 - moving[0].t0, 5);
  });

  it("ends the pointer on the ring when the capture's click point fell outside it", () => {
    const { wf, manifest, narration } = fixture({ x: 900, y: 600 });
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const click = tl.clicks[0];
    expect(click).toMatchObject({ x: BOX.x + BOX.w / 2, y: BOX.y + BOX.h / 2 });
    expect(cursorAt(tl, click.t)).toEqual({ x: click.x, y: click.y });
  });
});

describe("narration slack", () => {
  it("counts the inserted pointer move and the push-in's landing in the step's own length", () => {
    // A long narration: the step's slack is shared out, so it ends exactly when the voice needs.
    const { wf, manifest, narration } = fixture({ x: 900, y: 600 });
    narration.new = { audioPath: "/v/new.wav", durationMs: 6000 };
    narration.pick = { audioPath: "/v/pick.wav", durationMs: 6000 };
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const need = 0.3 + 6 + 0.45;
    // "new" waits for its push-in to land; "pick" gets a pointer move inserted before its second click.
    for (const id of ["new", "pick"]) {
      const scene = tl.scenes!.find((sc) => sc.id === id)!;
      expect(Math.abs(scene.t1 - scene.t0 - need)).toBeLessThan(0.01);
    }
  });
});

describe("transitions for small in-place changes", () => {
  it("fades, never cuts, in a step that changed screen", () => {
    const { wf, manifest, narration } = fixture();
    manifest.steps[2].impact = { urls: ["/orders/new"], requests: [] };
    (wf as { start?: unknown }).start = { page: "/orders" };
    const tl = buildTimeline(wf, manifest, narration, { fps: 30, frameChange: () => 0.01 });
    const cue = (f: string) => tl.frames.find((c) => c.src.endsWith(`/${f}`))!;
    expect(cue("5.png").transition).toBe("fade");
    expect(cue("6.png").transition).toBe("fade");
    // The step before it stayed on its screen: a tiny change there still cuts.
    expect(cue("3.png").transition).toBe("cut");
  });

  const changes: Record<string, number> = { "2.png>3.png": 0.7, "4.png>5.png": 0.04, "5.png>6.png": 0.05 };
  const frameChange = (a: string, b: string) => changes[`${a}>${b}`];

  it("cuts when a menu opens or closes in place, keeps the crossfade for a new screen", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30, frameChange });
    const cue = (f: string) => tl.frames.find((c) => c.src.endsWith(`/${f}`))!;
    expect(cue("3.png").transition).toBe("fade");
    expect(cue("5.png").transition).toBe("cut");
    expect(cue("6.png").transition).toBe("cut");
    expect(changes["4.png>5.png"]).toBeLessThan(IN_PLACE_CHANGE_MAX);
  });

  it("keeps the captured transition when the change is unknown", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    expect(tl.frames.filter((c) => c.transition === "fade")).toHaveLength(3);
  });
});
