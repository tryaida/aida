import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../../src/capture/index.js";
import { buildProcedure, buildProcedures } from "../../src/procedures/index.js";

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

function walkthrough(): Walkthrough {
  return {
    walkthrough: "add-competitor",
    title: "Add a competitor",
    for: "office staff",
    start: { signed_in_as: "office-staff", page: "/competitors" },
    steps: [
      { id: "open", title: "Open competitors", page_text: "Click **Competitors** in the menu.", actions: [] },
      { id: "fill", title: "Fill the form", page_text: "Enter their *first name*.", actions: [] },
    ],
  };
}

function writeCapture(captureDir: string, opts: { ok?: boolean } = {}): void {
  mkdirSync(join(captureDir, "frames"), { recursive: true });
  writeFileSync(join(captureDir, "frames", "s1.png"), TINY_PNG);
  writeFileSync(join(captureDir, "frames", "s2.png"), TINY_PNG);

  const manifest: CaptureManifest = {
    workflow: "add-competitor",
    capturedAt: "2026-10-20T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    steps: [
      {
        id: "open",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: "s1.png", highlights: [] },
        impact: { urls: ["http://127.0.0.1:3100/competitors"], requests: [] },
        checks: [],
      },
      {
        id: "fill",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: "s2.png", highlights: [] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
    ],
  } as unknown as CaptureManifest;
  writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));

  const ok = opts.ok ?? true;
  const validation: ValidationResult = {
    ok,
    ranAt: "2026-10-20T00:00:05.000Z",
    steps: [
      { id: "open", ok: true },
      { id: "fill", ok },
    ],
    problems: { page: [], server: [] },
    dbChecks: [],
  } as unknown as ValidationResult;
  writeFileSync(join(captureDir, "validation.json"), JSON.stringify(validation));
}

/** A fake `pagesDir/<id>/screenshots/step-NN.png` for each step — stands in for what
 * pages/build.ts's `annotateFrame` actually wrote (blur/callouts already burned in). Content
 * distinct from `TINY_PNG` (the raw capture frame) so a test can tell which one a copy used —
 * doesn't need to be a real PNG, only distinguishable bytes. */
const BLURRED_PNG = Buffer.from("not-the-raw-frame-this-is-the-annotated-page-screenshot");

function writePagesScreenshots(pagesDir: string, id: string, stepCount: number): void {
  const dir = join(pagesDir, id, "screenshots");
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= stepCount; n++) {
    writeFileSync(join(dir, `step-${String(n).padStart(2, "0")}.png`), BLURRED_PNG);
  }
}

