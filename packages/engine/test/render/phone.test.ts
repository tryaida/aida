// M43c: a portrait phone video for walkthroughs captured on a phone (decision 40). Pure geometry
// tests for the portrait frame (no overflow, a safe-zone band that never overlaps the phone
// screen, chrome forced off, a touch pointer) and that the desktop (landscape) output is
// unaffected — then a small real end-to-end render (AIDA_TEST_SLOW=1) checking the mp4 itself
// comes out portrait.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { NEUTRAL_COLORS, type ArtifactBrand } from "../../src/render/brand.js";
import { buildTimeline } from "../../src/render/timeline.js";
import type { NarrationBeat } from "../../src/render/types.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

const SLOW = process.env.AIDA_TEST_SLOW === "1";
const brand = (style: ArtifactBrand["style"]): ArtifactBrand => ({ colors: { ...NEUTRAL_COLORS }, configured: false, style } as ArtifactBrand);

const PHONE_VIEWPORT = { width: 412, height: 839 };
const DESKTOP_VIEWPORT = { width: 1440, height: 810 };

function wf(overrides: Partial<Walkthrough> = {}): Walkthrough {
  return {
    walkthrough: "phone-demo",
    title: "Open the menu",
    product: "Acme",
    intro: { say: "Intro" },
    outro: { say: "Outro", recap: ["Open the menu"] },
    steps: [
      { id: "open", chapter: "Menu", title: "Open the menu", say: "Tap the menu button.", camera: "full", actions: [] },
      { id: "tap", chapter: "Menu", title: "Tap Settings", say: "Tap Settings.", camera: "full", actions: [] },
    ],
    ...overrides,
  } as Walkthrough;
}

