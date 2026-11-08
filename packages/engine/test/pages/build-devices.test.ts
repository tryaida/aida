// M43b (decision 40): a walkthrough captured on more than one device — union step numbering
// over the walkthrough's full step list, a device-only step's reader-facing note, both devices'
// shots wrapped in `<DeviceShots>` when a step has more than one, and `index.plain.md` stripped
// back to the primary alone.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../../src/capture/index.js";
import { buildPage } from "../../src/pages/build.js";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

// Three steps: "open-page" and "fill-form" run on every device; "phone-menu" is phone-only, so
// the desktop (primary) capture skips it — its manifest has stepIndex 0 and 2 only.
function walkthrough(): Walkthrough {
  return {
    walkthrough: "add-thing",
    title: "Add a thing",
    summary: "Create a new thing.",
    for: "Office staff",
    start: { signed_in_as: "staff" },
    steps: [
      { id: "open-page", title: "Open the page", page_text: "Click **Things**.", actions: [] },
      { id: "phone-menu", title: "Open the phone menu", page_text: "Tap the menu icon.", actions: [], devices: ["phone"] },
      { id: "fill-form", title: "Fill the form", page_text: "Enter the thing's name.", actions: [] },
    ],
  };
}

function writeFrames(dir: string, names: string[]): void {
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const n of names) writeFileSync(join(dir, "frames", n), TINY_PNG);
}

