// frameSignature (state.ts, M16 part 2) is a hand-kept port of assets/player/player.js's
// renderAt — if the two ever drift, a frame that actually changed could get a signature match
// and video.ts would wrongly repeat the previous screenshot (a frozen frame in the output with
// no failing test). These tests pin the contract from both directions: fast unit tests assert
// signature equality/inequality for each animation kind player.js's renderAt branches on, and a
// slow test drives the real player through Chromium to confirm the invariant the fast tests
// assume — "equal signature implies pixel-identical screenshot" — actually holds.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePlayerBundle } from "../../src/render/bundle.js";
import { frameSignature } from "../../src/render/state.js";
import type { Timeline } from "../../src/render/types.js";
import { openRenderBrowser } from "../../src/render/video.js";

// A tiny, valid 1x1 PNG — the parity test's frame cues (`f0.png`/`f1.png`) need to be real,
// decodable images once M22's blur canvases started reading pixels from the player's <img>
// elements (`drawImage` throws on a "broken"/undecoded image, unlike the CSS this test used to
// only exercise).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const SLOW = process.env.AIDA_TEST_SLOW === "1";

/** A fully static baseline Timeline: one frame, no moves/clicks/highlights, a constant camera,
 * no captions/chips, and stage in/out pushed far outside [0, duration) so the stage is visible
 * throughout with no envelope or intro/outro-card reveal in progress. Every test below overrides
 * just the one field it's exercising, so any inequality it asserts is attributable to that field
 * alone. */
function baseTimeline(overrides: Partial<Timeline> = {}): Timeline {
  return {
    fps: 10,
    viewport: { w: 400, h: 300 },
    stage: { x: 100, y: 100, w: 400, h: 300 },
    fade: 0.3,
    brand: { name: "Demo" },
    intro: { eyebrow: "E", titleHtml: "T", subtitle: "S" },
    outro: { title: "O", recap: [] },
    chapters: ["A"],
    frames: [{ t: 0, src: "f0.png", transition: "cut" }],
    moves: [],
    clicks: [],
    highlights: [],
    cameras: [{ t0: -10, t1: -9.05, from: { z: 1, cx: 200, cy: 150 }, to: { z: 1, cx: 200, cy: 150 } }],
    captions: [],
    chips: [],
    audio: [],
    cursorStart: { x: 0, y: 0 },
    stageIn: { t0: -5, t1: -4.5 },
    stageOut: { t0: 100, t1: 100.5 },
    duration: 10,
    previewAudio: "narration.m4a",
    ...overrides,
  };
}

// player.js's intro-card reveals (`reveal($('intro-brand'), 0.15)` etc.) run off fixed absolute
// seconds, not off `stageIn` — they don't all saturate to their resting value until ~2.3s no
// matter how the timeline's stage/camera/etc. are configured. Every test below that isn't itself
// about the intro/outro card picks t's at or past this offset so the only thing that can make two
// signatures differ is the one field each test overrides.
const T0 = 3.0;

