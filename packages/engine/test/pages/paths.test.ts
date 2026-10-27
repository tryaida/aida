// M33: "Other ways to do this" on pages and in PDFs (decision 34).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { CaptureManifest, ManifestStep, ValidationResult } from "../../src/capture/index.js";
import { buildPage } from "../../src/pages/build.js";
import { pdfInputFromPage } from "../../src/pdf/input.js";
import { buildPageHtml, otherWaysHtml, splitOtherWays } from "../../src/pdf/html.js";
import { walkthroughHash } from "../../src/pdf/build.js";
import { buildSearchIndex } from "../../src/index-search/index.js";

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

function walkthrough(note?: string): Walkthrough {
  return {
    walkthrough: "record-payment",
    title: "Record a payment",
    start: { page: "/bookings/12", signed_in_as: "staff", persona: { role: "staff" } },
    steps: [
      { id: "open", title: "Open the payment form", page_text: "Select **Record payment**.", actions: [] },
      { id: "save", title: "Save the payment", page_text: "Select **Save**.", actions: [] },
    ],
    paths: [
      {
        id: "from-attendee",
        title: "From the attendee's page",
        when: "Use this when the attendee pays for several bookings at once.",
        start: { page: "/attendees/7" },
        steps: [{ id: "open-attendee", title: "Open the attendee's payments", page_text: "Select **Pay for attendee**.", actions: [] }],
        joins: "save",
        ...(note ? { note } : {}),
      },
    ],
  };
}

function step(id: string, image: string, url: string): ManifestStep {
  return {
    id,
    camera: "full",
    cameraBox: null,
    events: [{ type: "frame", image, transition: "cut" }],
    doc: { image, highlights: [{ x: 600, y: 300, w: 120, h: 40 }] },
    impact: { urls: [url], requests: [] },
    checks: [],
  };
}

function writeRun(dir: string, steps: ManifestStep[], ok = true, extra: Partial<ValidationResult> = {}): void {
  mkdirSync(join(dir, "frames"), { recursive: true });
  for (const s of steps) writeFileSync(join(dir, "frames", s.doc.image!), TINY_PNG);
  const manifest: CaptureManifest = { workflow: "record-payment", baseUrl: "http://127.0.0.1:3100", viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1, steps };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  const validation: ValidationResult = {
    workflow: "record-payment",
    ranAt: "2026-10-27T00:00:00.000Z",
    baseUrl: "http://127.0.0.1:3100",
    ok,
    steps: steps.map((s) => ({ id: s.id, title: s.id, checks: [], ok, ms: 1, ...(ok ? {} : { error: "could not find Pay" }) })),
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
    ...extra,
  };
  writeFileSync(join(dir, "validation.json"), JSON.stringify(validation));
}

const diff = { path: "from-attendee", main: ["POST /api/payments"], pathWrites: ["POST /api/payments/allocate"], onlyInPath: ["POST /api/payments/allocate"], onlyInMain: ["POST /api/payments"], message: "x" };

function capture(opts: { pathOk?: boolean; capturePath?: boolean; flagged?: boolean } = {}): string {
  const captureDir = tmpDir("aida-paths-capture-");
  writeRun(captureDir, [step("open", "m1.png", "/bookings/12"), step("save", "m2.png", "/payments/new")], true, opts.flagged ? { pathDiffs: [diff] } : {});
  if (opts.capturePath !== false) {
    writeRun(join(captureDir, "paths", "from-attendee"), [step("open-attendee", "p1.png", "/attendees/7"), step("save", "p2.png", "/payments/new")], opts.pathOk ?? true);
  }
  return captureDir;
}

