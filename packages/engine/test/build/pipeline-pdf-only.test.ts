// `aida build --only pdf` (no pages stage this run) renders PDFs from the pages an earlier build
// left on disk, instead of reporting OK and building nothing.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "../../src/config/index.js";
import type { BuildPageResult } from "../../src/pages/index.js";

vi.mock("../../src/pdf/index.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/pdf/index.js")>();
  return {
    ...mod,
    launchBrowser: vi.fn(async () => ({ close: vi.fn(async () => undefined) })),
    buildWalkthroughPdf: vi.fn(async (input: { id: string; publishable: boolean }, opts: { pdfDir: string }) => {
      const file = join(opts.pdfDir, `${input.id}.pdf`);
      const cardFile = join(opts.pdfDir, `${input.id}.card.pdf`);
      if (input.publishable) {
        // A real, loadable PDF, but untagged with no /Lang or Title — fails the `a11y:pdf` check
        // on purpose, so the review's deleted-orphan scenario (finding 9) can be driven end to
        // end through the real `runPdfA11yCheck`/`runQa`/`checkPdfAccessibility` chain, not mocked.
        mkdirSync(opts.pdfDir, { recursive: true });
        const bytes = await (await PDFDocument.create()).save();
        writeFileSync(file, bytes);
        writeFileSync(cardFile, bytes);
      }
      return { id: input.id, file, cardFile, skipped: false, excluded: !input.publishable };
    }),
    buildManualPdf: vi.fn(async () => ({ file: "manual.pdf", skipped: false, pageCount: 1, included: [] })),
  };
});

const { buildWalkthroughPdf, buildManualPdf } = await import("../../src/pdf/index.js");
const { runPipeline } = await import("../../src/build/pipeline.js");

const dirs: string[] = [];
afterEach(async () => {
  vi.mocked(buildWalkthroughPdf).mockClear();
  vi.mocked(buildManualPdf).mockClear();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function fakeConfig(): ResolvedConfig {
  const root = mkdtempSync(join(tmpdir(), "aida-pdf-only-test-"));
  dirs.push(root);
  const walkthroughsDir = join(root, "walkthroughs");
  mkdirSync(walkthroughsDir, { recursive: true });
  return {
    app: { baseUrl: "http://localhost:3000" },
    walkthroughsDir,
    outDir: join(root, "out"),
    buildDir: join(root, ".build"),
    configDir: root,
  } as ResolvedConfig;
}

function writeWalkthrough(config: ResolvedConfig, id: string): void {
  writeFileSync(
    join(config.walkthroughsDir, `${id}.yaml`),
    [`walkthrough: ${id}`, `title: "${id}"`, "steps:", "  - id: only-step", '    title: "Do the thing"'].join("\n"),
  );
}

/** Leaves what an earlier `aida build` would: the page on disk, its pages cache and (optionally) qa.json. */
function writeBuiltPage(config: ResolvedConfig, id: string, qaOk?: boolean): void {
  const outDir = join(config.outDir, "pages", id);
  mkdirSync(outDir, { recursive: true });
  const indexFile = join(outDir, "index.mdx");
  writeFileSync(indexFile, "---\ntitle: x\npassed: true\n---\n\nbody\n");
  writeFileSync(join(outDir, "index.plain.md"), "body\n");
  const result: BuildPageResult = {
    id,
    outDir,
    indexFile,
    plainFile: join(outDir, "index.plain.md"),
    screenshotsDir: join(outDir, "screenshots"),
    screenshots: [],
    passed: true,
    publishable: true,
    problems: [],
    suggestions: [],
  };
  mkdirSync(join(config.buildDir, id), { recursive: true });
  writeFileSync(join(config.buildDir, id, "pages-cache.json"), JSON.stringify({ hash: "x", result }));
  if (qaOk !== undefined) writeFileSync(join(config.buildDir, id, "qa.json"), JSON.stringify({ ok: qaOk, reports: [] }));
}

describe("aida build --only pdf", () => {
  it("renders the PDF from the page an earlier build left on disk", async () => {
    const config = fakeConfig();
    writeWalkthrough(config, "add-thing");
    writeBuiltPage(config, "add-thing", true);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["pdf"], json: false });

    expect(buildWalkthroughPdf).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildWalkthroughPdf).mock.calls[0][0]).toMatchObject({ id: "add-thing", publishable: true });
    expect(buildManualPdf).toHaveBeenCalledTimes(1);
    expect(result.walkthroughs[0].stages.pages?.status).toBe("not-selected");
    expect(result.walkthroughs[0].stages.pdf?.status).toBe("ok");
  });

  it("treats a page whose last QA failed as not publishable", async () => {
    const config = fakeConfig();
    writeWalkthrough(config, "failed-qa");
    writeBuiltPage(config, "failed-qa", false);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["pdf"], json: false });

    expect(vi.mocked(buildWalkthroughPdf).mock.calls[0][0]).toMatchObject({ id: "failed-qa", publishable: false });
    expect(result.walkthroughs[0].stages.pdf?.status).toBe("skipped");
  });

  it("says to run the pages stage when no page was ever built", async () => {
    const config = fakeConfig();
    writeWalkthrough(config, "never-built");

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["pdf"], json: false });

    expect(buildWalkthroughPdf).not.toHaveBeenCalled();
    expect(result.walkthroughs[0].stages.pdf).toMatchObject({ status: "skipped", detail: expect.stringContaining("pages stage") });
  });

  // Review finding 9 (build/pipeline.ts `runPdfA11yCheck`): a PDF that fails its own `a11y:pdf`
  // check must not survive as an orphan — it ships unlinked (the page it belongs to is now
  // unpublished) but was still staged into the help app's public/pdf before this fix.
  it("deletes <id>.pdf/<id>.card.pdf when the pdf a11y check fails, and never stages them", async () => {
    const config = fakeConfig();
    config.helpApp = join(mkdtempSync(join(tmpdir(), "aida-pdf-only-help-")), "help");
    dirs.push(config.helpApp);
    writeWalkthrough(config, "bad-a11y");
    writeBuiltPage(config, "bad-a11y", true);

    const result = await runPipeline(config, { configPath: "x", walkthroughIds: [], only: ["pdf"], json: false });

    const pdfDir = join(config.outDir, "pdf");
    expect(existsSync(join(pdfDir, "bad-a11y.pdf"))).toBe(false);
    expect(existsSync(join(pdfDir, "bad-a11y.card.pdf"))).toBe(false);
    expect(result.walkthroughs[0].stages.qa?.status).toBe("failed");
    expect(result.walkthroughs[0].stages.qa?.detail).toContain("check(s) failed");

    // Never reaches public/pdf (stagePdfsToHelpApp copies whatever is left in pdfDir).
    expect(existsSync(join(config.helpApp, "public", "pdf", "bad-a11y.pdf"))).toBe(false);

    // manual.pdf is built after this run's qa flip, so it already sees the walkthrough as
    // unpublishable (ordering: per-guide PDFs, then manual — build/pipeline.ts, pdf/build.ts).
    expect(vi.mocked(buildManualPdf).mock.calls[0][0]).toMatchObject([{ id: "bad-a11y", publishable: false }]);
  });
});
