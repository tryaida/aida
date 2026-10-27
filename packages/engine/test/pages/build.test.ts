import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ValidationResult } from "../../src/capture/index.js";
import { buildPage } from "../../src/pages/build.js";

// A tiny, valid 1x1 PNG — annotateFrame scales to manifest.viewport regardless of the source
// image's real pixel size, so this stands in for a real captured frame in these unit tests.
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
    walkthrough: "add-thing",
    title: "Add a thing",
    summary: "Create a new thing from the dashboard.",
    product: "Widgets",
    for: "Office staff",
    start: { signed_in_as: "staff", show: "Current show", notes: "Uses demo data only." },
    outro: { recap: ["Search first", "Then add"] },
    steps: [
      {
        id: "open-page",
        chapter: "Getting started",
        title: "Open the page",
        page_text: "Click **Things** in the left menu.",
        actions: [],
      },
      {
        id: "fill-form",
        chapter: "Getting started",
        title: "Fill the form",
        page_text: "Enter the thing's name.",
        actions: [],
      },
    ],
  };
}

function writeCapture(captureDir: string, opts: { stepsOk?: boolean[] } = {}): void {
  mkdirSync(join(captureDir, "frames"), { recursive: true });
  writeFileSync(join(captureDir, "frames", "step1.png"), TINY_PNG);
  writeFileSync(join(captureDir, "frames", "step2.png"), TINY_PNG);

  const stepsOk = opts.stepsOk ?? [true, true];
  const manifest: CaptureManifest = {
    workflow: "add-thing",
    capturedAt: "2026-10-20T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 810 },
    deviceScaleFactor: 2,
    steps: [
      {
        id: "open-page",
        camera: "full",
        cameraBox: null,
        events: [],
        doc: { image: "step1.png", highlights: [{ x: 10, y: 20, w: 100, h: 30 }] },
        impact: { urls: [], requests: [] },
        checks: [],
      },
      ...(stepsOk[0]
        ? [
            {
              id: "fill-form",
              camera: "full" as const,
              cameraBox: null,
              events: [],
              doc: { image: "step2.png", highlights: [] },
              impact: { urls: [], requests: [] },
              checks: [],
            },
          ]
        : []),
    ],
  };
  writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(manifest));

  const validation: ValidationResult = {
    workflow: "add-thing",
    ranAt: "2026-10-21T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok: stepsOk.every(Boolean),
    steps: [
      { id: "open-page", title: "Open the page", checks: [], ok: true, ms: 10 },
      {
        id: "fill-form",
        title: "Fill the form",
        checks: [],
        ok: stepsOk[1] ?? true,
        ms: 10,
        error: stepsOk[1] === false ? "could not find field" : undefined,
      },
    ],
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
  writeFileSync(join(captureDir, "validation.json"), JSON.stringify(validation));
}