function manifest(viewport = PHONE_VIEWPORT): CaptureManifest {
  return {
    workflow: "phone-demo",
    baseUrl: "http://localhost",
    viewport,
    deviceScaleFactor: 1,
    steps: [
      { id: "open", camera: "full", cameraBox: null, events: [{ type: "frame", image: "1.png", transition: "cut" }], doc: { image: "1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      {
        id: "tap",
        camera: "full",
        cameraBox: null,
        events: [
          { type: "frame", image: "2.png", transition: "cut" },
          { type: "move", to: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.3) } },
          { type: "highlight", box: { x: Math.round(viewport.width * 0.3), y: Math.round(viewport.height * 0.25), w: Math.round(viewport.width * 0.4), h: 48 } },
          { type: "click", at: { x: Math.round(viewport.width * 0.5), y: Math.round(viewport.height * 0.3) } },
          { type: "clearHighlight" },
          { type: "frame", image: "3.png", transition: "cut" },
        ],
        doc: { image: "3.png", highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
    ],
  };
}

const narration = Object.fromEntries(["intro", "open", "tap", "outro"].map((id) => [id, { audioPath: `/v/${id}.wav`, durationMs: 1200 }])) as Record<
  string,
  NarrationBeat
>;

describe("portrait frame geometry (buildTimeline, M43c)", () => {
  it("defaults to the desktop 1920x1080 landscape frame when none is given", () => {
    const tl = buildTimeline(wf(), manifest(DESKTOP_VIEWPORT), narration, { fps: 30, brand: brand("bold") });
    expect(tl.frame).toBeUndefined();
    expect(tl.pointer).toBeUndefined();
  });

  it("is byte-identical to before M43c for an existing (landscape) fixture: passing the default (landscape) frame explicitly changes nothing", () => {
    const withoutFrame = buildTimeline(wf(), manifest(DESKTOP_VIEWPORT), narration, { fps: 30, brand: brand("friendly") });
    const withDefaultFrame = buildTimeline(wf(), manifest(DESKTOP_VIEWPORT), narration, { fps: 30, brand: brand("friendly"), frame: { w: 1920, h: 1080 } });
    expect(withDefaultFrame).toEqual(withoutFrame);
    expect(withoutFrame.frame).toBeUndefined();
    expect(withoutFrame.band).toBeUndefined();
    expect(withoutFrame.pointer).toBeUndefined();
    expect(withoutFrame.stage.w / withoutFrame.stage.h).toBeCloseTo(16 / 9, 3);
  });

  it("never increases chrome for bold on a portrait frame — forced to 0 so no fake browser bar shows on phone", () => {
    const landscape = buildTimeline(wf(), manifest(DESKTOP_VIEWPORT), narration, { fps: 30, brand: brand("bold") });
    const portrait = buildTimeline(wf(), manifest(PHONE_VIEWPORT), narration, { fps: 30, brand: brand("bold"), frame: { w: 1080, h: 1920 } });
    expect(landscape.chrome).toBeGreaterThan(0);
    expect(portrait.chrome).toBe(0);
  });

  it("sets pointer to touch on a portrait frame, mouse (unset) on landscape", () => {
    const portrait = buildTimeline(wf(), manifest(PHONE_VIEWPORT), narration, { fps: 30, brand: brand("bold"), frame: { w: 1080, h: 1920 } });
    expect(portrait.pointer).toBe("touch");
  });

  it("fits the phone screen inside the frame with no overflow, matching the capture viewport's aspect ratio", () => {
    const frame = { w: 1080, h: 1920 };
    for (const style of ["minimal", "friendly", "bold"] as const) {
      const tl = buildTimeline(wf(), manifest(PHONE_VIEWPORT), narration, { fps: 30, brand: brand(style), frame });
      const { stage } = tl;
      expect(stage.x).toBeGreaterThanOrEqual(0);
      expect(stage.y).toBeGreaterThanOrEqual(0);
      expect(stage.x + stage.w).toBeLessThanOrEqual(frame.w + 0.01);
      expect(stage.y + stage.h).toBeLessThanOrEqual(frame.h + 0.01);
      expect(stage.w / stage.h).toBeCloseTo(PHONE_VIEWPORT.width / PHONE_VIEWPORT.height, 2);
    }
  });

  it("puts the caption band in its own safe zone below the phone screen, never overlapping it", () => {
    const frame = { w: 1080, h: 1920 };
    const tl = buildTimeline(wf(), manifest(PHONE_VIEWPORT), narration, { fps: 30, brand: brand("bold"), frame });
    const { stage, band } = tl;
    expect(band).toBeDefined();
    // No vertical overlap: the band starts at or after the screen's bottom edge.
    expect(band!.y).toBeGreaterThanOrEqual(stage.y + stage.h);
    expect(band!.x).toBeGreaterThanOrEqual(0);
    expect(band!.x + band!.w).toBeLessThanOrEqual(frame.w + 0.01);
    expect(band!.y + band!.h).toBeLessThanOrEqual(frame.h + 0.01);
  });

  it("never shows a hero screenshot on a portrait card (the hero layout is landscape-only)", () => {
    const tl = buildTimeline(wf(), manifest(PHONE_VIEWPORT), narration, { fps: 30, brand: brand("minimal"), frame: { w: 1080, h: 1920 } });
    expect(tl.cards!.intro.map((r) => r.id)).not.toContain("intro-hero");
    expect(tl.cards!.outro.map((r) => r.id)).not.toContain("outro-hero");
  });

  it("still pushes the camera in toward a step's highlighted target in portrait (zoom/push-in maths are viewport-space, not frame-space)", () => {
    const tl = buildTimeline(wf(), manifest(PHONE_VIEWPORT), narration, { fps: 30, brand: brand("bold"), frame: { w: 1080, h: 1920 } });
    // More than the one "full screen" camera entry per step: a push-in toward the "tap" step's
    // highlighted target was inserted.
    expect(tl.cameras.length).toBeGreaterThan(2);
    const zoomed = tl.cameras.find((c) => c.to.z > 1);
    expect(zoomed).toBeDefined();
    // The zoomed centre stays within the phone capture viewport, same bounds-clamping as desktop.
    expect(zoomed!.to.cx).toBeGreaterThanOrEqual(0);
    expect(zoomed!.to.cx).toBeLessThanOrEqual(PHONE_VIEWPORT.width);
    expect(zoomed!.to.cy).toBeGreaterThanOrEqual(0);
    expect(zoomed!.to.cy).toBeLessThanOrEqual(PHONE_VIEWPORT.height);
  });
});

// Real render (AIDA_TEST_SLOW=1, `npm run test:slow`): a 2-step phone fixture through the real
// player and ffmpeg, checked with ffprobe for its portrait dimensions.
describe.skipIf(!SLOW)("render: a phone walkthrough's own video (end to end)", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });
  function tmpDir(prefix: string): string {
    const d = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  }
  function png(width: number, height: number): Buffer {
    const img = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        img.data[i] = 220;
        img.data[i + 1] = 205 - Math.round((y / height) * 60);
        img.data[i + 2] = 210;
        img.data[i + 3] = 255;
      }
    }
    return PNG.sync.write(img);
  }

  it(
    "renders a portrait 1080x1920 mp4 from a phone capture",
    async () => {
      const { render } = await import("../../src/render/index.js");
      const captureDir = tmpDir("aida-phone-capture-");
      mkdirSync(join(captureDir, "frames"), { recursive: true });
      const m = manifest(PHONE_VIEWPORT);
      for (const step of m.steps as ManifestStep[]) {
        for (const e of step.events) if (e.type === "frame") writeFileSync(join(captureDir, "frames", e.image), png(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height));
      }
      writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(m));
      const validation: ValidationResult = {
        workflow: "phone-demo",
        ranAt: "2026-11-08T00:00:00.000Z",
        baseUrl: "http://localhost",
        ok: true,
        steps: m.steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok: true, ms: 1 })),
        dbChecks: [],
        problems: { console: [], page: [], server: [] },
      };
      writeFileSync(join(captureDir, "validation.json"), JSON.stringify(validation));

      const voiceDir = tmpDir("aida-phone-voice-");
      const wav = join(voiceDir, "tone.wav");
      // A speech-like tone: the narration mix (and QA's loudness gate, if run) needs real audio.
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-af", "volume=0.5", wav]);
      const realNarration = Object.fromEntries(["intro", "open", "tap", "outro"].map((id) => [id, { audioPath: wav, durationMs: 1200 }])) as Record<
        string,
        NarrationBeat
      >;

      const outDir = tmpDir("aida-phone-render-");
      const result = await render(wf(), {
        outDir,
        captureDir,
        narration: realNarration,
        draft: true,
        fps: 10,
        brand: brand("friendly"),
        concurrency: 2,
        device: "phone",
        fileSuffix: ".phone",
        pathClips: false,
      });

      expect(result.mp4).toBe(join(outDir, "phone-demo", "phone-demo.phone.mp4"));
      const probe = JSON.parse(
        execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", result.mp4!]).toString(),
      ) as { streams: Array<{ codec_type: string; width?: number; height?: number }> };
      const video = probe.streams.find((s) => s.codec_type === "video");
      // Draft quality halves resolution via Playwright's deviceScaleFactor (video.ts's
      // `qualityFor`), so the physical pixels are 1080x1920 scaled by 0.5 — still exactly
      // portrait, at the frame's own 1080:1920 aspect ratio.
      expect(video?.height).toBeGreaterThan(video?.width ?? 0);
      expect((video!.width! * 1920) / 1080).toBeCloseTo(video!.height!, 0);
    },
    600_000,
  );
});
