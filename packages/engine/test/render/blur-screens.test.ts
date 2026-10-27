// M34 privacy fix: a region blurred in one step must stay blurred on every frame of the same
// screen — earlier steps, later steps, and the stage sliding in and out — not only during the
// step whose `blur:` list names it. Unit tests on the windows, plus a real Chromium render that
// checks the pixels inside the box are flat on frames from other steps.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep } from "../../src/capture/index.js";
import { writePlayerBundle } from "../../src/render/bundle.js";
import { blurAt, cameraAt } from "../../src/render/state.js";
import { buildTimeline } from "../../src/render/timeline.js";
import { openRenderBrowser } from "../../src/render/video.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";

const BOX = { x: 200, y: 120, w: 300, h: 80 };

function step(id: string, blur = false) {
  return {
    id,
    chapter: "A",
    title: id,
    say: `${id} narration`,
    camera: "full" as const,
    actions: [],
    ...(blur ? { blur: [{ id: "email", box: { x: 0, y: 0, w: 1, h: 1 } }] } : {}),
  };
}

function mStep(id: string, frame: string, urls: string[], blur = false): ManifestStep {
  return {
    id,
    camera: "full",
    cameraBox: null,
    events: [
      { type: "frame", image: frame, transition: "cut" },
      { type: "hold", seconds: 0.5 },
    ],
    doc: { image: frame, highlights: [], ...(blur ? { blur: [{ id: "email", box: BOX }] } : {}) },
    impact: { urls, requests: [] },
    checks: [],
  };
}

/** Five steps: one, two (blurs BOX), three on the same screen; four clicks through to another
 * page; five is on that other page. */
function fixture(frames: (id: string) => string = (id) => `${id}.png`) {
  const wf: Walkthrough = {
    walkthrough: "acme-blur",
    title: "Acme blur",
    product: "Acme",
    start: { page: "/customers" },
    intro: { say: "Intro" },
    outro: { say: "Outro" },
    steps: [step("one"), step("two", true), step("three"), step("four"), step("five")],
  } as Walkthrough;
  const manifest: CaptureManifest = {
    workflow: "acme-blur",
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: [
      mStep("one", frames("one"), ["http://localhost/customers"]),
      mStep("two", frames("two"), ["http://localhost/customers"], true),
      mStep("three", frames("three"), []),
      mStep("four", frames("four"), ["http://localhost/customers", "http://localhost/orders"]),
      mStep("five", frames("five"), ["http://localhost/orders"]),
    ],
  };
  const narration = Object.fromEntries(
    ["intro", "one", "two", "three", "four", "five", "outro"].map((id) => [id, { audioPath: `/v/${id}.wav`, durationMs: 1200 }]),
  );
  return { wf, manifest, narration };
}