describe("frameSignature", () => {
  it("is equal for two instants inside a fully static span", () => {
    const tl = baseTimeline();
    expect(frameSignature(tl, T0 + 1.0)).toBe(frameSignature(tl, T0 + 1.5));
  });

  it("differs while the cursor is moving, settles once the move ends", () => {
    const tl = baseTimeline({ moves: [{ t0: T0 + 0.5, t1: T0 + 1.0, from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }] });
    expect(frameSignature(tl, T0 + 0.6)).not.toBe(frameSignature(tl, T0 + 0.8));
    expect(frameSignature(tl, T0 + 1.2)).toBe(frameSignature(tl, T0 + 1.5));
  });

  it("differs around a click's press + ripple decay", () => {
    const tl = baseTimeline({ clicks: [{ t: T0 + 0.5, x: 10, y: 10 }] });
    expect(frameSignature(tl, T0 + 0.2)).not.toBe(frameSignature(tl, T0 + 0.55));
    expect(frameSignature(tl, T0 + 0.55)).not.toBe(frameSignature(tl, T0 + 0.9));
  });

  it("differs while a highlight animates in/out, equal on its plateau", () => {
    const tl = baseTimeline({ highlights: [{ t0: T0 + 0.5, t1: T0 + 1.5, box: { x: 0, y: 0, w: 10, h: 10 } }] });
    expect(frameSignature(tl, T0 + 0.55)).not.toBe(frameSignature(tl, T0 + 0.65)); // entrance ramp
    expect(frameSignature(tl, T0 + 1.0)).toBe(frameSignature(tl, T0 + 1.1)); // fully open plateau
    expect(frameSignature(tl, T0 + 1.3)).not.toBe(frameSignature(tl, T0 + 1.4)); // exit ramp
  });

  it("differs when the caption text changes", () => {
    const tl = baseTimeline({
      captions: [
        { t0: T0 + 0.4, t1: T0 + 0.9, text: "A" },
        { t0: T0 + 0.9, t1: T0 + 1.5, text: "B" },
      ],
    });
    expect(frameSignature(tl, T0 + 0.65)).not.toBe(frameSignature(tl, T0 + 1.05));
  });

  it("differs during a frame's fade transition, equal once it completes", () => {
    const tl = baseTimeline({
      frames: [
        { t: 0, src: "f0.png", transition: "cut" },
        { t: T0 + 0.5, src: "f1.png", transition: "fade" },
      ],
    });
    expect(frameSignature(tl, T0 + 0.55)).not.toBe(frameSignature(tl, T0 + 0.65));
    expect(frameSignature(tl, T0 + 0.9)).toBe(frameSignature(tl, T0 + 1.2));
  });

  it("differs while the camera pans/zooms, equal once it settles", () => {
    const tl = baseTimeline({
      cameras: [{ t0: T0 + 0.3, t1: T0 + 1.25, from: { z: 1, cx: 100, cy: 100 }, to: { z: 1.5, cx: 150, cy: 120 } }],
    });
    expect(frameSignature(tl, T0 + 0.5)).not.toBe(frameSignature(tl, T0 + 0.7));
    expect(frameSignature(tl, T0 + 1.4)).toBe(frameSignature(tl, T0 + 1.6));
  });

  it("differs when the step chip changes", () => {
    const tl = baseTimeline({
      chips: [
        { t0: T0 + 0.4, t1: T0 + 1.0, num: "1", eyebrow: "E1", title: "T1" },
        { t0: T0 + 1.0, t1: T0 + 1.6, num: "2", eyebrow: "E2", title: "T2" },
      ],
    });
    expect(frameSignature(tl, T0 + 0.7)).not.toBe(frameSignature(tl, T0 + 1.3));
  });

  it("differs during the intro card's reveal", () => {
    const tl = baseTimeline({ stageIn: { t0: 0.5, t1: 1.0 } });
    expect(frameSignature(tl, 0.1)).not.toBe(frameSignature(tl, 0.3));
  });

  it("differs during the outro card's reveal", () => {
    const tl = baseTimeline({ stageOut: { t0: 1.0, t1: 1.3 }, outro: { title: "O", recap: ["r1"] } });
    expect(frameSignature(tl, 1.4)).not.toBe(frameSignature(tl, 1.6));
  });

  // M22: callouts/blur are static for a step's whole on-screen window (no ramp), so the
  // signature only needs to flip at the window's edges and when the window's content differs —
  // no "plateau" case to check, unlike highlights.
  it("differs while a callout window is active, and when its contents change", () => {
    const tl = baseTimeline({
      callouts: [{ t0: T0 + 0.5, t1: T0 + 1.5, items: [{ box: { x: 0, y: 0, w: 10, h: 10 }, num: 1, label: "Click" }] }],
    });
    expect(frameSignature(tl, T0 + 0.2)).not.toBe(frameSignature(tl, T0 + 0.7));
    expect(frameSignature(tl, T0 + 0.7)).toBe(frameSignature(tl, T0 + 1.2)); // same window, same content
    expect(frameSignature(tl, T0 + 1.6)).toBe(frameSignature(tl, T0 + 0.2)); // window closed again

    const tlMoved = baseTimeline({
      callouts: [{ t0: T0 + 0.5, t1: T0 + 1.5, items: [{ box: { x: 5, y: 0, w: 10, h: 10 }, num: 1, label: "Click" }] }],
    });
    expect(frameSignature(tl, T0 + 0.7)).not.toBe(frameSignature(tlMoved, T0 + 0.7));
  });

  it("differs while a blur window is active", () => {
    const tl = baseTimeline({ blur: [{ t0: T0 + 0.5, t1: T0 + 1.5, boxes: [{ x: 0, y: 0, w: 10, h: 10 }] }] });
    expect(frameSignature(tl, T0 + 0.2)).not.toBe(frameSignature(tl, T0 + 0.7));
    expect(frameSignature(tl, T0 + 1.6)).toBe(frameSignature(tl, T0 + 0.2));
  });
});