describe("buildProcedure", () => {
  it("builds ordered steps with plain-text instructions and a screenshot URL, only for passed captures", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    const publicDir = tmpDir("aida-proc-public-");
    const pagesDir = tmpDir("aida-proc-pages-");
    writeCapture(captureDir);
    writePagesScreenshots(pagesDir, "add-competitor", 2);

    const proc = buildProcedure(walkthrough(), captureDir, { publicDir, pagesDir });
    expect(proc).toBeDefined();
    expect(proc!.id).toBe("add-competitor");
    // `role` is the persona's id; `roleName` the reader-facing name (here found in `for:`).
    expect(proc!.start).toEqual({ page: "/competitors", role: "office-staff", roleName: "office staff" });
    expect(proc!.steps).toHaveLength(2);
    expect(proc!.steps[0]).toMatchObject({ n: 1, title: "Open competitors", instruction: "Click Competitors in the menu." });
    expect(proc!.steps[0].screenshot).toBe("/screenshots/add-competitor/step-01.png");
    const publicScreenshot = join(publicDir, "screenshots", "add-competitor", "step-01.png");
    expect(existsSync(publicScreenshot)).toBe(true);
    expect(proc!.impactRoutes).toEqual(["/competitors"]);

    // The safety-critical bit (M22 review): the published copy is the page's already-annotated
    // screenshot (blur/callouts burned in), never the raw capture frame straight from
    // captureDir/frames — if `blur:` had masked something in this step, a raw-frame copy would
    // publish it unmasked.
    expect(readFileSync(publicScreenshot)).toEqual(BLURRED_PNG);
    expect(readFileSync(publicScreenshot)).not.toEqual(TINY_PNG);
  });

  it("removes step screenshots an earlier build published that the procedure no longer lists", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    const publicDir = tmpDir("aida-proc-public-");
    const pagesDir = tmpDir("aida-proc-pages-");
    writeCapture(captureDir);
    writePagesScreenshots(pagesDir, "add-competitor", 2);
    const shots = join(publicDir, "screenshots", "add-competitor");
    mkdirSync(join(shots, "paths"), { recursive: true });
    for (const stale of ["step-03.png", "phone-step-02.png", "paths/old-step-01.png"]) writeFileSync(join(shots, stale), TINY_PNG);
    writeFileSync(join(shots, "phone-poster-step-02.png"), TINY_PNG); // index-stage's, not ours

    buildProcedure(walkthrough(), captureDir, { publicDir, pagesDir });
    expect(existsSync(join(shots, "step-01.png"))).toBe(true);
    expect(existsSync(join(shots, "step-02.png"))).toBe(true);
    expect(existsSync(join(shots, "step-03.png"))).toBe(false);
    expect(existsSync(join(shots, "phone-step-02.png"))).toBe(false);
    expect(existsSync(join(shots, "paths", "old-step-01.png"))).toBe(false);
    expect(existsSync(join(shots, "phone-poster-step-02.png"))).toBe(true);
  });

  it("keeps start.role the role id and puts the reader's name for it in start.roleName (M26)", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    writeCapture(captureDir);
    const wf = { ...walkthrough(), start: { signed_in_as: "admin", page: "/competitors" } };
    const proc = buildProcedure(wf, captureDir, {
      publicDir: tmpDir("aida-proc-public-"),
      readerNames: { roles: { admin: "an organiser" } },
    });
    expect(proc!.start.role).toBe("admin");
    expect(proc!.start.roleName).toBe("an organiser");
    const plain = buildProcedure({ ...walkthrough(), start: { persona: { role: "office_staff" }, page: "/" } }, captureDir, { publicDir: tmpDir("aida-proc-public-") });
    expect(plain!.start).toMatchObject({ role: "office_staff", roleName: "office staff" });
  });

  it("never copies a screenshot when pagesDir is omitted — no raw-frame fallback", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    const publicDir = tmpDir("aida-proc-public-");
    writeCapture(captureDir);

    const proc = buildProcedure(walkthrough(), captureDir, { publicDir });
    expect(proc!.steps[0].screenshot).toBeUndefined();
    expect(existsSync(join(publicDir, "screenshots"))).toBe(false);
  });

  it("returns undefined when the capture didn't pass — never hands an agent an unverified procedure", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    writeCapture(captureDir, { ok: false });
    const proc = buildProcedure(walkthrough(), captureDir, { publicDir: tmpDir("aida-proc-public-") });
    expect(proc).toBeUndefined();
  });

  // M43b (decision 40): a step also captured on a phone gets its own `phoneScreenshot` URL,
  // staged from the page's own `screenshots/phone-step-NN.png` (never a raw capture frame).
  it("adds phoneScreenshot when the page rendered one, and omits it for a step that has none", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    const publicDir = tmpDir("aida-proc-public-");
    const pagesDir = tmpDir("aida-proc-pages-");
    writeCapture(captureDir);
    writePagesScreenshots(pagesDir, "add-competitor", 2);
    // Only step 1 has a phone shot (e.g. step 2 is desktop-only, or the phone capture stopped there).
    mkdirSync(join(pagesDir, "add-competitor", "screenshots"), { recursive: true });
    writeFileSync(join(pagesDir, "add-competitor", "screenshots", "phone-step-01.png"), BLURRED_PNG);

    const proc = buildProcedure(walkthrough(), captureDir, { publicDir, pagesDir });
    expect(proc!.steps[0].phoneScreenshot).toBe("/screenshots/add-competitor/phone-step-01.png");
    expect(existsSync(join(publicDir, "screenshots", "add-competitor", "phone-step-01.png"))).toBe(true);
    expect(proc!.steps[1].phoneScreenshot).toBeUndefined();
  });

  it("aligns steps by stepIndex, not array position, when a device-only step is absent from the manifest", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    mkdirSync(join(captureDir, "frames"), { recursive: true });
    writeFileSync(join(captureDir, "frames", "s1.png"), TINY_PNG);
    writeFileSync(join(captureDir, "frames", "s3.png"), TINY_PNG);
    // 3-step walkthrough; this device's manifest skipped the middle (device-only) step — its two
    // entries carry stepIndex 0 and 2, not array positions 0 and 1.
    const manifest: CaptureManifest = {
      workflow: "add-competitor",
      baseUrl: "http://127.0.0.1:3100",
      viewport: { width: 1440, height: 810 },
      deviceScaleFactor: 2,
      steps: [
        { id: "open", stepIndex: 0, camera: "full", cameraBox: null, events: [], doc: { image: "s1.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
        { id: "end", stepIndex: 2, camera: "full", cameraBox: null, events: [], doc: { image: "s3.png", highlights: [] }, impact: { urls: [], requests: [] }, checks: [] },
      ],
    };
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));
    const validation: ValidationResult = {
      workflow: "add-competitor",
      ranAt: "2026-10-20T00:00:05.000Z",
      baseUrl: "http://127.0.0.1:3100",
      ok: true,
      steps: [
        { id: "open", title: "Open", checks: [], ok: true, ms: 1 },
        { id: "end", title: "End", checks: [], ok: true, ms: 1 },
      ],
      dbChecks: [],
      problems: { console: [], page: [], server: [] },
    };
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(validation));

    const wf: Walkthrough = {
      walkthrough: "add-competitor",
      title: "Add a competitor",
      steps: [
        { id: "open", title: "Open", page_text: "Open it.", actions: [] },
        { id: "middle", title: "Phone-only step", page_text: "Tap the menu.", actions: [], devices: ["phone"] },
        { id: "end", title: "End", page_text: "Finish.", actions: [] },
      ],
    };
    const proc = buildProcedure(wf, captureDir, { publicDir: tmpDir("aida-proc-public-") });
    expect(proc).toBeDefined();
    // The last step is really walkthrough step 3 ("End"), not array position 1 ("Phone-only step").
    expect(proc!.steps.map((s) => s.n)).toEqual([1, 3]);
    expect(proc!.steps[1]).toMatchObject({ n: 3, title: "End" });

    // With the page's phone screenshot for it, the phone-only step is listed too: phone shot
    // only, and which devices it happens on.
    const pagesDir = tmpDir("aida-proc-pages-");
    const publicDir = tmpDir("aida-proc-public-");
    writePagesScreenshots(pagesDir, "add-competitor", 3);
    writeFileSync(join(pagesDir, "add-competitor", "screenshots", "phone-step-02.png"), BLURRED_PNG);
    const withPhone = buildProcedure(wf, captureDir, { publicDir, pagesDir });
    expect(withPhone!.steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(withPhone!.steps[1]).toEqual({
      n: 2,
      title: "Phone-only step",
      instruction: "Tap the menu.",
      phoneScreenshot: "/screenshots/add-competitor/phone-step-02.png",
      devices: ["phone"],
    });
  });

  it("returns undefined when the capture says it wasn't captured", () => {
    const captureDir = tmpDir("aida-proc-capture-");
    writeCapture(captureDir);
    const validation = JSON.parse(readFileSync(join(captureDir, "validation.json"), "utf8"));
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify({ ...validation, notCaptured: "blocked" }));
    expect(buildProcedure(walkthrough(), captureDir, { publicDir: tmpDir("aida-proc-public-") })).toBeUndefined();
  });
});