describe("blur windows per screen (M34)", () => {
  it("covers every step on the blurred step's screen, the step that leaves it, and the stage sliding in", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const scene = (id: string) => tl.scenes!.find((s) => s.id === id)!;
    const mid = (id: string) => (scene(id).t0 + scene(id).t1) / 2;
    for (const id of ["one", "two", "three", "four"]) expect(blurAt(tl, mid(id))?.boxes, id).toEqual([BOX]);
    // The stage is already showing step one's screen while it slides in under the intro card.
    expect(blurAt(tl, tl.stageIn.t0 + 0.01)?.boxes).toEqual([BOX]);
    // Another page: nothing of the old screen is left to hide.
    expect(blurAt(tl, mid("five"))).toBeUndefined();
  });

  it("reaches the end of the video when the last screen has blur", () => {
    const { wf, manifest, narration } = fixture();
    manifest.steps[4] = mStep("five", "five.png", ["http://localhost/orders"], true);
    wf.steps[4] = step("five", true);
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    expect(blurAt(tl, tl.duration - 0.01)?.boxes).toEqual([BOX]);
  });

  it("treats a walkthrough with no route information as one screen", () => {
    const { wf, manifest, narration } = fixture();
    for (const s of manifest.steps) s.impact.urls = [];
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const five = tl.scenes!.find((s) => s.id === "five")!;
    expect(blurAt(tl, (five.t0 + five.t1) / 2)?.boxes).toEqual([BOX]);
  });

  it("keeps a route's boxes on every visit to it (A, B, back to A)", () => {
    const { wf, manifest, narration } = fixture();
    // one (/customers), two blurs on /customers, three goes to /orders, four on /orders,
    // five comes back to /customers.
    manifest.steps[2] = mStep("three", "three.png", ["http://localhost/customers", "http://localhost/orders"]);
    manifest.steps[3] = mStep("four", "four.png", ["http://localhost/orders"]);
    manifest.steps[4] = mStep("five", "five.png", ["http://localhost/orders", "http://localhost/customers"]);
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const mid = (id: string) => {
      const s = tl.scenes!.find((sc) => sc.id === id)!;
      return (s.t0 + s.t1) / 2;
    };
    expect(blurAt(tl, mid("four"))).toBeUndefined();
    expect(blurAt(tl, mid("five"))?.boxes).toEqual([BOX]);
  });

  it("widens boxes to full-height bands on a route where anything scrolls", () => {
    const { wf, manifest, narration } = fixture();
    manifest.steps[2].events.push({ type: "scrollFrames", images: ["three.png"] });
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    const one = tl.scenes!.find((s) => s.id === "one")!;
    expect(blurAt(tl, (one.t0 + one.t1) / 2)?.boxes).toEqual([{ x: BOX.x, y: 0, w: BOX.w, h: 810 }]);
  });

  it("shows no hero screenshot on the cards when any step declares blur, even unresolved", () => {
    const { wf, manifest, narration } = fixture();
    manifest.steps[1] = mStep("two", "two.png", ["http://localhost/customers"]); // target not found this run
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    expect(tl.blur).toEqual([]);
    expect(tl.cards!.intro.map((r) => r.id)).not.toContain("intro-hero");
    expect(tl.cards!.outro.map((r) => r.id)).not.toContain("outro-hero");
  });

  it("adds no windows when nothing is blurred", () => {
    const { wf, manifest, narration } = fixture();
    manifest.steps[1] = mStep("two", "two.png", ["http://localhost/customers"]);
    wf.steps[1] = step("two");
    expect(buildTimeline(wf, manifest, narration, { fps: 30 }).blur).toEqual([]);
  });
});

