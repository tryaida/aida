// `aida proof` (M34): picks a captured walkthrough, renders the video's intro and a step frame
// with the real player, and composes the sheet (print panels need a built page; covered by the
// pdf tests). Acme fixture, no app needed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/types.js";
import { buildProof, pickWalkthrough, proofInstants, proofSheetHtml } from "../../src/proof/index.js";
import { resolveArtifactBrand } from "../../src/render/brand.js";
import { buildTimeline } from "../../src/render/timeline.js";

const WALKTHROUGH = `walkthrough: add-order
version: 1
title: Add an order
product: Acme
for: office staff
start:
  page: /orders
intro:
  say: Here's how to add an order.
outro:
  say: Done.
steps:
  - id: open
    title: Open Orders
    say: Open orders.
    camera: full
    actions: []
`;

function frame(): Buffer {
  const png = new PNG({ width: 1440, height: 810 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 240;
    png.data[i + 1] = 244;
    png.data[i + 2] = 250;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function project(): ResolvedConfig {
  const dir = mkdtempSync(join(tmpdir(), "aida-proof-"));
  mkdirSync(join(dir, "walkthroughs"));
  writeFileSync(join(dir, "walkthroughs", "add-order.yaml"), WALKTHROUGH);
  const capture = join(dir, ".build", "add-order", "capture");
  mkdirSync(join(capture, "frames"), { recursive: true });
  writeFileSync(join(capture, "frames", "1.png"), frame());
  writeFileSync(
    join(capture, "manifest.json"),
    JSON.stringify({
      workflow: "add-order",
      baseUrl: "http://localhost",
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 1,
      steps: [
        {
          id: "open",
          camera: "full",
          cameraBox: null,
          events: [
            { type: "frame", image: "1.png", transition: "cut" },
            { type: "move", to: { x: 300, y: 200 } },
            { type: "highlight", box: { x: 250, y: 180, w: 120, h: 40 } },
            { type: "click", at: { x: 300, y: 200 } },
            { type: "clearHighlight" },
          ],
          doc: { image: "1.png", highlights: [] },
          impact: { urls: [], requests: [] },
          checks: [],
        },
      ],
    }),
  );
  return {
    configDir: dir,
    walkthroughsDir: join(dir, "walkthroughs"),
    buildDir: join(dir, ".build"),
    outDir: dir,
    app: { baseUrl: "http://localhost" },
    brand: { name: "Acme", primaryColor: "#4f46e5", style: "friendly" },
  } as unknown as ResolvedConfig;
}

describe("aida proof", () => {
  it("says what to run when nothing has been captured", () => {
    const dir = mkdtempSync(join(tmpdir(), "aida-proof-empty-"));
    expect(() => pickWalkthrough({ walkthroughsDir: join(dir, "w"), buildDir: join(dir, ".build") })).toThrow(/aida build/);
  });

  it("picks frames after the intro has settled and while the first ring is up", () => {
    const config = project();
    const picked = pickWalkthrough(config);
    const narration = Object.fromEntries(["intro", "open", "outro"].map((id) => [id, { audioPath: "", durationMs: 1500 }]));
    const tl = buildTimeline(picked.wf, picked.manifest, narration, { fps: 15, brand: resolveArtifactBrand(config) });
    const at = proofInstants(tl);
    expect(at.intro).toBeLessThan(tl.stageIn.t0);
    expect(at.step).toBeGreaterThanOrEqual(tl.highlights[0].t0);
    expect(at.step).toBeLessThanOrEqual(tl.highlights[0].t1);
  });

  it("renders the video panels and the sheet into <buildDir>/proof", async () => {
    const config = project();
    const result = await buildProof(config);
    expect(result.dir).toBe(join(config.buildDir, "proof"));
    expect(result.style).toBe("friendly");
    expect(result.panels.map((p) => p.id)).toEqual(["intro", "step"]);
    for (const f of ["proof.png", "proof.html", "proof.json", "intro.png", "step.png"]) expect(existsSync(join(result.dir, f)), f).toBe(true);
    expect(PNG.sync.read(readFileSync(result.png)).width).toBe(1800);
    expect(JSON.parse(readFileSync(result.json, "utf8")).walkthrough).toBe("add-order");
  }, 90_000);

  it("escapes names in the sheet", () => {
    const html = proofSheetHtml(resolveArtifactBrand({ configDir: "/x", brand: { name: "<b>Acme</b>" } }), { walkthrough: "x", title: "T", steps: [] } as never, [], "2026-10-27T00:00:00Z");
    expect(html).not.toContain("<b>Acme</b>");
  });
});