describe("buildProcedures", () => {
  it("writes procedures.json sorted by id, skipping failed walkthroughs", () => {
    const passDir = tmpDir("aida-proc-capture-");
    writeCapture(passDir);
    const failDir = tmpDir("aida-proc-capture-");
    writeCapture(failDir, { ok: false });
    const publicDir = tmpDir("aida-proc-public-");

    const failingWf: Walkthrough = { ...walkthrough(), walkthrough: "zzz-fails" };

    const result = buildProcedures({
      sources: [
        { wf: walkthrough(), captureDir: passDir },
        { wf: failingWf, captureDir: failDir },
      ],
      publicDir,
    });

    expect(result.procedures).toHaveLength(1);
    expect(result.procedures[0].id).toBe("add-competitor");
    expect(result.outFile).toBe(join(publicDir, "procedures.json"));
    const onDisk = JSON.parse(readFileSync(result.outFile!, "utf8"));
    expect(onDisk).toHaveLength(1);
  });

  // Regression (review finding index-stage.ts:179): `aida build <one-id>` used to rebuild
  // procedures.json from just that run's sources, wiping every other walkthrough's entry.
  it("merges this run's procedures with existing ones by id, keeping an untouched walkthrough's entry", () => {
    const passDir = tmpDir("aida-proc-capture-");
    writeCapture(passDir);
    const publicDir = tmpDir("aida-proc-public-");

    const untouched = { id: "untouched-flow", title: "Untouched flow", start: {}, steps: [] };
    const result = buildProcedures({
      sources: [{ wf: walkthrough(), captureDir: passDir }],
      publicDir,
      existing: [untouched],
    });

    expect(result.procedures.map((p) => p.id).sort()).toEqual(["add-competitor", "untouched-flow"]);
    const onDisk = JSON.parse(readFileSync(result.outFile!, "utf8"));
    expect(onDisk.map((p: { id: string }) => p.id).sort()).toEqual(["add-competitor", "untouched-flow"]);
  });

  it("prunes an existing entry this run attempted but could no longer build (unpublishable)", () => {
    const failDir = tmpDir("aida-proc-capture-");
    writeCapture(failDir, { ok: false });
    const publicDir = tmpDir("aida-proc-public-");

    const stale = { id: "add-competitor", title: "Stale", start: {}, steps: [] };
    const result = buildProcedures({
      sources: [{ wf: walkthrough(), captureDir: failDir }], // fails validation -> no procedure produced
      publicDir,
      existing: [stale],
      attemptedIds: ["add-competitor"],
    });

    expect(result.procedures).toHaveLength(0);
  });

  it("prunes an existing entry whose walkthrough no longer exists on disk (validIds given)", () => {
    const publicDir = tmpDir("aida-proc-public-");
    const deleted = { id: "deleted-flow", title: "Deleted", start: {}, steps: [] };
    const kept = { id: "kept-flow", title: "Kept", start: {}, steps: [] };

    const result = buildProcedures({
      sources: [],
      publicDir,
      existing: [deleted, kept],
      validIds: ["kept-flow"],
    });

    expect(result.procedures.map((p) => p.id)).toEqual(["kept-flow"]);
  });
});
