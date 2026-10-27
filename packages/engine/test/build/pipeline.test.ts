// Regression tests for the review findings fixed in build/pipeline.ts:
//  1. pagesInputHash must change on a validation pass<->fail flip (+ wf.start/readers).
//  2. the index stage must only see walkthroughs whose pages/qa passed and are publishable.
//  8. videoPresent must check `<videoDir>/<id>/<id>.mp4`, not `<videoDir>/<id>.mp4`.
//  9. buildPage must be called with `readers: config.readers`.
// 10. render/pages must be skipped when this run's capture validation (or voice) failed.
// 11. voice (the one built-in paid stage) must stop once the run budget is exceeded.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/index.js";
import type { CaptureManifest, ValidationResult } from "../../src/capture/index.js";
import type { BuildPageResult } from "../../src/pages/index.js";

vi.mock("../../src/capture/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/capture/index.js")>();
  return {
    ...mod,
    runCapture: vi.fn(),
    withFrameStabilization: vi.fn(async (_outDir: string, _opts: unknown, run: () => Promise<unknown>) => ({
      result: await run(),
      frameDiff: { kept: 0, changed: 0 },
    })),
  };
});
vi.mock("../../src/commands/voice.js", () => ({ buildVoiceManifest: vi.fn() }));
vi.mock("../../src/render/index.js", () => ({
  loadNarrationBeats: vi.fn(() => undefined),
  render: vi.fn(),
}));
vi.mock("../../src/pages/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/pages/index.js")>();
  return { ...mod, buildPage: vi.fn() };
});
vi.mock("../../src/qa/index.js", () => ({ runQa: vi.fn() }));

const { runCapture } = await import("../../src/capture/index.js");
const { buildVoiceManifest } = await import("../../src/commands/voice.js");
const { render } = await import("../../src/render/index.js");
const { buildPage } = await import("../../src/pages/index.js");
const { runQa } = await import("../../src/qa/index.js");
const { runPipeline, pagesInputHash } = await import("../../src/build/pipeline.js");

const dirs: string[] = [];
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  vi.mocked(runCapture).mockReset();
  vi.mocked(buildVoiceManifest).mockReset();
  vi.mocked(render).mockReset();
  vi.mocked(buildPage).mockReset();
  vi.mocked(runQa).mockReset();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function writeWalkthrough(walkthroughsDir: string, id: string): void {
  writeFileSync(
    join(walkthroughsDir, `${id}.yaml`),
    [`walkthrough: ${id}`, `title: "${id}"`, "steps:", "  - id: only-step", '    title: "Do the thing"'].join("\n"),
  );
}

function fakeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  const root = tmpDir("aida-pipeline-test-");
  const walkthroughsDir = join(root, "walkthroughs");
  mkdirSync(walkthroughsDir, { recursive: true });
  return {
    app: { baseUrl: "http://localhost:3000" },
    walkthroughsDir,
    outDir: join(root, "out"),
    buildDir: join(root, ".build"),
    configDir: root,
    ...overrides,
  } as ResolvedConfig;
}

function fakeManifest(): CaptureManifest {
  return {
    workflow: "fixture",
    baseUrl: "http://localhost:3000",
    viewport: { width: 1024, height: 768 },
    deviceScaleFactor: 1,
    steps: [{ id: "only-step", camera: "full", cameraBox: null, events: [], doc: { image: null, highlights: [] }, impact: { urls: [], requests: [] }, checks: [] }],
  };
}

function fakeValidation(ok: boolean): ValidationResult {
  return {
    workflow: "fixture",
    ranAt: "2026-01-01T00:00:00.000Z",
    baseUrl: "http://localhost:3000",
    ok,
    steps: [{ id: "only-step", title: "Do the thing", checks: [], ok, ms: 10 }],
    dbChecks: [],
    problems: { console: [], page: [], server: [] },
  };
}

function mockCaptureOnce(ok: boolean): void {
  vi.mocked(runCapture).mockResolvedValueOnce({
    manifest: fakeManifest(),
    run: { capturedAt: new Date().toISOString(), durationMs: 1 },
    validation: fakeValidation(ok),
    framesDir: "/tmp/frames",
  });
}

/** Builds a fake BuildPageResult *and* actually writes its indexFile/plainFile to disk — the
 * real pages-stage cache check (`runPagesStage`) does `existsSync(cache.result.indexFile)`, so a
 * mock that leaves no file on disk would always force a rebuild regardless of the cache hash,
 * making any test of the hash (bug 1/8/9) vacuous. */