// Slow Chromium parity check (AIDA_TEST_SLOW=1, `npm run test:slow`): the fast tests above
// assume "equal frameSignature implies pixel-identical screenshot" — this drives the real player
// through every frame of a timeline covering every animation kind at once (no skipping — every
// frame is actually evaluated and screenshotted) and asserts that assumption against real
// Playwright/Chromium output, not just the hand-ported math. ~30 frames at a tiny viewport; well
// under 30s even on a loaded host.
describe.skipIf(!SLOW)("frameSignature vs real Chromium render (parity)", () => {
  let bundleDir: string;

  afterEach(async () => {
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  });

  it(
    "wherever two consecutive frames' signatures match, their real screenshots are byte-identical",
    async () => {
      const tl = baseTimeline({
        fps: 10,
        duration: 3.0,
        frames: [
          { t: 0, src: "f0.png", transition: "cut" },
          { t: 1.0, src: "f1.png", transition: "fade" },
        ],
        moves: [{ t0: 0.3, t1: 0.8, from: { x: 50, y: 50 }, to: { x: 150, y: 150 } }],
        clicks: [{ t: 0.8, x: 150, y: 150 }],
        highlights: [{ t0: 0.2, t1: 1.6, box: { x: 10, y: 10, w: 30, h: 30 } }],
        cameras: [{ t0: 0, t1: 0.95, from: { z: 1, cx: 200, cy: 150 }, to: { z: 1.3, cx: 220, cy: 160 } }],
        captions: [
          { t0: 0.1, t1: 1.2, text: "Hello" },
          { t0: 1.2, t1: 2.5, text: "World" },
        ],
        chips: [
          { t0: 0, t1: 1.5, num: "1", eyebrow: "E1", title: "T1" },
          { t0: 1.5, t1: 3.0, num: "2", eyebrow: "E2", title: "T2" },
        ],
        // M22: a callout + blur window, each covering only part of the clip, so the fixture
        // exercises both "window active" and "window closed" against the real player too.
        callouts: [{ t0: 0.5, t1: 1.8, items: [{ box: { x: 40, y: 40, w: 20, h: 20 }, num: 1, label: "Here" }] }],
        blur: [{ t0: 1.0, t1: 2.2, boxes: [{ x: 60, y: 60, w: 30, h: 15 }] }],
      });

      bundleDir = await mkdtemp(path.join(os.tmpdir(), "aida-state-parity-"));
      await writePlayerBundle(bundleDir, tl);
      await writeFile(path.join(bundleDir, "f0.png"), TINY_PNG);
      await writeFile(path.join(bundleDir, "f1.png"), TINY_PNG);

      const frameCount = Math.ceil(tl.duration * tl.fps);
      const { pages, close } = await openRenderBrowser(bundleDir, 0.3, 1);
      const buffers: Buffer[] = [];
      try {
        const page = pages[0];
        for (let i = 0; i < frameCount; i++) {
          const t = i / tl.fps;
          await page.evaluate((t) => (window as any).renderAt(t), t);
          buffers.push(await page.screenshot({ type: "jpeg", quality: 60 }));
        }
      } finally {
        await close();
      }

      let equalPairs = 0;
      let unequalPairs = 0;
      for (let i = 1; i < frameCount; i++) {
        const sigPrev = frameSignature(tl, (i - 1) / tl.fps);
        const sigCur = frameSignature(tl, i / tl.fps);
        if (sigPrev === sigCur) {
          equalPairs++;
          expect(buffers[i].equals(buffers[i - 1])).toBe(true);
        } else {
          unequalPairs++;
        }
      }
      // Sanity: the fixture must actually exercise both cases, or the assertion above is vacuous.
      expect(equalPairs).toBeGreaterThan(0);
      expect(unequalPairs).toBeGreaterThan(0);
    },
    30_000,
  );

  // M34: the presets add card reveal schedules (friendly's overshoot), a numbered highlight badge,
  // a browser bar, transition transforms and the lower-third wipe — same parity rule for each.
  for (const style of ["friendly", "bold", "minimal"] as const) {
    it(`holds for the ${style} preset (card reveals, badge, transitions)`, async () => {
      const tl = baseTimeline({
        fps: 10,
        duration: 4.0,
        brand: { name: "Acme", style },
        chrome: style === "bold" ? 38 : 0,
        stageIn: { t0: 1.6, t1: 2.2 },
        cards: {
          intro: [
            { id: "intro-panel", t0: 0.05, d: 0.6, dy: 30 },
            { id: "intro-title", t0: 0.3, d: 0.6, dy: 30 },
            { id: "intro-facts", t0: 0.8, d: 0.5, dy: 20 },
          ],
          outro: [{ id: "outro-title", t0: 100.4, d: 0.7, dy: 30 }],
        },
        intro: { eyebrow: "E", titleHtml: "T", subtitle: "S", facts: ["2 steps"], reader: "Office staff" },
        frames: [
          { t: 0, src: "f0.png", transition: "cut" },
          { t: 2.6, src: "f1.png", transition: "fade" },
        ],
        highlights: [{ t0: 2.4, t1: 3.4, box: { x: 10, y: 10, w: 30, h: 30 }, num: 2 }],
        chips: [{ t0: 2.2, t1: 4.0, num: "2", eyebrow: "Step 2 of 2", title: "T2" }],
        captions: [{ t0: 2.3, t1: 3.6, text: "Hello" }],
      });
      bundleDir = await mkdtemp(path.join(os.tmpdir(), "aida-state-parity-"));
      await writePlayerBundle(bundleDir, tl);
      await writeFile(path.join(bundleDir, "f0.png"), TINY_PNG);
      await writeFile(path.join(bundleDir, "f1.png"), TINY_PNG);
      const frameCount = Math.ceil(tl.duration * tl.fps);
      const { pages, close } = await openRenderBrowser(bundleDir, 0.3, 1);
      const buffers: Buffer[] = [];
      try {
        for (let i = 0; i < frameCount; i++) {
          await pages[0].evaluate((t) => (window as any).renderAt(t), i / tl.fps);
          buffers.push(await pages[0].screenshot({ type: "jpeg", quality: 60 }));
        }
      } finally {
        await close();
      }
      let equalPairs = 0;
      let unequalPairs = 0;
      for (let i = 1; i < frameCount; i++) {
        if (frameSignature(tl, (i - 1) / tl.fps) === frameSignature(tl, i / tl.fps)) {
          equalPairs++;
          expect(buffers[i].equals(buffers[i - 1]), `frame ${i}`).toBe(true);
        } else unequalPairs++;
      }
      expect(equalPairs).toBeGreaterThan(0);
      expect(unequalPairs).toBeGreaterThan(0);
    }, 30_000);
  }
});