describe("pages: other ways to do this", { timeout: 60_000 }, () => {
  it("adds the section after the main steps: title, when, opening steps with screenshots, and where it joins", async () => {
    const outDir = tmpDir("aida-paths-out-");
    const result = await buildPage(walkthrough(), capture(), outDir);
    expect(result.publishable).toBe(true);
    const text = readFileSync(result.plainFile, "utf8");
    const section = text.slice(text.indexOf("## Other ways to do this"));
    expect(text.indexOf("## Other ways to do this")).toBeGreaterThan(text.indexOf("#### 2. Save the payment"));
    expect(section).toContain("### From the attendee's page");
    expect(section).toContain("Use this when the attendee pays for several bookings at once.");
    expect(section).toContain("#### 1. Open the attendee's payments");
    expect(section).toContain("![Open the attendee's payments](screenshots/paths/from-attendee-step-01.png)");
    expect(section).toContain("Then continue from [step 2 (Save the payment)](#2-save-the-payment).");
    // Main screenshots stay the main steps only; the path's sit apart.
    expect(result.screenshots).toHaveLength(2);
    expect(result.pathScreenshots).toHaveLength(1);
    expect(existsSync(result.pathScreenshots![0])).toBe(true);
    expect(result.pathFigures?.["from-attendee"]?.[0]).toMatchObject({ step: 1, newScreen: true });
    expect(existsSync(result.pathFigures!["from-attendee"][0].full)).toBe(true);
  });

  it("shows the writer's note only when capture flagged the path as saving differently", async () => {
    const note = "Paying here spreads the money across the attendee's bookings.";
    const unflagged = await buildPage(walkthrough(note), capture(), tmpDir("aida-paths-out-"));
    expect(readFileSync(unflagged.plainFile, "utf8")).not.toContain(note);
    const flagged = await buildPage(walkthrough(note), capture({ flagged: true }), tmpDir("aida-paths-out-"));
    expect(readFileSync(flagged.plainFile, "utf8")).toContain(`> **Note:** ${note}`);
    // Flagged with no note: nothing made up in its place.
    const silent = await buildPage(walkthrough(), capture({ flagged: true }), tmpDir("aida-paths-out-"));
    expect(readFileSync(silent.plainFile, "utf8")).not.toContain("**Note:**");
  });

  it("marks a path that wasn't captured or failed as not verified and stops the page publishing", async () => {
    const missing = await buildPage(walkthrough(), capture({ capturePath: false }), tmpDir("aida-paths-out-"));
    expect(missing.publishable).toBe(false);
    expect(missing.problems.join("\n")).toMatch(/path "from-attendee": this way hasn't been captured yet/);
    const failed = await buildPage(walkthrough(), capture({ pathOk: false }), tmpDir("aida-paths-out-"));
    expect(failed.publishable).toBe(false);
    expect(readFileSync(failed.plainFile, "utf8")).toContain("> **Not verified.**");
  });

  it("drops the section and its screenshots when the walkthrough no longer has paths", async () => {
    const outDir = tmpDir("aida-paths-out-");
    const captureDir = capture();
    await buildPage(walkthrough(), captureDir, outDir);
    const { paths: _paths, ...withoutPaths } = walkthrough();
    const result = await buildPage(withoutPaths, captureDir, outDir);
    expect(readFileSync(result.plainFile, "utf8")).not.toContain("Other ways to do this");
    expect(existsSync(join(outDir, "record-payment", "screenshots", "paths"))).toBe(false);
  });

  it("never swaps a path figure to an earlier frame when any step, main or path, has blur", async () => {
    // A path step whose click opened another page: its ring belongs to the earlier frame. With blur
    // anywhere in the walkthrough, that earlier (unblurred) frame is never shown.
    const navigating = (): ManifestStep => ({
      id: "open-attendee",
      camera: "full",
      cameraBox: null,
      events: [
        { type: "frame", image: "p0.png", transition: "cut" },
        { type: "highlight", box: { x: 600, y: 300, w: 120, h: 40 } },
        { type: "click", at: { x: 660, y: 320 } },
        { type: "frame", image: "p1.png", transition: "fade" },
      ],
      doc: { image: "p1.png", highlights: [{ x: 600, y: 300, w: 120, h: 40 }] },
      impact: { urls: ["/attendees/7/pay"], requests: [] },
      checks: [],
    });
    const run = async (wf: Walkthrough) => {
      const captureDir = tmpDir("aida-paths-capture-");
      writeRun(captureDir, [step("open", "m1.png", "/bookings/12"), step("save", "m2.png", "/payments/new")]);
      const pathDir = join(captureDir, "paths", "from-attendee");
      writeRun(pathDir, [navigating(), step("save", "p2.png", "/payments/new")]);
      writeFileSync(join(pathDir, "frames", "p0.png"), TINY_PNG);
      return (await buildPage(wf, captureDir, tmpDir("aida-paths-out-"))).pathFigures!["from-attendee"][0];
    };
    expect((await run(walkthrough())).targets).toHaveLength(1); // swapped to p0, ring kept
    const blurred = walkthrough();
    blurred.steps[0].blur = [{ id: "b1", box: { x: 0, y: 0, w: 10, h: 10 } }];
    expect((await run(blurred)).targets).toHaveLength(0); // kept p1, no ring
  });

  it("puts every path figure in the PDF cache key", async () => {
    const result = await buildPage(walkthrough(), capture(), tmpDir("aida-paths-out-"));
    const input = pdfInputFromPage(walkthrough(), result);
    const before = walkthroughHash(input, "A4", undefined);
    writeFileSync(input.pathFigures!["from-attendee"][0].full, Buffer.concat([TINY_PNG, Buffer.from("changed")]));
    expect(walkthroughHash(input, "A4", undefined)).not.toBe(before);
  });

  it("prints the section in the PDF with the path's own figures and the join line", async () => {
    const result = await buildPage(walkthrough(), capture(), tmpDir("aida-paths-out-"));
    const input = pdfInputFromPage(walkthrough(), result);
    expect(input.pathFigures?.["from-attendee"]).toHaveLength(1);
    const html = buildPageHtml(input);
    expect(html).toContain('<h2 class="other-ways-h">Other ways to do this</h2>');
    expect(html).toMatch(/<section class="path"><div class="path-start"><h3>From the attendee(&#39;|')s page<\/h3><p class="path-when">/);
    expect(html).toContain('<p class="path-join">Then continue from');
    // The path's figure (its own print file), never the main step 1 figure.
    const pathSection = html.slice(html.indexOf('<section class="path">'));
    expect(pathSection).toContain("paths/from-attendee/step-01");
    expect(input.cardSteps).toHaveLength(2);
  });

  it("indexes each path's title and when sentence for search and the help chat", async () => {
    const result = await buildPage(walkthrough(), capture(), tmpDir("aida-paths-out-"));
    const content = tmpDir("aida-paths-content-");
    mkdirSync(join(content, "record-payment"));
    writeFileSync(join(content, "record-payment", "index.mdx"), readFileSync(result.indexFile, "utf8"));
    const { entries } = buildSearchIndex(content);
    const entry = entries.find((e) => e.heading === "From the attendee's page");
    expect(entry?.text).toMatch(/Use this when the attendee pays for several bookings at once/);
    expect(entry?.url).toBe("/record-payment#from-the-attendees-page");
  });
});

describe("pages: a path that runs to its own end (decision 37)", { timeout: 60_000 }, () => {
  function alone(): Walkthrough {
    const wf = walkthrough();
    wf.paths = [
      {
        id: "from-list",
        title: "From the Entries list",
        when: "Use this when you're already on Entries.",
        start: { page: "/entries" },
        steps: [
          { id: "list-open", title: "Open Record payment", page_text: "Select **Record payment** on the row.", actions: [] },
          { id: "list-save", title: "Record it", page_text: "Select **Record**.", actions: [{ do: "expect", target: { text: "Payment recorded" } }] },
        ],
      },
    ];
    return wf;
  }
  function aloneCapture(): string {
    const captureDir = tmpDir("aida-paths-capture-");
    writeRun(captureDir, [step("open", "m1.png", "/bookings/12"), step("save", "m2.png", "/payments/new")]);
    writeRun(join(captureDir, "paths", "from-list"), [step("list-open", "p1.png", "/entries"), step("list-save", "p2.png", "/entries")]);
    return captureDir;
  }

  it("shows every one of its steps and no 'continue from step N'", async () => {
    const result = await buildPage(alone(), aloneCapture(), tmpDir("aida-paths-out-"));
    expect(result.publishable).toBe(true);
    const text = readFileSync(result.plainFile, "utf8");
    const section = text.slice(text.indexOf("## Other ways to do this"));
    expect(section).toContain("#### 1. Open Record payment");
    expect(section).toContain("#### 2. Record it");
    expect(section).toContain("screenshots/paths/from-list-step-02.png");
    expect(section).not.toMatch(/continue from/i);
    // The PDF: both steps, no join line, the heading kept with its first step.
    const html = buildPageHtml(pdfInputFromPage(alone(), result));
    const pathHtml = html.slice(html.indexOf('<section class="path">'));
    expect(pathHtml).not.toContain("path-join");
    expect(pathHtml).toMatch(/<div class="path-start"><h3>From the Entries list<\/h3><p class="path-when">[\s\S]*?<div class="step [^"]*"><div class="step-text"><h4 class="step-h"><span class="step-num">1<\/span>[\s\S]*?<\/div><\/div>\n<div class="step/);
  });
});

describe("pdf html: other ways section", () => {
  it("keeps a path's heading on the page with its first step, never orphaned at a page bottom", () => {
    const html = otherWaysHtml(
      '<h2>Other ways to do this</h2><h3>P</h3><p>when</p><h4>1. B</h4><p>b</p><h4>2. C</h4><p>c</p><p>Then continue from <a href="#1-a">step 1 (A)</a>.</p>',
      {},
    );
    expect(html).toMatch(/<section class="path"><div class="path-start"><h3>P<\/h3><p class="path-when">when<\/p><div class="step [^"]*"><div class="step-text"><h4 class="step-h"><span class="step-num">1<\/span><span>B<\/span><\/h4><p>b<\/p><\/div><\/div><\/div>\n<div class="step/);
    expect(html).toContain('<p class="path-join">Then continue from');
    expect(buildPageHtml).toBeTypeOf("function");
  });

  it("splits the section from the main steps and the verified line", () => {
    const body = "<h2>Steps</h2><h4>1. A</h4><p>a</p><h2>Other ways to do this</h2><h3>P</h3><p>when</p><h4>1. B</h4><p>b</p><p>Then continue from <a href=\"#1-a\">step 1 (A)</a>.</p><hr /><p><em>Steps verified</em></p>";
    const parts = splitOtherWays(body);
    expect(parts.main).toBe("<h2>Steps</h2><h4>1. A</h4><p>a</p>");
    expect(parts.tail.startsWith("<hr />")).toBe(true);
    const html = otherWaysHtml(parts.otherWays!, {});
    expect(html).toContain('<p class="path-when">when</p>');
    expect(html).toContain('<div class="step stack"><div class="step-text"><h4 class="step-h"><span class="step-num">1</span><span>B</span></h4><p>b</p></div></div>');
    expect(html).toContain('<p class="path-join">Then continue from <a href="#1-a">step 1 (A)</a>.</p></section>');
  });
});