function fakePageResult(id: string, pagesDir: string, publishable = true): BuildPageResult {
  const outDir = join(pagesDir, id);
  const indexFile = join(outDir, "index.mdx");
  const plainFile = join(outDir, "index.plain.md");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(indexFile, "---\ntitle: x\npassed: true\n---\n\nbody\n");
  writeFileSync(plainFile, "body\n");
  return {
    id,
    outDir,
    indexFile,
    plainFile,
    screenshotsDir: join(outDir, "screenshots"),
    screenshots: [],
    passed: publishable,
    publishable,
    problems: publishable ? [] : ["not publishable in this fixture"],
    suggestions: [],
  };
}

describe("runPipeline (review-finding regressions)", () => {
  it("bug 9: passes config.readers through to buildPage", async () => {
    const config = fakeConfig({ readers: ["office-staff"] });
    writeWalkthrough(config.walkthroughsDir, "add-thing");
    mockCaptureOnce(true);
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("add-thing", join(config.outDir, "pages")));

    await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "pages"], json: false });

    expect(buildPage).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(buildPage).mock.calls[0][3];
    expect(opts).toMatchObject({ readers: ["office-staff"] });
  });

  it("bug 10: skips render and pages for a walkthrough whose capture validation failed this run", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "broken-flow");
    mockCaptureOnce(false); // validation.ok === false

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], json: false });

    expect(render).not.toHaveBeenCalled();
    expect(buildPage).not.toHaveBeenCalled();
    const w = result.walkthroughs[0];
    expect(w.stages.render?.status).toBe("skipped");
    expect(w.stages.pages?.status).toBe("skipped");
  });

  it("bug 10 (control): render and pages still run when capture passes", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "good-flow");
    mockCaptureOnce(true);
    vi.mocked(render).mockResolvedValueOnce({
      id: "good-flow",
      outDir: join(config.outDir, "videos", "good-flow"),
      srt: "",
      vtt: "",
      chaptersVtt: "",
      timelineJson: "",
      stills: [],
      durationSec: 1,
      skipped: false,
      frames: 1,
      wallTimeMs: 1,
    });
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("good-flow", join(config.outDir, "pages")));

    await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "render", "pages"], json: false });

    expect(render).toHaveBeenCalledTimes(1);
    expect(buildPage).toHaveBeenCalledTimes(1);
  });

  it("round 3: `--only pages` (capture not selected) still loads an existing capture manifest off disk, " +
    "so pages doesn't fail with \"no capture manifest available\" (bug: --skip-capture only mattered " +
    "inside runCaptureStage, which never runs once --only drops \"capture\")", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "reused-capture");
    const captureDir = join(config.buildDir, "reused-capture", "capture");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(fakeManifest()));
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(fakeValidation(true)));
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("reused-capture", join(config.outDir, "pages")));

    const result = await runPipeline(config, {
      configPath: "x",
      walkthroughIds: [],
      only: ["pages"],
      skipCapture: true,
      json: false,
    });

    expect(runCapture).not.toHaveBeenCalled();
    expect(buildPage).toHaveBeenCalledTimes(1);
    const w = result.walkthroughs[0];
    expect(w.stages.capture?.status).toBe("not-selected");
    expect(w.stages.pages?.status).not.toBe("failed");
  });

  it("bug 2: the index stage excludes a walkthrough whose qa stage failed this run, even though its page is publishable", async () => {
    const config = fakeConfig({ helpApp: join(fakeConfig().outDir, "..", "help") });
    const helpApp = join(config.outDir, "..", "help");
    mkdirSync(helpApp, { recursive: true });
    const configWithHelp = { ...config, helpApp };
    writeWalkthrough(config.walkthroughsDir, "flaky-qa");
    mockCaptureOnce(true);
    const pagesDir = join(config.outDir, "pages");
    const page = fakePageResult("flaky-qa", pagesDir, true);
    vi.mocked(buildPage).mockResolvedValueOnce(page);
    vi.mocked(runQa).mockResolvedValueOnce({ ok: false, target: page.outDir, checks: [{ check: "secrets", ok: false, details: "found one", problems: ["aws key"] }] });

    const result = await runPipeline(configWithHelp, {
      configPath: "x",
      walkthroughIds: [],
      only: ["capture", "pages", "qa", "index"],
      json: false,
    });

    expect(result.walkthroughs[0].stages.qa?.status).toBe("failed");
    // Only the generated home page is indexed — never the QA-failed walkthrough's page.
    const searchIndex = JSON.parse(readFileSync(join(helpApp, "public", "search-index.json"), "utf8")) as { url: string }[];
    expect(searchIndex.some((e) => e.url.includes("flaky-qa"))).toBe(false);
    expect(existsSync(join(helpApp, "content", "docs", "flaky-qa"))).toBe(false);
    expect(existsSync(join(helpApp, "content", "docs", "how-do-i", "flaky-qa"))).toBe(false);
  });

  it("bug 8: videoPresent checks <videoDir>/<id>/<id>.mp4, not <videoDir>/<id>.mp4 (affects the pages-stage cache key)", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "has-video");
    const videoDir = join(config.outDir, "videos");
    const pagesDir = join(config.outDir, "pages");

    // No video on disk at all, first build.
    mockCaptureOnce(true);
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("has-video", pagesDir));
    await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "pages"], json: false });
    expect(buildPage).toHaveBeenCalledTimes(1);

    // Second build: same manifest/validation, but now a video exists at the *correct* nested
    // path render actually writes to (<videoDir>/<id>/<id>.mp4). videoPresent must flip to
    // true, busting the pages cache (a wrong flat-path check would never see this file and
    // would wrongly keep serving the cached, video-less page).
    mkdirSync(join(videoDir, "has-video"), { recursive: true });
    writeFileSync(join(videoDir, "has-video", "has-video.mp4"), "fake mp4 bytes");
    mockCaptureOnce(true);
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("has-video", pagesDir));
    await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "pages"], json: false });
    expect(buildPage).toHaveBeenCalledTimes(2);
  });

  it("bug 11: skips a later walkthrough's voice stage once the run budget is exceeded by an earlier one's voice cost", async () => {
    const config = fakeConfig({
      budget: { usd: 0.01 },
      voice: { provider: "minimax", pricePerChar: 1 }, // $1/char — trivially trips a $0.01 budget
    });
    writeWalkthrough(config.walkthroughsDir, "wt-a");
    writeWalkthrough(config.walkthroughsDir, "wt-b");
    mockCaptureOnce(true);
    mockCaptureOnce(true);
    vi.mocked(buildVoiceManifest).mockResolvedValueOnce({
      id: "wt-a",
      manifestFile: "/tmp/a.json",
      report: { results: [], summary: { synthesized: 1, cached: 0, charsBilled: 10 } },
      skipped: false,
    });

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "voice"], json: false });

    expect(buildVoiceManifest).toHaveBeenCalledTimes(1); // wt-b's voice stage never ran
    const [a, b] = result.walkthroughs;
    expect(a.stages.voice?.status).toBe("ok");
    expect(b.stages.voice?.status).toBe("skipped");
    expect(b.stages.voice?.detail).toMatch(/budget/);
  });
});

