import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { buildManualPdf, buildWalkthroughPdf } from "../../src/pdf/build.js";
import { pdfInputHash, writeCacheSidecar } from "../../src/pdf/cache.js";
import type { PdfPageInput } from "../../src/pdf/types.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A Browser stand-in that throws if actually used — both tests below must resolve (excluded,
 * or cache-hit) before ever touching a browser, so a real Playwright launch isn't needed here. */
const unusableBrowser = {
  newPage: () => {
    throw new Error("buildWalkthroughPdf should not have opened a page for this case");
  },
} as unknown as Browser;

function input(overrides: Partial<PdfPageInput> = {}): PdfPageInput {
  return {
    id: "add-thing",
    title: "Add a thing",
    markdown: "# Add a thing\n\nDo the thing.\n",
    baseDir: "/tmp",
    passed: true,
    publishable: true,
    cardSteps: [],
    ...overrides,
  };
}

describe("buildWalkthroughPdf", () => {
  it("excludes a page that failed capture validation, touching no browser and no files", async () => {
    const pdfDir = await tmpDir("aida-pdf-build-");
    const result = await buildWalkthroughPdf(input({ passed: false, publishable: false }), { pdfDir, paper: "A4" }, unusableBrowser);
    expect(result.excluded).toBe(true);
    expect(result.skipped).toBe(false);
    expect(existsSync(result.file)).toBe(false);
    expect(existsSync(result.cardFile)).toBe(false);
  });

  it("excludes a page that isn't publishable even if it otherwise passed", async () => {
    const pdfDir = await tmpDir("aida-pdf-build-");
    const result = await buildWalkthroughPdf(input({ passed: true, publishable: false }), { pdfDir, paper: "A4" }, unusableBrowser);
    expect(result.excluded).toBe(true);
  });

  it("skips rendering when the cache already matches, touching no browser", async () => {
    const pdfDir = await tmpDir("aida-pdf-build-");
    const pageInput = input();

    // Fabricate the cache state a prior successful build would have left: the two output files
    // plus a sidecar hash matching this exact input (cache.test.ts proves pdfInputHash/
    // matchesCache's own logic — this just exercises buildWalkthroughPdf's use of them).
    const { pdfInputHash } = await import("../../src/pdf/cache.js");
    const file = path.join(pdfDir, `${pageInput.id}.pdf`);
    const card = path.join(pdfDir, `${pageInput.id}.card.pdf`);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(pdfDir, { recursive: true });
    writeFileSync(file, "fake-pdf");
    writeFileSync(card, "fake-pdf");
    const hash = pdfInputHash({ markdown: pageInput.markdown, screenshots: [], paper: "A4", brand: undefined, lastChecked: undefined });
    writeCacheSidecar(file, hash);
    writeCacheSidecar(card, hash);

    const result = await buildWalkthroughPdf(pageInput, { pdfDir, paper: "A4" }, unusableBrowser);
    expect(result.skipped).toBe(true);
    expect(result.excluded).toBe(false);
  });

  // Regression (review finding pdf/build.ts:45): an excluded (no-longer-publishable) page used to
  // leave its old <id>.pdf/<id>.card.pdf on disk, which stagePdfsToHelpApp would then copy into
  // the help app and buildManualPdf would reuse unconditionally.
  it("deletes a previously-built page's <id>.pdf/<id>.card.pdf once it's excluded", async () => {
    const pdfDir = await tmpDir("aida-pdf-build-");
    const pageInput = input();
    const file = path.join(pdfDir, `${pageInput.id}.pdf`);
    const card = path.join(pdfDir, `${pageInput.id}.card.pdf`);
    mkdirSync(pdfDir, { recursive: true });
    writeFileSync(file, "stale-pdf-from-a-passing-build");
    writeFileSync(card, "stale-card-from-a-passing-build");
    const hash = pdfInputHash({ markdown: pageInput.markdown, screenshots: [], paper: "A4", brand: undefined, lastChecked: undefined });
    writeCacheSidecar(file, hash);
    writeCacheSidecar(card, hash);

    const result = await buildWalkthroughPdf(input({ passed: false, publishable: false }), { pdfDir, paper: "A4" }, unusableBrowser);
    expect(result.excluded).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(card)).toBe(false);
    expect(existsSync(`${file}.hash`)).toBe(false);
  });
});

describe("buildManualPdf", () => {
  // Regression (review finding pdf/build.ts:147): buildManualPdf used to reuse any existing
  // <id>.pdf unconditionally, even when it was stale relative to the current page's own input
  // (markdown/screenshots/brand/lastChecked) — this proves it re-renders rather than reusing once
  // the sidecar hash no longer matches.
  it("re-renders a walkthrough's own page instead of reusing a stale <id>.pdf whose hash doesn't match", async () => {
    const pdfDir = await tmpDir("aida-pdf-manual-");
    const pageInput = input({ markdown: "# Add a thing\n\nDo the NEW thing.\n" });
    const file = path.join(pdfDir, `${pageInput.id}.pdf`);
    mkdirSync(pdfDir, { recursive: true });
    writeFileSync(file, "stale-pdf-bytes");
    // Sidecar hash for the OLD markdown, not the current `pageInput.markdown` above.
    const staleHash = pdfInputHash({ markdown: "# Add a thing\n\nDo the OLD thing.\n", screenshots: [], paper: "A4", brand: undefined });
    writeCacheSidecar(file, staleHash);

    let rendered = 0;
    const browser = {
      newPage: async () => {
        rendered++;
        throw new Error("stop before an actual Playwright render — just prove re-rendering was attempted");
      },
    } as unknown as Browser;

    await expect(buildManualPdf([pageInput], { pdfDir, paper: "A4" }, browser)).rejects.toThrow();
    expect(rendered).toBeGreaterThan(0);
  });
});