describe(
  "buildPage",
  () => {
    it("builds a publishable page with screenshots when the capture fully passed", async () => {
      const captureDir = tmpDir("aida-pages-capture-");
      const outDir = tmpDir("aida-pages-out-");
      writeCapture(captureDir);

      const result = await buildPage(walkthrough(), captureDir, outDir);

      expect(result.passed).toBe(true);
      expect(result.publishable).toBe(true);
      expect(result.problems).toHaveLength(0);
      expect(result.screenshots).toHaveLength(2);
      for (const s of result.screenshots) expect(existsSync(s)).toBe(true);

      expect(result.indexFile.endsWith(".mdx")).toBe(true);

      const content = readFileSync(result.indexFile, "utf8");
      // Frontmatter is plain YAML at the very top of the file — no marker wraps it (MDX/Fumadocs
      // require frontmatter to be the literal first thing in the file).
      expect(content.startsWith("---\ntitle:")).toBe(true);
      expect(content).not.toContain("aida:begin frontmatter");
      expect(content).toContain("passed: true");
      expect(content).toContain("Add a thing");
      expect(content).toContain("#### 1. Open the page");
      expect(content).toContain("#### 2. Fill the form");
      expect(content).toContain("screenshots/step-01.png");
      expect(content).toContain("screenshots/step-02.png");
      expect(content).toContain("Good to know");
      expect(content).toContain("Search first");
      // Every other block uses MDX-safe markers, not HTML comments.
      expect(content).toContain("{/* aida:begin header */}");
      expect(content).not.toContain("<!-- aida:begin");
      // "Before you start": role id humanised (not the raw "staff" persona id verbatim via
      // underscores/dashes), and the internal `start.notes` environment note never appears.
      expect(content).toContain("## Before you start");
      expect(content).not.toContain("Uses demo data only.");

      const plain = readFileSync(result.plainFile, "utf8");
      expect(plain).not.toContain("aida:begin");
      expect(plain).toContain("Add a thing");
    }, 60_000);

    it("refuses to mark the page publishable when a step failed, with a clear problem", async () => {
      const captureDir = tmpDir("aida-pages-capture-");
      const outDir = tmpDir("aida-pages-out-");
      writeCapture(captureDir, { stepsOk: [true, false] });

      const result = await buildPage(walkthrough(), captureDir, outDir);

      expect(result.passed).toBe(false);
      expect(result.publishable).toBe(false);
      expect(result.problems.length).toBeGreaterThan(0);
      expect(result.problems[0]).toMatch(/fill-form/);

      const content = readFileSync(result.indexFile, "utf8");
      expect(content).toContain("passed: false");
      expect(content).toContain("Not verified");
      expect(content).toContain("NOT fully verified");
    }, 60_000);

    it("prints the config roles name in Before you start, not the role id (M26)", async () => {
      const captureDir = tmpDir("aida-pages-capture-");
      const outDir = tmpDir("aida-pages-out-");
      writeCapture(captureDir);

      const wf = { ...walkthrough(), start: { signed_in_as: "admin" } };
      const result = await buildPage(wf, captureDir, outDir, { roles: { admin: "an organiser" } });
      const content = readFileSync(result.indexFile, "utf8");
      expect(content).toContain("Sign in as **an organiser**.");
      expect(content).not.toContain("**admin**");
    }, 60_000);

    it("refuses to publish and explains why when there is no validation at all", async () => {
      const captureDir = tmpDir("aida-pages-capture-");
      const outDir = tmpDir("aida-pages-out-");
      writeCapture(captureDir);
      await rm(join(captureDir, "validation.json"));

      const result = await buildPage(walkthrough(), captureDir, outDir);
      expect(result.passed).toBe(false);
      expect(result.publishable).toBe(false);
      expect(result.problems[0]).toMatch(/no capture validation/);
    }, 60_000);

    it("preserves a human edit across a rebuild and reports it as a suggestion", async () => {
      const captureDir = tmpDir("aida-pages-capture-");
      const outDir = tmpDir("aida-pages-out-");
      writeCapture(captureDir);

      const first = await buildPage(walkthrough(), captureDir, outDir);
      let content = readFileSync(first.indexFile, "utf8");
      // Steps are keyed by `step.id` (e.g. "step-open-page"), not position — see stepBlockKey.
      content = content.replace(
        /\{\/\* aida:begin step-open-page \*\/\}[\s\S]*?\{\/\* aida:end step-open-page \*\/\}/,
        "{/* aida:begin step-open-page */}\n#### 1. Open the page\n\nA human improved this wording.\n{/* aida:end step-open-page */}",
      );
      writeFileSync(first.indexFile, content);

      const wf2 = walkthrough();
      wf2.steps[0].page_text = "Click **Things** in the left menu, then confirm.";
      const second = await buildPage(wf2, captureDir, outDir);

      const finalContent = readFileSync(second.indexFile, "utf8");
      expect(finalContent).toContain("A human improved this wording.");
      expect(finalContent).not.toContain("then confirm");
      expect(second.suggestions.some((s) => s.key === "step-open-page")).toBe(true);

      // Untouched blocks (e.g. step-2) still regenerate normally.
      expect(finalContent).toContain("#### 2. Fill the form");
    }, 60_000);

    it("refreshes passed/lastChecked on a failed rebuild even after a human edited the frontmatter title", async () => {
      const captureDir = tmpDir("aida-pages-capture-");
      const outDir = tmpDir("aida-pages-out-");
      writeCapture(captureDir);

      const first = await buildPage(walkthrough(), captureDir, outDir);
      expect(first.passed).toBe(true);

      let content = readFileSync(first.indexFile, "utf8");
      content = content.replace('title: "Add a thing"', 'title: "A Human-Edited Title"');
      writeFileSync(first.indexFile, content);

      writeCapture(captureDir, { stepsOk: [true, false] });
      const second = await buildPage(walkthrough(), captureDir, outDir);

      const finalContent = readFileSync(second.indexFile, "utf8");
      expect(finalContent).toContain('title: "A Human-Edited Title"');
      expect(finalContent).toContain("passed: false");
      expect(finalContent).not.toContain("passed: true");
      expect(second.passed).toBe(false);
    }, 60_000);
  },
);

// Security review: a step error (which can carry what the page showed) is redacted and capped
// before it lands in the build's problems (report.json, the PR comment) or the page itself.
describe("buildPage step-error redaction", () => {
  it("redacts and caps a failed step's error", async () => {
    const captureDir = tmpDir("aida-pages-capture-");
    const outDir = tmpDir("aida-pages-out-");
    writeCapture(captureDir, { stepsOk: [true, false] });
    const vPath = join(captureDir, "validation.json");
    const v = JSON.parse(readFileSync(vPath, "utf8")) as ValidationResult;
    v.steps[1].error = `Received string: "sophie.harrington@gmail.com" at /reset?token=abc123 ${"z".repeat(600)}\nCall log: more`;
    writeFileSync(vPath, JSON.stringify(v));

    const result = await buildPage(walkthrough(), captureDir, outDir);
    const text = `${result.problems.join("\n")}\n${readFileSync(result.indexFile, "utf8")}`;
    expect(text).not.toContain("sophie.harrington");
    expect(text).not.toContain("token=abc123");
    expect(text).not.toContain("Call log");
    for (const p of result.problems) expect(p.length).toBeLessThanOrEqual(240);
  }, 60_000);
});