describe("runPipeline: nothing is rebuilt from an older capture when this run's capture failed or was skipped", () => {
  /** A passing capture from an earlier run, still on disk. */
  function writePriorCapture(config: ResolvedConfig, id: string, ok = true): void {
    const captureDir = join(config.buildDir, id, "capture");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(fakeManifest()));
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(fakeValidation(ok)));
  }
  function mockRender(id: string, outDir: string): void {
    vi.mocked(render).mockResolvedValue({
      id,
      outDir,
      srt: "",
      vtt: "",
      chaptersVtt: "",
      timelineJson: "",
      stills: [],
      durationSec: 1,
      skipped: false,
      frames: 1,
      wallTimeMs: 1,
    });
  }
  const stagesUpToIndex = ["capture", "render", "pages", "index"] as const;

  it("a capture that throws: no render, page or index entry from the older capture on disk", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "crashes");
    writePriorCapture(config, "crashes");
    vi.mocked(runCapture).mockRejectedValueOnce(new Error("browser crashed"));

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: [...stagesUpToIndex], json: false });

    expect(render).not.toHaveBeenCalled();
    expect(buildPage).not.toHaveBeenCalled();
    const w = result.walkthroughs[0];
    expect(w.ok).toBe(false);
    expect(w.stages.capture?.status).toBe("failed");
    expect(w.stages.render?.status).toBe("skipped");
    expect(w.stages.pages?.status).toBe("skipped");
    expect(result.index?.pageCount ?? 0).toBe(0);
  });

  it("a dependant skipped because its provider failed: no render or page from its older capture", async () => {
    const config = fakeConfig();
    writeFileSync(
      join(config.walkthroughsDir, "add-session.yaml"),
      ["walkthrough: add-session", 'title: "Add"', "leaves: [session-exists]", "steps:", "  - id: only-step", '    title: "Do"'].join("\n"),
    );
    writeFileSync(
      join(config.walkthroughsDir, "overbook.yaml"),
      ["walkthrough: overbook", 'title: "Overbook"', "needs: [session-exists]", "steps:", "  - id: only-step", '    title: "Do"'].join("\n"),
    );
    writePriorCapture(config, "overbook");
    mockCaptureOnce(false); // the provider's capture fails validation

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: [...stagesUpToIndex], json: false });

    expect(runCapture).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
    expect(buildPage).not.toHaveBeenCalled();
    const overbook = result.walkthroughs.find((w) => w.walkthrough === "overbook")!;
    expect(overbook.stages.capture?.status).toBe("failed");
    expect(overbook.stages.capture?.detail).toMatch(/skipped: needs session-exists/);
    expect(overbook.stages.render?.status).toBe("skipped");
    expect(overbook.stages.pages?.status).toBe("skipped");
  });

  it("a capture that throws: classified, failure.json written this run, and --skip-capture then refuses the old capture", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "times-out");
    writePriorCapture(config, "times-out");
    const captureDir = join(config.buildDir, "times-out", "capture");
    const err = Object.assign(new Error("page.waitForURL: Timeout 30000ms exceeded.\n  call log..."), { aidaPhase: "sign-in" });
    vi.mocked(runCapture).mockRejectedValueOnce(err);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture"], json: false });

    const [f] = result.walkthroughs[0].failures!;
    expect(f.category).toBe("environment");
    expect(f.files).toContain(join(captureDir, "failure.json"));
    expect(JSON.parse(readFileSync(join(captureDir, "failure.json"), "utf8")).action).toBe("sign-in");
    expect(JSON.parse(readFileSync(join(captureDir, "validation.json"), "utf8"))).toMatchObject({ ok: false, notCaptured: expect.stringContaining("Timeout") });

    mockRender("times-out", join(config.outDir, "videos", "times-out"));
    const again = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: [...stagesUpToIndex], skipCapture: true, json: false });
    expect(render).not.toHaveBeenCalled();
    expect(buildPage).not.toHaveBeenCalled();
    expect(again.walkthroughs[0].stages.capture).toMatchObject({ status: "failed", detail: expect.stringContaining("can't be reused") });
    expect(again.walkthroughs[0].ok).toBe(false);
  });

  it("a blocked dependant gets no paid voice, and its capture dir is marked not captured", async () => {
    const config = fakeConfig();
    writeFileSync(join(config.walkthroughsDir, "add-session.yaml"), ["walkthrough: add-session", 'title: "Add"', "leaves: [session-exists]", "steps:", "  - id: only-step", '    title: "Do"'].join("\n"));
    writeFileSync(join(config.walkthroughsDir, "overbook.yaml"), ["walkthrough: overbook", 'title: "Overbook"', "needs: [session-exists]", "steps:", "  - id: only-step", '    title: "Do"'].join("\n"));
    writePriorCapture(config, "overbook");
    mockCaptureOnce(false);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "voice"], json: false });

    expect(buildVoiceManifest).not.toHaveBeenCalled();
    const overbook = result.walkthroughs.find((w) => w.walkthrough === "overbook")!;
    expect(overbook.stages.voice?.status).toBe("skipped");
    expect(overbook.failures?.[0]).toMatchObject({ check: "capture:blocked" });
    const v = JSON.parse(readFileSync(join(config.buildDir, "overbook", "capture", "validation.json"), "utf8"));
    expect(v).toMatchObject({ ok: false, notCaptured: expect.stringContaining("skipped: needs session-exists") });
  });

  it("a need nothing provides blocks only that walkthrough; the rest of the build goes ahead", async () => {
    const config = fakeConfig();
    writeFileSync(join(config.walkthroughsDir, "needer.yaml"), ["walkthrough: needer", 'title: "Needer"', "needs: [ghost]", "steps:", "  - id: only-step", '    title: "Do"'].join("\n"));
    writeWalkthrough(config.walkthroughsDir, "fine");
    mockCaptureOnce(true);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture"], json: false });

    expect(runCapture).toHaveBeenCalledTimes(1);
    const needer = result.walkthroughs.find((w) => w.walkthrough === "needer")!;
    expect(needer.ok).toBe(false);
    expect(needer.stages.capture?.detail).toMatch(/^blocked: needer needs ghost/);
    expect(result.walkthroughs.find((w) => w.walkthrough === "fine")!.ok).toBe(true);
  });

  it("--skip-capture still rebuilds from a passing prior capture", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "reused");
    writePriorCapture(config, "reused", true);
    mockRender("reused", join(config.outDir, "videos", "reused"));
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("reused", join(config.outDir, "pages")));

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: [...stagesUpToIndex], skipCapture: true, json: false });

    expect(runCapture).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
    expect(buildPage).toHaveBeenCalledTimes(1);
    expect(result.walkthroughs[0].stages.capture?.status).toBe("skipped");
  });

  it("--skip-capture still refuses a prior capture that failed", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "reused-broken");
    writePriorCapture(config, "reused-broken", false);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: [...stagesUpToIndex], skipCapture: true, json: false });

    expect(render).not.toHaveBeenCalled();
    expect(buildPage).not.toHaveBeenCalled();
    expect(result.walkthroughs[0].stages.render?.status).toBe("skipped");
    expect(result.walkthroughs[0].stages.pages?.status).toBe("skipped");
  });
});

