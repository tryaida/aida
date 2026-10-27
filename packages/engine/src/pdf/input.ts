// Builds a `PdfPageInput` from a walkthrough + its already-built page (pages/build.ts's
// `BuildPageResult`) — the one place the pdf module reaches into pages' output shape, kept
// small and isolated so pages/pdf can keep evolving independently.
import { existsSync, readFileSync } from "node:fs";
import { libraryPlacement, type Walkthrough } from "../walkthrough/index.js";
import type { BuildPageResult } from "../pages/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { cardStepsFor } from "./html.js";
import { resolveArtifactBrand } from "../render/brand.js";
import type { PdfBrand, PdfPageInput } from "./types.js";

/** `config.brand` -> the PDFs' brand: `resolveArtifactBrand` (render/brand.ts — the one resolver
 * the videos use too), with logo paths resolved against the config dir. Same source the help
 * app's theme reads, so a PDF, a video and the site always match. Neutral look when unset. */
export function resolvePdfBrand(config: Pick<ResolvedConfig, "configDir" | "brand">): PdfBrand {
  return resolveArtifactBrand(config);
}

/** `index.plain.md` starts with the page's own YAML frontmatter fence (pages/content.ts
 * `buildFrontmatterBlock`) — useful as llms.txt's raw source, but not something a reader should
 * see rendered as prose in a PDF. Strips it; the PDF gets its own title/footer from `wf`/
 * `BuildPageResult` instead. */
function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function pdfInputFromPage(wf: Walkthrough, page: BuildPageResult): PdfPageInput {
  const markdown = stripFrontmatter(readFileSync(page.plainFile, "utf8"));
  const screenshotByStep = new Map<number, string>();
  for (const file of page.screenshots) {
    const m = /step-(\d+)\.png$/.exec(file);
    if (m) screenshotByStep.set(Number(m[1]), file);
  }
  const section = (wf as { section?: unknown }).section;
  const figures = page.printFigures?.filter((f) => existsSync(f.full) && (!f.crop || existsSync(f.crop)));
  const figureByStep = new Map((figures ?? []).map((f) => [f.step, f] as const));
  const pathFigures = Object.fromEntries(
    Object.entries(page.pathFigures ?? {})
      .map(([id, figs]) => [id, figs.filter((f) => existsSync(f.full) && (!f.crop || existsSync(f.crop)))] as const)
      .filter(([, figs]) => figs.length > 0),
  );
  return {
    id: wf.walkthrough,
    title: wf.title,
    product: wf.product,
    section: typeof section === "string" && section.trim() ? section.trim() : undefined,
    summary: wf.summary,
    for: wf.for,
    markdown,
    baseDir: page.outDir,
    lastChecked: page.lastChecked,
    passed: page.passed,
    publishable: page.publishable,
    cardSteps: cardStepsFor(wf, (n) => screenshotByStep.get(n)).map((s) => {
      const figure = figureByStep.get(s.number);
      return figure ? { ...s, figure } : s;
    }),
    ...(figures && figures.length > 0 ? { figures } : {}),
    ...(Object.keys(pathFigures).length > 0 ? { pathFigures } : {}),
    sitePath: libraryPlacement(typeof section === "string" ? section : undefined, wf.walkthrough).url,
  };
}

/**
 * Site-root-absolute URLs for a walkthrough's PDFs, for its page frontmatter's `pdf`/`pdfCard`
 * keys. Root-absolute (not relative to the page's own directory) because `stagePdfsToHelpApp`
 * (build/pipeline.ts) always copies `<outDir>/pdf/*` into `<helpApp>/public/pdf/`, and Next.js
 * serves everything under `public/` from the site root regardless of which page links to it.
 */
export function pdfPublicLinks(id: string): { pdf: string; pdfCard: string } {
  return { pdf: `/pdf/${id}.pdf`, pdfCard: `/pdf/${id}.card.pdf` };
}
