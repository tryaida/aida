import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Walkthrough } from "../../src/walkthrough/index.js";
import type { BuildPageResult } from "../../src/pages/index.js";
import { pdfInputFromPage, pdfPublicLinks } from "../../src/pdf/input.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

function wf(): Walkthrough {
  return { walkthrough: "add-thing", title: "Add a thing", for: "Office staff", steps: [{ id: "open", title: "Open", page_text: "Click it.", actions: [] }] };
}

describe("pdfInputFromPage", () => {
  it("strips the page's YAML frontmatter fence out of the Markdown fed to the PDF renderer", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aida-pdf-input-"));
    dirs.push(dir);
    const plainFile = path.join(dir, "index.plain.md");
    await writeFile(plainFile, '---\ntitle: "Add a thing"\npassed: true\n---\n\n# Add a thing\n\nDo the thing.\n');

    const page: BuildPageResult = {
      id: "add-thing",
      outDir: dir,
      indexFile: path.join(dir, "index.mdx"),
      plainFile,
      screenshotsDir: path.join(dir, "screenshots"),
      screenshots: [],
      passed: true,
      publishable: true,
      problems: [],
      suggestions: [],
    };

    const input = pdfInputFromPage(wf(), page);
    expect(input.markdown).not.toContain("---");
    expect(input.markdown).not.toContain("title:");
    expect(input.markdown.trim().startsWith("# Add a thing")).toBe(true);
  });
});

describe("pdfPublicLinks", () => {
  it("builds site-root-absolute /pdf/ URLs", () => {
    expect(pdfPublicLinks("add-thing")).toEqual({ pdf: "/pdf/add-thing.pdf", pdfCard: "/pdf/add-thing.card.pdf" });
  });
});

describe("resolvePdfBrand", () => {
  it("is the shared artifact brand: neutral without config.brand, resolved logo path with it", async () => {
    const { resolvePdfBrand } = await import("../../src/pdf/input.js");
    expect(resolvePdfBrand({ configDir: "/app" }).configured).toBe(false);
    const b = resolvePdfBrand({ configDir: "/app", brand: { primaryColor: "235 55% 42%", logo: "public/logo.png", font: "Inter" } });
    expect(b.logoPath).toBe("/app/public/logo.png");
    expect(b.colors?.primary).toBe("hsl(235 55% 42%)");
  });
});