describe("pagesInputHash (bug 1: must bust the pages cache on a capture validation pass<->fail flip)", () => {
  function wf(overrides: Record<string, unknown> = {}) {
    return {
      walkthrough: "add-thing",
      title: "Add a thing",
      steps: [{ id: "only-step", title: "Do it" }],
      ...overrides,
    } as import("../../src/walkthrough/index.js").Walkthrough;
  }

  it("changes when validation.ok flips, even though the manifest and text are unchanged", () => {
    const manifest = fakeManifest();
    const passing = fakeValidation(true);
    const failing = fakeValidation(false);
    const a = pagesInputHash(wf(), manifest, passing, undefined, false);
    const b = pagesInputHash(wf(), manifest, failing, undefined, false);
    expect(a).not.toBe(b);
  });

  it("changes when a step's own ok flips, even if the overall validation.ok stays the same", () => {
    const manifest = fakeManifest();
    const v1 = fakeValidation(true);
    const v2 = { ...v1, steps: v1.steps.map((s) => ({ ...s, ok: false })) };
    const a = pagesInputHash(wf(), manifest, v1, undefined, false);
    const b = pagesInputHash(wf(), manifest, v2, undefined, false);
    expect(a).not.toBe(b);
  });

  it("ignores validation's volatile ranAt/ms fields", () => {
    const manifest = fakeManifest();
    const v1 = fakeValidation(true);
    const v2 = { ...v1, ranAt: "2030-01-01T00:00:00.000Z", steps: v1.steps.map((s) => ({ ...s, ms: 99999 })) };
    expect(pagesInputHash(wf(), manifest, v1, undefined, false)).toBe(pagesInputHash(wf(), manifest, v2, undefined, false));
  });

  it("changes when config.readers changes (bug 9's flip-flop guard)", () => {
    const manifest = fakeManifest();
    const v = fakeValidation(true);
    const a = pagesInputHash(wf(), manifest, v, ["office-staff"], false);
    const b = pagesInputHash(wf(), manifest, v, ["judges"], false);
    expect(a).not.toBe(b);
  });

  it("changes when wf.start changes", () => {
    const manifest = fakeManifest();
    const v = fakeValidation(true);
    const a = pagesInputHash(wf({ start: { page: "/a" } }), manifest, v, undefined, false);
    const b = pagesInputHash(wf({ start: { page: "/b" } }), manifest, v, undefined, false);
    expect(a).not.toBe(b);
  });

  // M32: pages/focus.ts reads impact.urls to tell which steps moved to another page.
  it("changes when a step's impact.urls change, but not when only its impact.requests do", () => {
    const v = fakeValidation(true);
    const m1 = fakeManifest();
    const withUrl = { ...m1, steps: m1.steps.map((s) => ({ ...s, impact: { urls: ["/things/new"], requests: [] } })) };
    const withRequest = { ...m1, steps: m1.steps.map((s) => ({ ...s, impact: { urls: [], requests: [{ method: "GET", path: "/api/x" }] } })) };
    expect(pagesInputHash(wf(), withUrl, v, undefined, false)).not.toBe(pagesInputHash(wf(), m1, v, undefined, false));
    expect(pagesInputHash(wf(), withRequest, v, undefined, false)).toBe(pagesInputHash(wf(), m1, v, undefined, false));
  });

  it("changes when data changes (printed text fills in {{data}}, M35) or a path clip appears", () => {
    const v = fakeValidation(true);
    const a = wf({ data: { filter: { status: "Unpaid" } } } as never);
    const b = wf({ data: { filter: { status: "Overdue" } } } as never);
    expect(pagesInputHash(a, fakeManifest(), v, undefined, false)).not.toBe(pagesInputHash(b, fakeManifest(), v, undefined, false));
    const clip = [{ pathId: "p", src: "/videos/x/x.path-p.mp4", continueAt: { step: 1, t: 4 } }];
    expect(pagesInputHash(a, fakeManifest(), v, undefined, false, undefined, undefined, clip)).not.toBe(pagesInputHash(a, fakeManifest(), v, undefined, false));
    expect(pagesInputHash(a, fakeManifest(), v, undefined, false, undefined, undefined, [])).toBe(pagesInputHash(a, fakeManifest(), v, undefined, false));
  });

  it("changes when a step gains blur entries (they decide which frame print may show)", () => {
    const v = fakeValidation(true);
    const blurred = wf({ steps: [{ id: "only-step", title: "Do it", blur: [{ id: "b", box: { x: 0, y: 0, w: 10, h: 10 } }] }] });
    expect(pagesInputHash(blurred, fakeManifest(), v, undefined, false)).not.toBe(pagesInputHash(wf(), fakeManifest(), v, undefined, false));
  });
});