/** A frame with a high-contrast checkerboard (what a leaked email column would look like). */
function checkerPng(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = ((x >> 3) + (y >> 3)) % 2 === 0;
      const i = (y * w + x) * 4;
      png.data[i] = on ? 10 : 245;
      png.data[i + 1] = on ? 20 : 240;
      png.data[i + 2] = on ? 30 : 235;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe("blur during a screen change (real player)", () => {
  for (const style of ["bold", "friendly"] as const) {
    it(`${style}: the box at the stage edge and the strip beside it stay flat mid-fade`, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "aida-blur-fade-"));
      try {
        // The player's camera layer is laid out for a 1440x810 capture.
        const VW = 1440;
        const VH = 810;
        const box = { x: 0, y: 200, w: 300, h: 120 };
        const flat = new PNG({ width: VW, height: VH });
        const busy = new PNG({ width: VW, height: VH });
        for (let y = 0; y < VH; y++) {
          for (let x = 0; x < VW; x++) {
            const i = (y * VW + x) * 4;
            const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
            const v = inBox && ((x >> 3) + (y >> 3)) % 2 === 0 ? 10 : 200;
            for (const png of [flat, busy]) png.data.fill(255, i, i + 4);
            flat.data[i] = flat.data[i + 1] = flat.data[i + 2] = 200;
            busy.data[i] = busy.data[i + 1] = busy.data[i + 2] = inBox ? v : 200;
          }
        }
        const tl = {
          fps: 10,
          viewport: { w: VW, h: VH },
          stage: { x: 132, y: 24, w: 1656, h: 931.5 },
          fade: 0.35,
          brand: { name: "Acme", style },
          intro: { eyebrow: "", titleHtml: "", subtitle: "" },
          outro: { title: "", recap: [] },
          chapters: [""],
          frames: [
            { t: 0, src: "f0.png", transition: "cut" as const },
            { t: 1.0, src: "f1.png", transition: "fade" as const },
          ],
          moves: [],
          clicks: [],
          highlights: [],
          blur: [{ t0: 0, t1: 3, boxes: [box] }],
          cameras: [{ t0: -10, t1: -9, from: { z: 1, cx: VW / 2, cy: VH / 2 }, to: { z: 1, cx: VW / 2, cy: VH / 2 } }],
          captions: [],
          chips: [],
          audio: [],
          cursorStart: { x: -100, y: -100 },
          stageIn: { t0: -5, t1: -4.5 },
          stageOut: { t0: 100, t1: 100.5 },
          duration: 3,
          previewAudio: "narration.m4a",
        };
        await writePlayerBundle(dir, tl); // (clears the dir: frames go in after)
        await writeFile(path.join(dir, "f0.png"), PNG.sync.write(flat));
        await writeFile(path.join(dir, "f1.png"), PNG.sync.write(busy));
        const { pages, close } = await openRenderBrowser(dir, 1, 1);
        try {
          await pages[0].evaluate((t) => (window as any).renderAt(t), 1.03); // early in the fade
          const shot = PNG.sync.read(await pages[0].screenshot({ type: "png" }));
          const K = tl.stage.w / VW;
          const spread = (vx0: number, vx1: number) => {
            let min = 255;
            let max = 0;
            for (let vy = box.y + 6; vy < box.y + box.h - 6; vy++) {
              for (let vx = vx0; vx < vx1; vx++) {
                const v = shot.data[(Math.round(tl.stage.y + vy * K) * shot.width + Math.round(tl.stage.x + vx * K)) * 4];
                min = Math.min(min, v);
                max = Math.max(max, v);
              }
            }
            return max - min;
          };
          expect(spread(box.x + 4, box.x + box.w - 6), "inside the box").toBeLessThanOrEqual(6);
          expect(spread(box.x + box.w + 6, box.x + box.w + 26), "beside the box").toBeLessThanOrEqual(6);
        } finally {
          await close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

describe("blurred region stays flat on later frames (real player)", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("the box is one flat colour on frames from steps one, three and four", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "aida-blur-screens-"));
    const { wf, manifest, narration } = fixture((id) => path.join(dir!, `${id}.png`));
    const tl = buildTimeline(wf, manifest, narration, { fps: 30, frameSrc: (f) => f });
    await writePlayerBundle(dir, tl);
    const frame = checkerPng(1440, 810);
    for (const id of ["one", "two", "three", "four", "five"]) await writeFile(path.join(dir, `${id}.png`), frame);

    const { pages, close } = await openRenderBrowser(dir, 1, 1);
    try {
      const page = pages[0];
      const K = tl.stage.w / tl.viewport.w;
      const VW = tl.viewport.w;
      const VH = tl.viewport.h;
      for (const id of ["one", "three", "four"]) {
        const s = tl.scenes!.find((sc) => sc.id === id)!;
        // Late in the step: after the camera move, the stage fully in.
        const t = s.t1 - 0.2;
        await page.evaluate((t) => (window as any).renderAt(t), t);
        const shot = PNG.sync.read(await page.screenshot({ type: "png" }));
        // Viewport px -> screen px through the camera at t (same maths as player.js), inset past
        // the box's softened edge.
        const c = cameraAt(tl, t);
        const z = c.z;
        const cx = Math.min(VW - VW / 2 / z, Math.max(VW / 2 / z, c.cx));
        const cy = Math.min(VH - VH / 2 / z, Math.max(VH / 2 / z, c.cy));
        const sx = (vx: number) => tl.stage.x + tl.stage.w / 2 + (vx - cx) * K * z;
        const sy = (vy: number) => tl.stage.y + tl.stage.h / 2 + (vy - cy) * K * z;
        const x0 = Math.ceil(sx(BOX.x + 10));
        const x1 = Math.floor(sx(BOX.x + BOX.w - 10));
        const y0 = Math.ceil(sy(BOX.y + 10));
        const y1 = Math.floor(sy(BOX.y + BOX.h - 10));
        let min = 255;
        let max = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const v = shot.data[(y * shot.width + x) * 4];
            min = Math.min(min, v);
            max = Math.max(max, v);
          }
        }
        expect(max - min, `step ${id}: spread of red inside the blur box`).toBeLessThanOrEqual(6);
      }
    } finally {
      await close();
    }
  }, 60_000);
});
