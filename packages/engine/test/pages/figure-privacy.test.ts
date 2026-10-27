// M36 review (privacy): blur declared only on a path step still rules out every before-click
// frame on the main page — that frame can show a screen the path blurs, with nothing over it.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { buildPage } from "../../src/pages/build.js";
import type { Walkthrough } from "../../src/walkthrough/index.js";

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function writeRun(dir: string, steps: ManifestStep[], frames: string[]): void {
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const f of frames) writeFileSync(join(dir, "frames", f), TINY_PNG);
  const manifest: CaptureManifest = { workflow: "acme-pay", baseUrl: "http://127.0.0.1:3100", viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, steps };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "acme-pay",
    ranAt: "2026-10-27T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok: true,
    steps: steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok: true, ms: 1 })),
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
}

const BUTTON = { x: 1200, y: 100, w: 150, h: 40 };
// Main step 2: highlighted on the list page, then the click opened the payment form.
const mainSteps: ManifestStep[] = [
  { id: "open", camera: "full", cameraBox: null, events: [{ type: "frame", image: "m1.png", transition: "cut" }], doc: { image: "m1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
  {
    id: "new",
    camera: "full",
    cameraBox: null,
    events: [
      { type: "frame", image: "m2.png", transition: "cut" },
      { type: "highlight", box: BUTTON },
      { type: "click", at: { x: 1275, y: 120 } },
      { type: "clearHighlight" },
      { type: "frame", image: "m3.png", transition: "fade" },
    ],
    doc: { image: "m3.png", highlights: [] },
    impact: { urls: ["/payments/new"], requests: [] },
    checks: [],
  },
];

function wf(pathBlur: boolean): Walkthrough {
  return {
    walkthrough: "acme-pay",
    title: "Take a payment",
    start: { page: "/payments" },
    steps: [
      { id: "open", title: "Open Payments", page_text: "Open **Payments**.", actions: [] },
      { id: "new", title: "New payment", page_text: "Select **New payment**.", actions: [] },
    ],
    paths: [
      {
        id: "from-booking",
        title: "From the booking",
        when: "Use this from a booking.",
        start: { page: "/bookings/1" },
        steps: [
          {
            id: "open-booking",
            title: "Open the booking",
            page_text: "Open the booking.",
            actions: [],
            ...(pathBlur ? { blur: [{ id: "card", box: { x: 0, y: 0, w: 10, h: 10 } }] } : {}),
          },
        ],
        joins: "new",
      },
    ],
  } as Walkthrough;
}

describe("main page figures with blur declared only on a path (M36)", () => {
  it("never shows the main step's before-click frame", async () => {
    const run = async (pathBlur: boolean) => {
      const captureDir = tmp("aida-fig-capture-");
      writeRun(captureDir, mainSteps, ["m1.png", "m2.png", "m3.png"]);
      writeRun(
        join(captureDir, "paths", "from-booking"),
        [{ id: "open-booking", camera: "full", cameraBox: null, events: [{ type: "frame", image: "p1.png", transition: "cut" }], doc: { image: "p1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] }],
        ["p1.png"],
      );
      const result = await buildPage(wf(pathBlur), captureDir, tmp("aida-fig-out-"));
      return result.printFigures!.find((f) => f.step === 2)!;
    };
    // No blur anywhere: the frame before the click, with the ring on the button.
    expect((await run(false)).targets).toEqual([BUTTON]);
    // Blur on the path only: the after-frame, and no ring where the button used to be.
    const blurred = await run(true);
    expect(blurred.targets).not.toContainEqual(BUTTON);
  }, 60_000);
});