describe("report.json names each failed check and its files (M26)", () => {
  it("lists a failed QA check by name with capped problems, qa.json and the offending caption file", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "add-session");
    mockCaptureOnce(true);
    const page = fakePageResult("add-session", join(config.outDir, "pages"));
    vi.mocked(buildPage).mockResolvedValueOnce(page);
    const chapters = join(config.outDir, "videos", "add-session", "add-session.chapters.vtt");
    const problems = Array.from({ length: 7 }, (_, i) => `cue ${i + 1}: line length 47 above max 42`);
    vi.mocked(runQa).mockResolvedValueOnce({
      ok: false,
      target: page.outDir,
      checks: [
        { check: "secrets", ok: true, details: "none", problems: [] },
        { check: "captions:line-length", ok: false, details: "max 42 chars/line, 2 lines", problems, file: chapters },
      ],
    });

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "pages", "qa"], json: false });

    const w = result.walkthroughs[0];
    const qaFile = join(config.buildDir, "add-session", "qa.json");
    expect(w.file).toBe(join(config.walkthroughsDir, "add-session.yaml"));
    expect(w.failures).toEqual([
      { stage: "qa", check: "captions:line-length", count: 7, problems: problems.slice(0, 5), files: [qaFile, chapters] },
    ]);
    expect(JSON.parse(readFileSync(qaFile, "utf8")).reports[0].checks[1].check).toBe("captions:line-length");
    expect(w.ok).toBe(false);
  });

  it("names the failed capture step and points at validation.json", async () => {
    const config = fakeConfig();
    writeWalkthrough(config.walkthroughsDir, "broken-flow");
    mockCaptureOnce(false);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture"], json: false });

    const [f] = result.walkthroughs[0].failures!;
    expect(f).toMatchObject({ stage: "capture", check: "capture:step", count: 1 });
    expect(f.problems[0]).toContain('step "only-step"');
    expect(f.files).toContain(join(config.walkthroughsDir, "broken-flow.yaml"));
    expect(f.files).toContain(join(config.buildDir, "broken-flow", "capture", "validation.json"));
  });

  it("a chapter title too long for QA fails only that walkthrough's text stages, naming the file, line and step", async () => {
    const config = fakeConfig();
    const file = join(config.walkthroughsDir, "long-title.yaml");
    const title = "x".repeat(43);
    writeFileSync(file, ["walkthrough: long-title", "title: Long title", "steps:", "  - id: only-step", `    title: ${title}`].join("\n"));
    writeWalkthrough(config.walkthroughsDir, "fine");
    mockCaptureOnce(true);
    mockCaptureOnce(true);
    vi.mocked(buildVoiceManifest).mockResolvedValue({ id: "fine", manifestFile: "/tmp/f.json", report: { results: [], summary: { synthesized: 0, cached: 1, charsBilled: 0 } }, skipped: true });
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("fine", join(config.outDir, "pages")));
    vi.mocked(runQa).mockResolvedValue({ ok: true, target: "x", checks: [] });

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture", "voice", "pages", "qa"], json: false });

    // Still captured (others may need the data it leaves); no voice, page or QA run for it.
    expect(runCapture).toHaveBeenCalledTimes(2);
    expect(buildVoiceManifest).toHaveBeenCalledTimes(1);
    expect(buildPage).toHaveBeenCalledTimes(1);
    const w = result.walkthroughs.find((x) => x.walkthrough === "long-title")!;
    expect(w.ok).toBe(false);
    expect(w.stages.capture?.status).toBe("ok");
    expect(w.stages.voice?.status).toBe("skipped");
    expect(w.stages.pages?.status).toBe("skipped");
    expect(w.stages.qa?.status).toBe("failed");
    expect(w.failures).toHaveLength(1);
    const [f] = w.failures!;
    expect(f).toMatchObject({ stage: "qa", check: "captions:line-length", count: 1, files: [file] });
    expect(f.problems[0]).toContain("line 5");
    expect(f.problems[0]).toContain('step "only-step"');
    expect(f.problems[0]).toContain(title);
    // The other walkthrough builds as usual.
    const fine = result.walkthroughs.find((x) => x.walkthrough === "fine")!;
    expect(fine.ok).toBe(true);
    expect(fine.stages.pages?.status).toBe("ok");
  });

  it("runs QA on each path's clip next to the main video (M35)", async () => {
    const config = fakeConfig();
    writeFileSync(
      join(config.walkthroughsDir, "record-payment.yaml"),
      [
        "walkthrough: record-payment",
        'title: "Record a payment"',
        "start:",
        "  page: /bookings/12",
        "steps:",
        "  - id: only-step",
        '    title: "Do the thing"',
        "paths:",
        "  - id: from-attendee",
        '    title: "From the attendee\'s page"',
        '    when: "Use this when the attendee pays."',
        "    start:",
        "      page: /attendees/7",
        "    steps:",
        "      - id: open-attendee",
        '        title: "Open the attendee"',
        "    joins: only-step",
      ].join("\n"),
    );
    const captureDir = join(config.buildDir, "record-payment", "capture");
    mkdirSync(captureDir, { recursive: true });
    writeFileSync(join(captureDir, "manifest.json"), JSON.stringify(fakeManifest()));
    writeFileSync(join(captureDir, "validation.json"), JSON.stringify(fakeValidation(true)));
    const videoStepDir = join(config.outDir, "videos", "record-payment");
    mkdirSync(videoStepDir, { recursive: true });
    const clipFiles = ["record-payment.path-from-attendee.mp4", "record-payment.path-from-attendee.srt", "record-payment.path-from-attendee.vtt"];
    for (const f of ["record-payment.mp4", ...clipFiles, "path-from-attendee.timeline.json"]) writeFileSync(join(videoStepDir, f), "x");
    vi.mocked(buildPage).mockResolvedValueOnce(fakePageResult("record-payment", join(config.outDir, "pages")));
    vi.mocked(runQa).mockResolvedValue({ ok: true, target: "x", checks: [] });

    await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["pages", "qa"], json: false });

    const targets = vi.mocked(runQa).mock.calls.map((c) => c[0]);
    for (const f of clipFiles) expect(targets).toContain(join(videoStepDir, f));
    expect(targets).not.toContain(join(videoStepDir, "path-from-attendee.timeline.json"));
  });

  it("runs no text check when no selected stage uses the text (--only capture)", async () => {
    const config = fakeConfig();
    writeFileSync(join(config.walkthroughsDir, "long-title.yaml"), ["walkthrough: long-title", "title: Long title", "steps:", "  - id: only-step", `    title: ${"x".repeat(43)}`].join("\n"));
    mockCaptureOnce(true);
    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["capture"], json: false });
    expect(result.walkthroughs[0].ok).toBe(true);
    expect(result.walkthroughs[0].failures).toBeUndefined();
  });
});