function writeDesktopCapture(dir: string): void {
  writeFrames(dir, ["d1.png", "d3.png"]);
  const manifest: CaptureManifest = {
    workflow: "add-thing",
    baseUrl: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    device: "desktop",
    steps: [
      { id: "open-page", stepIndex: 0, camera: "full", cameraBox: null, events: [], doc: { image: "d1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      { id: "fill-form", stepIndex: 2, camera: "full", cameraBox: null, events: [], doc: { image: "d3.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "add-thing",
    ranAt: "2026-11-01T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok: true,
    steps: [
      { id: "open-page", title: "Open the page", checks: [], ok: true, ms: 1 },
      { id: "fill-form", title: "Fill the form", checks: [], ok: true, ms: 1 },
    ],
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
}

function writePhoneCapture(dir: string): void {
  writeFrames(dir, ["p1.png", "p2.png", "p3.png"]);
  const manifest: CaptureManifest = {
    workflow: "add-thing",
    baseUrl: "http://127.0.0.1:3100",
    viewport: { width: 412, height: 839 },
    deviceScaleFactor: 2.625,
    device: "phone",
    steps: [
      { id: "open-page", stepIndex: 0, camera: "full", cameraBox: null, events: [], doc: { image: "p1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      { id: "phone-menu", stepIndex: 1, camera: "full", cameraBox: null, events: [], doc: { image: "p2.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      { id: "fill-form", stepIndex: 2, camera: "full", cameraBox: null, events: [], doc: { image: "p3.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
    ],
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "add-thing",
    ranAt: "2026-11-01T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok: true,
    steps: [
      { id: "open-page", title: "Open the page", checks: [], ok: true, ms: 1 },
      { id: "phone-menu", title: "Open the phone menu", checks: [], ok: true, ms: 1 },
      { id: "fill-form", title: "Fill the form", checks: [], ok: true, ms: 1 },
    ],
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
}

describe(
  "buildPage with a secondary device (M43b, decision 40)",
  () => {
    it("numbers steps over the full walkthrough (union), notes the device-only step, wraps both-device steps, and strips plain.md to the primary", async () => {
      const desktopDir = tmpDir("aida-pages-desktop-");
      const phoneDir = tmpDir("aida-pages-phone-");
      const outDir = tmpDir("aida-pages-out-");
      writeDesktopCapture(desktopDir);
      writePhoneCapture(phoneDir);

      const result = await buildPage(walkthrough(), desktopDir, outDir, {
        devices: ["desktop", "phone"],
        secondaryCaptures: [{ device: "phone", captureDir: phoneDir }],
      });

      expect(result.publishable).toBe(true);

      // Union numbering: the desktop-skipped middle step still prints as "2", and the following
      // (desktop) step keeps its true number "3" — never renumbered down to "2".
      const content = readFileSync(result.indexFile, "utf8");
      expect(content).toContain("#### 1. Open the page");
      expect(content).toContain("#### 2. Open the phone menu");
      expect(content).toContain("#### 3. Fill the form");

      // Step 2 (phone-only): a reader-facing note, and the phone's own shot shown plainly (no
      // desktop shot exists for it, so no <DeviceShots> wrapper).
      expect(content).toContain("*On a phone only.*");
      expect(content).toMatch(/!\[Phone screenshot of[^\]]*\]\(screenshots\/phone-step-02\.png\)/);

      // Steps 1 and 3 run on both devices: wrapped, primary first, both images present.
      expect(content).toContain('<DeviceShots devices="desktop,phone">');
      expect(content).toMatch(/!\[Screenshot of[^\]]*\]\(screenshots\/step-01\.png\)/);
      expect(content).toMatch(/!\[Phone screenshot of[^\]]*\]\(screenshots\/phone-step-01\.png\)/);
      expect(content).toMatch(/!\[Screenshot of[^\]]*\]\(screenshots\/step-03\.png\)/);
      expect(content).toMatch(/!\[Phone screenshot of[^\]]*\]\(screenshots\/phone-step-03\.png\)/);

      // Desktop's own screenshots (steps 1 and 3) exist; the phone's secondary ones (steps 1-3)
      // were rendered into the very same screenshots dir, at their own `phone-step-NN.png` names.
      expect(existsSync(join(result.screenshotsDir, "step-01.png"))).toBe(true);
      expect(existsSync(join(result.screenshotsDir, "step-03.png"))).toBe(true);
      expect(existsSync(join(result.screenshotsDir, "phone-step-01.png"))).toBe(true);
      expect(existsSync(join(result.screenshotsDir, "phone-step-02.png"))).toBe(true);
      expect(existsSync(join(result.screenshotsDir, "phone-step-03.png"))).toBe(true);

      // index.plain.md (llms.txt, search, PDF input) reads past every secondary image, down to
      // the primary alone — or to nothing, for the phone-only step.
      const plain = readFileSync(result.plainFile, "utf8");
      expect(plain).not.toContain("DeviceShots");
      expect(plain).not.toContain("phone-step-01.png");
      expect(plain).not.toContain("phone-step-02.png");
      expect(plain).not.toContain("phone-step-03.png");
      expect(plain).toContain("screenshots/step-01.png");
      expect(plain).toContain("screenshots/step-03.png");

      // Frontmatter carries every device, primary first, for the help app's own device switch.
      expect(content).toMatch(/^devices: \[desktop, phone\]$/m);
    }, 60_000);

    it("still builds (desktop-only) when the phone capture never ran — no manifest/validation at all", async () => {
      const desktopDir = tmpDir("aida-pages-desktop-");
      const phoneDir = tmpDir("aida-pages-phone-missing-"); // never written
      const outDir = tmpDir("aida-pages-out-");
      writeDesktopCapture(desktopDir);

      const result = await buildPage(walkthrough(), desktopDir, outDir, {
        devices: ["desktop", "phone"],
        secondaryCaptures: [{ device: "phone", captureDir: phoneDir }],
      });

      // A failed/absent secondary capture never fails the page.
      expect(result.publishable).toBe(true);
      const content = readFileSync(result.indexFile, "utf8");
      expect(content).not.toContain("DeviceShots");
      expect(content).not.toContain("phone-step");
    }, 60_000);

    it("never shows a phone capture whose last run failed or wasn't captured; the phone-only step keeps its note, with no banner", async () => {
      const desktopDir = tmpDir("aida-pages-desktop-");
      const phoneDir = tmpDir("aida-pages-phone-stale-");
      const outDir = tmpDir("aida-pages-out-");
      writeDesktopCapture(desktopDir);
      // An older passing phone capture, then a run that wasn't captured (blocked / no reset):
      // the manifest and frames stay, validation says not captured with no steps.
      writePhoneCapture(phoneDir);
      const validation = JSON.parse(readFileSync(join(phoneDir, "validation.json"), "utf8"));
      writeFileSync(join(phoneDir, "validation.json"), JSON.stringify({ ...validation, ok: false, steps: [], notCaptured: "needs a database reset between devices" }));

      const result = await buildPage(walkthrough(), desktopDir, outDir, {
        devices: ["desktop", "phone"],
        secondaryCaptures: [{ device: "phone", captureDir: phoneDir }],
      });

      expect(result.publishable).toBe(true);
      const content = readFileSync(result.indexFile, "utf8");
      expect(content).not.toContain("phone-step");
      expect(existsSync(join(result.screenshotsDir, "phone-step-01.png"))).toBe(false);
      // The phone-only step: its note, no image, no "Not verified" banner on a passing page.
      expect(content).toContain("#### 2. Open the phone menu");
      expect(content).toContain("*On a phone only.*");
      expect(content).not.toContain("Not verified");
      // Frontmatter names only the devices the page has output for.
      expect(content).not.toMatch(/^devices:/m);
    }, 60_000);

    it("ignores a phone capture that failed (validation.ok false) even with steps that passed", async () => {
      const desktopDir = tmpDir("aida-pages-desktop-");
      const phoneDir = tmpDir("aida-pages-phone-failed-");
      const outDir = tmpDir("aida-pages-out-");
      writeDesktopCapture(desktopDir);
      writePhoneCapture(phoneDir);
      const validation = JSON.parse(readFileSync(join(phoneDir, "validation.json"), "utf8"));
      writeFileSync(join(phoneDir, "validation.json"), JSON.stringify({ ...validation, ok: false }));

      const result = await buildPage(walkthrough(), desktopDir, outDir, {
        devices: ["desktop", "phone"],
        secondaryCaptures: [{ device: "phone", captureDir: phoneDir }],
      });

      const content = readFileSync(result.indexFile, "utf8");
      expect(content).not.toContain("phone-step");
    }, 60_000);
  },
  120_000,
);
