// M34 video presets and polish, at the timeline level: stage framing per preset, card schedules,
// intro facts and outro site line, step-numbered highlights that come up as the pointer moves,
// and the camera's push-in toward each step's target.
import { describe, expect, it } from "vitest";
import type { CaptureManifest } from "../../src/capture/index.js";
import { resolveArtifactBrand } from "../../src/render/brand.js";
import { cameraAt } from "../../src/render/state.js";
import { buildTimeline } from "../../src/render/timeline.js";
import type { Walkthrough } from "../../src/walkthrough/types.js";

const BOX = { x: 600, y: 300, w: 160, h: 40 };

function fixture(camera: Walkthrough["steps"][number]["camera"] = "full") {
  const wf: Walkthrough = {
    walkthrough: "acme-order",
    title: "Add an order",
    product: "Acme",
    for: "office-staff",
    intro: { say: "Intro" },
    outro: { say: "Outro", recap: ["Open Orders", "Save"] },
    steps: [
      { id: "open", chapter: "Orders", title: "Open Orders", say: "Open orders", camera: "full", actions: [] },
      { id: "save", chapter: "Orders", title: "Save", say: "Click save", camera, actions: [] },
    ],
  } as Walkthrough;
  const manifest: CaptureManifest = {
    workflow: "acme-order",
    baseUrl: "http://localhost",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 1,
    steps: [
      { id: "open", camera: "full", cameraBox: null, events: [{ type: "frame", image: "1.png", transition: "cut" }], doc: { image: "1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      {
        id: "save",
        camera: camera ?? "full",
        cameraBox: camera && camera !== "full" ? { x: 0, y: 0, w: 720, h: 405 } : null,
        events: [
          { type: "frame", image: "2.png", transition: "cut" },
          { type: "move", to: { x: 680, y: 320 } },
          { type: "frame", image: "3.png", transition: "cut" },
          { type: "highlight", box: BOX },
          { type: "click", at: { x: 680, y: 320 } },
          { type: "clearHighlight" },
          { type: "frame", image: "4.png", transition: "cut" },
        ],
        doc: { image: "4.png", highlights: [BOX] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
    ],
  };
  const narration = Object.fromEntries(["intro", "open", "save", "outro"].map((id) => [id, { audioPath: `/v/${id}.wav`, durationMs: 1500 }]));
  return { wf, manifest, narration };
}

const brand = (style: "minimal" | "friendly" | "bold", extra: object = {}) =>
  resolveArtifactBrand({ configDir: "/nonexistent", brand: { name: "Acme", style }, ...extra });

describe("presets on the timeline", () => {
  it("frames the stage under a browser bar for bold only, keeping 16:9", () => {
    const { wf, manifest, narration } = fixture();
    const bold = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("bold") });
    const friendly = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("friendly") });
    expect(bold.chrome).toBeGreaterThan(0);
    expect(friendly.chrome).toBe(0);
    for (const tl of [bold, friendly]) expect(tl.stage.w / tl.stage.h).toBeCloseTo(16 / 9, 2);
    expect(bold.stage.y).toBe(24 + bold.chrome!);
    expect(bold.brand.style).toBe("bold");
  });

  it("schedules card reveals per preset (friendly pops its panel in)", () => {
    const { wf, manifest, narration } = fixture();
    const friendly = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("friendly") });
    const minimal = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("minimal") });
    expect(friendly.cards!.intro[0].id).toBe("intro-panel");
    expect(minimal.cards!.intro.map((r) => r.id)).toContain("intro-hero");
    expect(friendly.cards!.intro.map((r) => r.id)).not.toContain("intro-hero");
    expect(friendly.cards!.outro.filter((r) => r.id.startsWith("recap-"))).toHaveLength(2);
  });

  it("puts the reader and step count on the intro and the site on the outro", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("bold", { publish: { siteUrl: "https://help.example.com/" } }) });
    expect(tl.intro.reader).toBe("Office staff");
    expect(tl.intro.facts).toEqual(["2 steps"]);
    expect(tl.outro.site).toBe("help.example.com");
    expect(tl.chips.map((c) => c.eyebrow)).toEqual(["Step 1 of 2", "Step 2 of 2"]);
  });
});

describe("highlight and zoom to target", () => {
  it("numbers the ring with its step and brings it up as the pointer sets off", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30 });
    expect(tl.highlights).toHaveLength(1);
    expect(tl.highlights[0].num).toBe(2);
    expect(tl.highlights[0].t0).toBeCloseTo(tl.moves[0].t0, 5);
  });

  it("pushes the camera in toward the target, then the next scene eases back out, seek-safe", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("bold") });
    const hi = tl.highlights[0];
    const push = tl.cameras.find((c) => c.to.z > 1)!;
    expect(push.t0).toBeLessThan(hi.t1);
    const zoomed = cameraAt(tl, push.t1);
    expect(zoomed.z).toBeCloseTo(1.3, 2);
    expect(zoomed.cx).toBe(BOX.x + BOX.w / 2);
    // Cameras never overlap (an overlap would jump), and the same t always gives the same frame.
    for (let i = 1; i < tl.cameras.length; i++) expect(tl.cameras[i].t0).toBeGreaterThanOrEqual(tl.cameras[i - 1].t1 - 1e-9);
    expect(cameraAt(tl, hi.t0 + 0.4)).toEqual(cameraAt(tl, hi.t0 + 0.4));
    expect(cameraAt(tl, 0).z).toBe(1);
  });

  it("pulls back as soon as a new frame follows the click, a hard cut included", () => {
    const { wf, manifest, narration } = fixture();
    const tl = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("bold") });
    const cut = tl.frames.find((f) => f.src.endsWith("4.png"))!;
    const push = tl.cameras.find((c) => c.to.z > 1)!;
    const out = tl.cameras.find((c) => c.from.z > 1 && c.to.z === 1)!;
    // At the cut, or right after the push-in finishes if it's still going (moves never overlap).
    expect(out.t0).toBeCloseTo(Math.max(cut.t, push.t1), 5);
    expect(out.t0).toBeLessThan(tl.scenes!.find((sc) => sc.id === "save")!.t1);
    expect(cameraAt(tl, out.t1).z).toBe(1);
  });

  it("zooms less for minimal, not at all when turned off or when the step frames itself", () => {
    const { wf, manifest, narration } = fixture();
    const hiT = (tl: ReturnType<typeof buildTimeline>) => tl.cameras.find((c) => c.to.z > 1)!.t1;
    const minimal = buildTimeline(wf, manifest, narration, { fps: 30, brand: brand("minimal") });
    expect(cameraAt(minimal, hiT(minimal)).z).toBeCloseTo(1.16, 2);
    const off = buildTimeline(wf, manifest, narration, { fps: 30, zoomToTarget: false });
    expect(off.cameras.every((c) => c.to.z === 1)).toBe(true);
    const own = fixture({ focus: { css: "main" }, zoom: 1.5 });
    const framed = buildTimeline(own.wf, own.manifest, own.narration, { fps: 30 });
    expect(framed.cameras.map((c) => c.to.z)).toEqual([1, 1.5]);
  });
});

describe("render cache", () => {
  it("hashes the player's own files, so a player change re-renders cached videos", async () => {
    const { existsSync } = await import("node:fs");
    const { playerAssetFiles } = await import("../../src/render/bundle.js");
    const files = await playerAssetFiles();
    expect(files.map((f) => f.split("/").pop())).toEqual(["index.html", "player.js", "player.css"]);
    expect(files.every((f) => existsSync(f))).toBe(true);
  });
});
